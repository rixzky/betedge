"""Build API payloads (shapes in contract/api_types.ts) from artifact files.

No statistics and no data processing: rows are looked up, joined by key and passed through.
The only calculation is contract.decisions.decide_match, for the replay's per-outcome table
and for exploratory slider changes. Missing files or rows give nulls and a note in `x_notes`,
never invented values. Extra keys are prefixed `x_` (contract convention for extras).
"""
from __future__ import annotations

import math
from typing import Any, Optional

import numpy as np
import pandas as pd

from contract import decisions as D
from contract.schemas import (AGGREGATE_BOOKMAKERS, CONTRACT_VERSION, EXECUTION_EXCLUDE, MODEL_IDS,
                              REFERENCE_BOOKMAKER)

from . import files, gemini, storage

OUTCOMES = ("H", "D", "A")
# default model when no frozen config names one: the most developed model that has a prediction
MODEL_PREFERENCE = ["lgbm", "marketnet", "dixon_coles", "elo", "market"]
# policies the replay can show (naive is a comparison baseline in Evidence only)
REPLAY_POLICIES = ("controlled", "controlled_best_price")
DEFAULT_POLICY_ID = "controlled"
CLOSING_OR_RESULT_KEYS = {"closing_quote", "closing_fair_probs", "result", "home_goals", "away_goals",
                          "clv", "settled_pnl", "closing_fair_prob"}


class AppError(Exception):
    def __init__(self, status: int, detail: str):
        super().__init__(detail)
        self.status = status
        self.detail = detail


# ------------------------------------------------------------------ JSON helpers
def iso(value) -> Optional[str]:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    t = pd.Timestamp(value)
    t = t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")
    return t.isoformat().replace("+00:00", "Z")


def num(value, ndigits: Optional[int] = None) -> Optional[float]:
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return round(f, ndigits) if ndigits is not None else f


def clean(obj: Any) -> Any:
    """Make anything JSON-safe: NaN/inf -> null, numpy -> python, timestamps -> ISO Z."""
    if isinstance(obj, dict):
        return {str(k): clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, (pd.Timestamp, np.datetime64)):
        return iso(obj)
    if isinstance(obj, (bool, np.bool_)):
        return bool(obj)
    if isinstance(obj, (int, np.integer)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        return num(obj)
    if obj is None or isinstance(obj, str):
        return obj
    try:
        if pd.isna(obj):
            return None
    except (TypeError, ValueError):
        pass
    return obj


def _str_or_none(value) -> Optional[str]:
    if value is None:
        return None
    try:
        if pd.isna(value):
            return None
    except (TypeError, ValueError):
        pass
    return str(value)


# ------------------------------------------------------------------ shared lookups
def frozen_hash() -> Optional[str]:
    fc = files.frozen_config()
    return fc.get("config_hash") if fc else None


def check_policy_id(policy_id: Optional[str]) -> str:
    policy_id = policy_id or DEFAULT_POLICY_ID
    if policy_id not in REPLAY_POLICIES:
        raise AppError(422, f"policy_id must be one of {list(REPLAY_POLICIES)}")
    return policy_id


def policy_for(policy_id: str = DEFAULT_POLICY_ID) -> dict:
    """The policy decide_match uses: frozen settings after the freeze (with this policy's price
    source), contract.decisions.POLICIES[policy_id] before it."""
    base = dict(D.POLICIES[policy_id])
    fc = files.frozen_config()
    if fc and isinstance(fc.get("policy"), dict):
        return {**D.DEFAULT_POLICY, **fc["policy"], "price_source": base["price_source"]}
    return base


def _outlier_ids() -> set[str]:
    doc = files.jfile("data_audit.json") or {}
    return {str(o.get("quote_id")) for o in (doc.get("flagged_outliers") or []) if isinstance(o, dict)}


def available_models() -> list[str]:
    p = files.table("predictions")
    if p is None:
        return []
    present = set(p["model_id"].unique())
    return [m for m in MODEL_IDS if m in present]


def _match_row(match_id: str) -> pd.Series:
    m = files.table("matches")
    if m is None:
        raise AppError(503, "matches.parquet is missing or failed contract validation (see /api/health).")
    rows = m[m["match_id"] == match_id]
    if rows.empty:
        raise AppError(404, f"Unknown match_id: {match_id}")
    return rows.iloc[0]


def _is_holdout(season: str) -> bool:
    return files.splits_by_season().get(season) == "holdout" or season == files.holdout_season()


def _guard_holdout(match: pd.Series) -> None:
    if _is_holdout(match["season"]) and not files.is_holdout_locked():
        raise AppError(403, "Holdout-season matches stay hidden until holdout_locked.json exists "
                            "(CONTRACT section 8).")


def _match_view(match: pd.Series) -> dict:
    return {
        "match_id": match["match_id"], "league": match["league"], "season": match["season"],
        "kickoff_utc": iso(match["kickoff_utc"]), "home_team": match["home_team"],
        "away_team": match["away_team"], "split": files.splits_by_season().get(match["season"]),
    }


def _odds(q: dict) -> list:
    return [num(q.get("odds_home")), num(q.get("odds_draw")), num(q.get("odds_away"))]


def _quote_view(q: Optional[dict], bookmakers: Optional[list] = None) -> Optional[dict]:
    if q is None:
        return None
    view = {
        "quote_id": q["quote_id"], "bookmaker": q["bookmaker"], "snapshot": q["snapshot"],
        "observed_at_utc": iso(q.get("observed_at_utc")), "timestamp_precision": q["timestamp_precision"],
        "source": q.get("source"), "odds": _odds(q),
    }
    if bookmakers is not None:
        view["bookmakers"] = list(bookmakers)
    return view


def _market_probs(match_id: str, snapshot: str, notes: list[str]) -> Optional[list]:
    """Bet365 margin-free probabilities for one snapshot (CONTRACT 4.1: Bet365 is the benchmark)."""
    mp = files.table("market_probs")
    if mp is None:
        notes.append("market_probs.parquet is missing or invalid.")
        return None
    rows = mp[(mp["match_id"] == match_id) & (mp["snapshot"] == snapshot) & (mp["bookmaker"] == REFERENCE_BOOKMAKER)]
    if rows.empty:
        notes.append(f"No Bet365 {snapshot} market probabilities for this match.")
        return None
    if rows["is_reference"].any():
        rows = rows[rows["is_reference"]]
    r = rows.iloc[0]
    return [num(r["q_home"], 6), num(r["q_draw"], 6), num(r["q_away"], 6)]


def _pre_closing_rows(match_id: str) -> list[dict]:
    """One quotes row per bookmaker (latest observed first), PRE_CLOSING only."""
    seen, out = set(), []
    for q in storage.match_quotes(match_id, "PRE_CLOSING"):
        if q["bookmaker"] in seen:
            continue
        seen.add(q["bookmaker"])
        out.append(q)
    return out


def _decide_dict(q: dict, outliers: set[str]) -> dict:
    """quotes row -> the dict shape contract.decisions expects."""
    return {"quote_id": q["quote_id"], "bookmaker": q["bookmaker"], "odds": _odds(q),
            "is_valid": bool(q.get("is_valid")), "timestamp_precision": q.get("timestamp_precision"),
            "observed_at_utc": q.get("observed_at_utc"), "is_outlier": str(q["quote_id"]) in outliers}


def _executable(policy: dict, rows: list[dict], season: str, notes: list[str]) -> tuple[Optional[dict], Optional[dict]]:
    """(quote for decide_match, QuoteView) built ONLY with contract.decisions helpers."""
    outliers = _outlier_ids()
    qs = [_decide_dict(r, outliers) for r in rows]
    if not qs:
        notes.append("No pre-closing quotes for this match.")
        return None, None
    by_id = {r["quote_id"]: r for r in rows}
    if policy.get("price_source") == "BEST_AVAILABLE":
        q = D.best_price_quote(qs, season, max_prob_gap=policy.get("best_price_max_prob_gap",
                                                                    D.DEFAULT_POLICY["best_price_max_prob_gap"]))
        if q is None:
            notes.append("No valid Bet365 pre-closing quote, so no best price can be built (Bet365 is the benchmark).")
            return None, None
        ref = next((r for r in rows if r["bookmaker"] == REFERENCE_BOOKMAKER), {})
        view = {"quote_id": q["quote_id"], "bookmaker": "BEST", "snapshot": "PRE_CLOSING",
                "observed_at_utc": iso(q.get("observed_at_utc")), "timestamp_precision": q["timestamp_precision"],
                "source": ref.get("source"), "odds": [num(x) for x in q["odds"]], "bookmakers": list(q["bookmakers"])}
        return q, view
    q = D.reference_quote(qs)
    if q is None:
        notes.append("No Bet365 pre-closing quote for this match (Bet365 is the reference bookmaker).")
        return None, None
    if not q.get("is_valid"):
        notes.append("The Bet365 pre-closing quote failed validation.")
    return q, _quote_view(by_id[q["quote_id"]], q["bookmakers"])


def _quote_board(rows: list[dict], season: str) -> list[dict]:
    """Every bookmaker's pre-closing quote as stored, with the contract's eligibility flags."""
    outliers = _outlier_ids()
    excluded = set(EXECUTION_EXCLUDE.get(season, []))
    board = []
    for r in rows:
        bm = r["bookmaker"]
        board.append({**_quote_view(r), "is_valid": bool(r.get("is_valid")),
                      "invalid_reason": _str_or_none(r.get("invalid_reason")),
                      "is_reference": bm == REFERENCE_BOOKMAKER,
                      "is_aggregate": bm in AGGREGATE_BOOKMAKERS,
                      "is_excluded_this_season": bm in excluded,
                      "is_outlier": str(r["quote_id"]) in outliers})
    order = {b: i for i, b in enumerate([REFERENCE_BOOKMAKER, "PS", "BW", "IW", "WH", "VC", "MAX", "AVG"])}
    return sorted(board, key=lambda b: (order.get(b["bookmaker"], 50), b["bookmaker"]))


def _resolve_model(match_id: str, requested: Optional[str]) -> tuple[Optional[str], Optional[pd.Series]]:
    """(model_id, prediction row). A requested model with no prediction returns (model_id, None)."""
    p = files.table("predictions")
    rows = p[p["match_id"] == match_id] if p is not None else None
    fc = files.frozen_config() or {}
    if requested:
        model_id = requested
    else:
        have = set(rows["model_id"]) if rows is not None else set()
        if fc.get("model_id") in have:
            model_id = fc["model_id"]
        else:
            model_id = next((m for m in MODEL_PREFERENCE if m in have), None)
            if model_id is None:
                model_id = fc.get("model_id") or (available_models() or [None])[0]
    if rows is None or model_id is None:
        return model_id, None
    mine = rows[rows["model_id"] == model_id]
    if mine.empty:
        return model_id, None
    if len(mine) > 1 and fc.get("model_id") == model_id and fc.get("model_version") in set(mine["model_version"]):
        mine = mine[mine["model_version"] == fc["model_version"]]
    return model_id, mine.iloc[-1]


def _ledger_row(match_id: str, model_id: Optional[str], split: Optional[str],
                policy_id: str = DEFAULT_POLICY_ID) -> Optional[pd.Series]:
    d = files.table("decisions")
    if d is None or model_id is None:
        return None
    rows = d[(d["match_id"] == match_id) & (d["model_id"] == model_id)
             & (d["policy_id"] == policy_id) & (~d["is_exploratory"])]
    if rows.empty:
        return None
    if split == "holdout" and (rows["run_id"] == "holdout_locked").any():
        rows = rows[rows["run_id"] == "holdout_locked"]
    fh = frozen_hash()
    if fh and (rows["config_hash"] == fh).any():
        rows = rows[rows["config_hash"] == fh]
    return rows.iloc[-1]


def _r6_row(row: dict) -> dict:
    return {k: (num(v, 6) if isinstance(v, (float, np.floating)) else v) for k, v in row.items()}


# ------------------------------------------------------------------ endpoints
def build_meta() -> dict:
    man = files.manifest()
    return {
        "contract_version": CONTRACT_VERSION,
        "dataset_mode": files.dataset_mode(),
        "storage_backend": storage.active_backend(),
        "gemini_enabled": gemini.is_enabled(),
        "leagues": list(man.get("leagues") or []),
        "seasons": list(man.get("seasons") or []),
        "models": available_models(),
        "frozen_config_hash": frozen_hash(),
        "holdout_locked": files.is_holdout_locked(),
        "x_reference_bookmaker": REFERENCE_BOOKMAKER,
        "x_replay_policies": list(REPLAY_POLICIES),
        "x_policies": {pid: policy_for(pid) for pid in REPLAY_POLICIES},
        "x_execution_exclude": EXECUTION_EXCLUDE,
    }


def build_efficiency_map() -> dict:
    eff = files.table("efficiency_map")
    rows: list[dict] = []
    if eff is not None:
        df = eff
        if not files.is_holdout_locked():
            df = df[df["season"] != files.holdout_season()]
        df = df.sort_values(["league", "season", "snapshot", "bookmaker"])
        cols = ["league", "season", "snapshot", "bookmaker", "n_matches", "log_loss", "brier",
                "mean_overround", "calib_slope", "fav_longshot_gap", "draw_bias"]
        rows = clean(df[cols].to_dict(orient="records"))
    return {
        "dataset_mode": files.dataset_mode(),
        "sign_conventions": files.golden_api("efficiency_map")["sign_conventions"],
        "rows": rows,
    }


def build_fixtures(league: Optional[str], season: Optional[str]) -> list[dict]:
    m = files.table("matches")
    if m is None:
        return []
    df = m
    if league:
        df = df[df["league"] == league]
    if season:
        df = df[df["season"] == season]
    if not files.is_holdout_locked():
        df = df[df["season"] != files.holdout_season()]
    mp = files.table("market_probs")
    closing = set()
    if mp is not None:
        closing = set(mp.loc[(mp["snapshot"] == "CLOSING") & (mp["bookmaker"] == REFERENCE_BOOKMAKER), "match_id"])
    splits = files.splits_by_season()
    df = df.sort_values(["kickoff_utc", "match_id"])
    return [
        {"match_id": r.match_id, "league": r.league, "season": r.season, "kickoff_utc": iso(r.kickoff_utc),
         "home_team": r.home_team, "away_team": r.away_team, "split": splits.get(r.season),
         "has_closing": r.match_id in closing}
        for r in df.itertuples(index=False)
    ]


def build_replay(match_id: str, model_id: Optional[str] = None, overrides: Optional[dict] = None,
                 policy_id: Optional[str] = None) -> dict:
    policy_id = check_policy_id(policy_id)
    overrides = {k: v for k, v in (overrides or {}).items() if v is not None}
    exploratory = bool(overrides)
    notes: list[str] = []
    match = _match_row(match_id)
    _guard_holdout(match)
    split = files.splits_by_season().get(match["season"])

    policy = {**policy_for(policy_id), **overrides}
    rows = _pre_closing_rows(match_id)
    quote, quote_view = _executable(policy, rows, match["season"], notes)
    market_probs = _market_probs(match_id, "PRE_CLOSING", notes)

    model_id, pred = _resolve_model(match_id, model_id)
    probs = None
    model = None
    if pred is not None:
        probs = [float(pred["p_home"]), float(pred["p_draw"]), float(pred["p_away"])]
        model = {"model_id": model_id, "model_version": pred["model_version"], "probs": [num(x, 6) for x in probs]}
    elif model_id:
        notes.append(f"No prediction from model '{model_id}' for this match.")
    else:
        notes.append("predictions.parquet is missing or has no rows for this match.")

    d = D.decide_match(probs, quote, match["kickoff_utc"], policy)

    ledger = None if exploratory else _ledger_row(match_id, model_id, split, policy_id)
    if ledger is not None:
        source = "ledger"
        codes = str(ledger["reason_codes_all"]).split("|") if _str_or_none(ledger["reason_codes_all"]) else []
        decision = {
            "action": ledger["action"], "selection": _str_or_none(ledger["selection"]),
            "stake": num(ledger["stake"]), "bookmaker": _str_or_none(ledger.get("bookmaker")),
            "reason_code": ledger["reason_code"], "reason_codes_all": codes or [ledger["reason_code"]],
            "explanation": ledger["explanation"],
        }
    else:
        source = "live"
        decision = {
            "action": d["action"], "selection": d["selection"], "stake": num(d["proposed_stake"]),
            "bookmaker": d.get("bookmaker"), "reason_code": d["reason_code"],
            "reason_codes_all": list(d["reason_codes_all"]), "explanation": d["explanation"],
        }
        if exploratory:
            notes.append("Exploratory: recomputed with decide_match using your slider values. Nothing was written, "
                         "and batch exposure caps (CONTRACT 6.3) are not applied.")
        else:
            notes.append("No ledger row for this match, model and policy yet: decision computed live with "
                         "decide_match; batch exposure caps (CONTRACT 6.3) are not applied.")

    top = []
    expl = files.table("prediction_explanations")
    if expl is not None and model is not None:
        e = expl[(expl["match_id"] == match_id) & (expl["model_id"] == model_id)
                 & (expl["model_version"] == model["model_version"])]
        e = e.assign(_o=e["outcome"].map({"H": 0, "D": 1, "A": 2})).sort_values(["_o", "rank"])
        top = [{"outcome": r.outcome, "rank": int(r.rank), "feature": r.feature,
                "feature_value": num(r.feature_value, 6), "contribution": num(r.contribution, 6)}
               for r in e.itertuples(index=False)]

    config_hash = frozen_hash() or (str(ledger["config_hash"]) if ledger is not None else None) or "not-frozen"
    payload = {
        "dataset_mode": files.dataset_mode(),
        "is_exploratory": exploratory,
        "config_hash": config_hash,
        "policy_id": policy_id,
        "price_source": d["policy"]["price_source"],
        "match": _match_view(match),
        "information_cutoff_utc": iso(match["feature_cutoff_utc"]),
        "offered_quote": quote_view,
        "market_probs": market_probs,
        "model": model,
        "per_outcome": [_r6_row(r) for r in d["per_outcome"]],
        "decision": decision,
        "top_features": top,
        "config_used": dict(d["policy"]),
        "x_decision_source": source,
        "x_quote_is_valid": None if quote is None else bool(quote.get("is_valid")),
        "x_quote_board": _quote_board(rows, match["season"]),
        "x_notes": notes,
    }
    return clean(payload)


def build_reveal(match_id: str, model_id: Optional[str] = None, policy_id: Optional[str] = None) -> dict:
    policy_id = check_policy_id(policy_id)
    notes: list[str] = []
    match = _match_row(match_id)
    _guard_holdout(match)
    split = files.splits_by_season().get(match["season"])
    closing = storage.find_quote(match_id, REFERENCE_BOOKMAKER, "CLOSING")
    closing_probs = _market_probs(match_id, "CLOSING", notes) if closing is not None else None
    if closing is None:
        notes.append("No Bet365 closing quote for this match, so CLV cannot be computed.")
    out = files.table("outcomes")
    if out is None:
        raise AppError(503, "outcomes.parquet is missing or failed contract validation.")
    res = out[out["match_id"] == match_id]
    if res.empty:
        raise AppError(404, "No result for this match in outcomes.parquet yet.")
    res = res.iloc[0]
    model_id, _ = _resolve_model(match_id, model_id)
    ledger = _ledger_row(match_id, model_id, split, policy_id)
    clv = pnl = None
    if ledger is not None and ledger["action"] == "BET":
        clv, pnl = num(ledger["clv"], 6), num(ledger["settled_pnl"], 6)
    elif ledger is None:
        notes.append("No ledger row for this match, model and policy, so CLV and paper P&L are not available.")
    return clean({
        "match_id": match_id,
        "closing_quote": _quote_view(closing),
        "closing_fair_probs": closing_probs,
        "result": {"home_goals": int(res["home_goals"]), "away_goals": int(res["away_goals"]),
                   "result": res["result"]},
        "clv": clv,
        "settled_pnl": pnl,
        "x_model_id": model_id,
        "x_policy_id": policy_id,
        "x_notes": notes,
    })


def _limitations(split: str, policies_present: bool) -> list[str]:
    lim: list[str] = []
    if files.dataset_mode() == "SYNTHETIC":
        lim.append("Synthetic demonstration data: invented teams and prices. These numbers are not results.")
    for src in files.manifest().get("sources") or []:
        if isinstance(src, dict) and src.get("limitations"):
            lim.append(f"{src.get('name', 'Source')}: {src['limitations']}")
    lim += [
        "Decisions use pre-closing quotes; Bet365 is the probability benchmark and the CLV benchmark "
        "(Bet365 closing), and CLV exists only where a Bet365 closing quote exists.",
        "Best-of-many prices are biased upwards by stale or wrong quotes, so the best-price policy and the "
        "line-shopping value flatter what could really have been executed.",
        "The probability stress is a sensitivity assumption, not a confidence interval.",
        "Forecast metrics compare every model on the same matches within the split.",
    ]
    if not policies_present:
        lim.append("No policy metrics for this model and split yet.")
    if split != "holdout":
        lim.append("Validation results guide choices; only the locked holdout is an out-of-sample test.")
    return lim


def build_evidence(model_id: Optional[str] = None, split: Optional[str] = None) -> dict:
    split = split or "validation"
    notes: list[str] = []
    fi_doc = files.jfile("feature_importance.json") or {}
    fi_rows = [r for r in (fi_doc.get("rows") or []) if isinstance(r, dict)]
    fm_doc = files.jfile("forecast_metrics.json") or {}
    pm_doc = files.jfile("policy_metrics.json") or {}
    pm_rows = [r for r in (pm_doc.get("rows") or []) if isinstance(r, dict)]
    fc = files.frozen_config() or {}
    payload: dict = {"dataset_mode": files.dataset_mode(), "split": split, "is_locked_holdout": False}

    if split == "holdout":
        hl = files.holdout_locked()
        if hl is None:
            notes.append("The holdout is locked away until the freeze; nothing from it is shown yet.")
            payload.update(model_id=model_id or fc.get("model_id") or "", forecast=[], policies=[], equity_curve=[],
                           x_line_shopping=None)
        else:
            payload.update(
                model_id=hl.get("model_id") or "", is_locked_holdout=True,
                forecast=hl.get("forecast") or [], policies=hl.get("policies") or [],
                equity_curve=hl.get("equity_curve") or [],
                x_config_hash=hl.get("config_hash"), x_locked_at_utc=hl.get("locked_at_utc"),
                x_model_version=hl.get("model_version"), x_line_shopping=hl.get("line_shopping"),
            )
            if model_id and model_id != hl.get("model_id"):
                notes.append(f"The locked holdout covers the frozen model ({hl.get('model_id')}) only.")
        # No holdout-derived information is released before the locked artifact exists.
        fi = ([r for r in fi_rows if r.get("split") == "holdout"]
              or [r for r in fi_rows if r.get("split") == "validation"]) if hl is not None else []
    else:
        forecast = [r for r in (fm_doc.get("rows") or []) if isinstance(r, dict) and r.get("split") == split]
        # Forecasts arrive before the decisions ledger and policy metrics. Keep all
        # forecast models selectable during that hand-off; never fabricate returns.
        models_here = {r.get("model_id") for r in forecast}
        models_here.update(r.get("model_id") for r in pm_rows if r.get("split") == split)
        if not model_id:
            model_id = fc.get("model_id") if fc.get("model_id") in models_here else \
                next((m for m in MODEL_PREFERENCE if m in models_here), None)
        prow = next((r for r in pm_rows if r.get("model_id") == model_id and r.get("split") == split), None)
        payload.update(
            model_id=model_id or "", forecast=forecast,
            policies=(prow or {}).get("policies") or [], equity_curve=(prow or {}).get("equity_curve") or [],
            x_line_shopping=(prow or {}).get("line_shopping"),
        )
        if not forecast:
            notes.append("forecast_metrics.json has no rows for this split yet.")
        fi = [r for r in fi_rows if r.get("split") == split]

    payload["feature_importance"] = fi
    payload["limitations"] = _limitations(split, bool(payload["policies"]))
    payload["x_models"] = sorted({r.get("model_id") for r in [*pm_rows, *(fm_doc.get("rows") or [])]
                                 if isinstance(r, dict) and r.get("split") == split and r.get("model_id")}
                                 if split != "holdout" else ({payload["model_id"]} if payload.get("is_locked_holdout") else set()),
                                 key=lambda m: MODEL_IDS.index(m) if m in MODEL_IDS else 99)
    payload["x_brier_convention"] = fm_doc.get("brier_convention") or "sum over 3 outcomes, range 0 to 2"
    payload["x_policy_note"] = pm_doc.get("note")
    if payload.get("x_line_shopping") is None and payload["policies"]:
        notes.append("No line_shopping value in policy_metrics.json for this model and split yet (Part 2 adds it).")
    payload["x_notes"] = notes
    return clean(payload)


def build_audit() -> dict:
    doc = files.jfile("data_audit.json")
    if doc is None:
        return {
            "dataset_mode": files.dataset_mode(), "raw_counts": {}, "accepted_counts": {},
            "invalid_quotes_by_reason": {}, "timestamp_precision_counts": {}, "duplicates_removed": None,
            "missing_value_counts": {}, "flagged_outliers": [], "exclusions": [],
            "note": "data_audit.json not found yet (Part 1 produces it).",
        }
    return clean(doc)


def build_scenarios() -> dict:
    return files.golden_api("scenarios")


def build_explain(match_id: str, model_id: Optional[str], overrides: Optional[dict],
                  policy_id: Optional[str] = None) -> dict:
    replay = build_replay(match_id, model_id, overrides, policy_id)
    m = replay["match"]
    record = {
        "match": f"{m['home_team']} v {m['away_team']} ({m['league']} {m['season']})",
        "decision": replay["decision"],
        "price_source": replay["price_source"],
        "is_exploratory": replay["is_exploratory"],
        "dataset_mode": replay["dataset_mode"],
    }
    return gemini.explain(record, [m["home_team"], m["away_team"]])


def build_health() -> dict:
    return {
        "contract_version": CONTRACT_VERSION,
        "reading_from": files.source_label(),
        "dataset_mode": files.dataset_mode(),
        "holdout_locked": files.is_holdout_locked(),
        "storage": storage.status(),
        "gemini": gemini.status(),
        "files": files.file_status(),
    }

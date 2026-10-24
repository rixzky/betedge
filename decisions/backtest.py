"""Deterministic settlement, batching, and exposure accounting for Part 1."""
from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from typing import Any

import pandas as pd

from contract import decisions as D
from contract import maths as M
from contract import schemas as S


def config_hash(config: dict) -> str:
    raw = json.dumps(config, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:12]


def select_reference_quote(quotes: pd.DataFrame, match_id: str, snapshot: str) -> dict | None:
    """Return the Bet365 reference quote without fallback substitution."""
    subset = quotes[(quotes.match_id == match_id) & (quotes.snapshot == snapshot)]
    if subset.empty:
        return None
    group = subset[subset.bookmaker == S.REFERENCE_BOOKMAKER]
    if len(group) > 1:
        raise ValueError(f"Multiple {S.REFERENCE_BOOKMAKER} {snapshot} quotes for {match_id}")
    if group.empty:
        return None
    row = group.iloc[0]
    ref = {"quote_id": str(row.quote_id), "bookmaker": str(row.bookmaker),
           "odds": [row.odds_home, row.odds_draw, row.odds_away], "is_valid": bool(row.is_valid),
           "timestamp_precision": str(row.timestamp_precision), "observed_at_utc": row.observed_at_utc}
    return D.reference_quote([ref])


def _market_close_probs(market_probs: pd.DataFrame) -> dict[str, list[float]]:
    if market_probs.empty:
        return {}
    refs = market_probs[(market_probs.snapshot == "CLOSING") & market_probs.is_reference]
    return {str(row.match_id): [row.q_home, row.q_draw, row.q_away]
            for row in refs.itertuples(index=False)}


def _settle_position(position: dict, outcomes: dict[str, str], ledger: list[dict], settled_balance: float) -> float:
    result = outcomes.get(position["match_id"])
    if result is None:
        return settled_balance
    pnl = position["stake"] * (position["odds"] - 1.0) if result == position["selection"] else -position["stake"]
    row = ledger[position["ledger_index"]]
    row["settled_pnl"] = float(pnl)
    return settled_balance + pnl


def _decision_template_for_sizing_rejection(code: str, action: dict) -> str:
    if code == "EXPOSURE_LIMIT_TOTAL":
        return "No bet: total open stakes would exceed the portfolio exposure cap."
    if code == "INSUFFICIENT_BANKROLL":
        return "No bet: settled bankroll does not cover the proposed stake."
    if code == "EXPOSURE_LIMIT_MATCH":
        return "No bet: the per-match limit allows no stake."
    return str(action["explanation"])


def run_backtest(
    matches: pd.DataFrame,
    outcomes: pd.DataFrame,
    quotes: pd.DataFrame,
    market_probs: pd.DataFrame,
    predictions: pd.DataFrame,
    *,
    split: str,
    models: list[str],
    run_id: str | None = None,
    policy_overrides: dict[str, dict] | None = None,
    outlier_quote_ids: set[str] | None = None,
) -> pd.DataFrame:
    """Create all contract policy decisions for every match/model in a split."""
    if split not in S.SPLITS:
        raise ValueError(f"Unknown split {split}")
    missing_models = sorted(set(models) - set(S.MODEL_IDS))
    if missing_models:
        raise ValueError(f"Unknown model id(s): {missing_models}")
    overrides = policy_overrides or {}
    split_years = {season: "warmup" if 2005 <= int(season[:4]) <= 2009 else
                   "train" if 2010 <= int(season[:4]) <= 2022 else
                   "calibration" if int(season[:4]) == 2023 else
                   "validation" if int(season[:4]) == 2024 else
                   "holdout" if int(season[:4]) == 2025 else "out_of_scope"
                   for season in matches.season.astype(str).unique()}
    split_matches = matches[matches.season.map(split_years).eq(split)].copy()
    if split_matches.empty:
        raise ValueError(f"No matches in split {split}")
    split_predictions = predictions[predictions.split.eq(split) & predictions.model_id.isin(models)].copy()
    versions = {}
    for model in models:
        values = sorted(split_predictions.loc[split_predictions.model_id.eq(model), "model_version"].dropna().astype(str).unique())
        if len(values) > 1:
            raise ValueError(f"More than one {model} model_version in {split}: {values}; select one before backtesting")
        versions[model] = values[0] if values else "missing"
    prediction_index = split_predictions.set_index(["match_id", "model_id"]) if not split_predictions.empty else None
    quote_lookup: dict[tuple[str, str], list[dict]] = {}
    outlier_ids = outlier_quote_ids or set()
    for match_id in split_matches.match_id.astype(str):
        subset = quotes[(quotes.match_id == match_id) & (quotes.snapshot == "PRE_CLOSING")]
        quote_lookup[(match_id, "PRE_CLOSING")] = [{
            "quote_id": str(row.quote_id), "bookmaker": str(row.bookmaker),
            "odds": [row.odds_home, row.odds_draw, row.odds_away],
            "is_valid": bool(row.is_valid), "is_outlier": str(row.quote_id) in outlier_ids,
            "timestamp_precision": str(row.timestamp_precision), "observed_at_utc": row.observed_at_utc,
        } for row in subset.itertuples(index=False)]
    close_probs = _market_close_probs(market_probs)
    outcome_index = dict(zip(outcomes.match_id.astype(str), outcomes.result.astype(str)))
    settle_by = dict(zip(matches.match_id.astype(str), matches.kickoff_utc.dt.floor("D") + pd.Timedelta(days=1)))

    ledger: list[dict] = []
    job_run_id = run_id or f"part1_{split}"
    policy_specs = list(D.POLICIES.items())
    for model_id in models:
        for policy_id, base_policy in policy_specs:
            override_key = "controlled" if policy_id == "controlled_best_price" else policy_id
            policy = {**base_policy, **overrides.get(override_key, {}), **overrides.get(policy_id, {})}
            if policy_id == "controlled_best_price":
                policy["price_source"] = "BEST_AVAILABLE"
            policy_id_hash = config_hash(policy)
            settled_bankroll = float(policy["initial_bankroll"])
            open_positions: list[dict] = []
            model_entries = []
            for fixture in split_matches.itertuples(index=False):
                match_id = str(fixture.match_id)
                prediction = None
                if prediction_index is not None and (match_id, model_id) in prediction_index.index:
                    p_row = prediction_index.loc[(match_id, model_id)]
                    if isinstance(p_row, pd.DataFrame):
                        raise ValueError(f"Duplicate prediction for {match_id}/{model_id}")
                    prediction = [float(p_row.p_home), float(p_row.p_draw), float(p_row.p_away)]
                quote = quote_lookup[(match_id, "PRE_CLOSING")]
                decision_time = fixture.feature_cutoff_utc
                model_entries.append({
                    "fixture": fixture, "prediction": prediction, "quotes": quote, "policy_id": policy_id,
                    "model_id": model_id, "decision_time": decision_time,
                    "config_hash": policy_id_hash,
                })

            batches: dict[pd.Timestamp, list[dict]] = defaultdict(list)
            for entry in model_entries:
                batch_date = entry["decision_time"].floor("D")
                batches[batch_date].append(entry)

            for batch_date in sorted(batches):
                still_open = []
                for position in sorted(open_positions, key=lambda x: (x["settle_at"], x["match_id"])):
                    if position["settle_at"] <= batch_date:
                        settled_bankroll = _settle_position(position, outcome_index, ledger, settled_bankroll)
                    else:
                        still_open.append(position)
                open_positions = still_open
                settled_at_batch_start = settled_bankroll
                available = max(0.0, settled_bankroll - sum(x["stake"] for x in open_positions))
                exposure_ceiling = float(policy["max_open_exposure_frac"]) * settled_at_batch_start
                # All choices in a decision-date batch see the same settled balance.
                batch = []
                for entry in batches[batch_date]:
                    fixture = entry["fixture"]
                    if policy_id == "controlled_best_price":
                        quote = D.best_price_quote(entry["quotes"], str(fixture.season), policy["best_price_max_prob_gap"])
                        if quote is None:
                            quote = D.reference_quote(entry["quotes"])
                    else:
                        quote = D.reference_quote(entry["quotes"])
                    entry["quote"] = quote
                    entry["decision"] = D.decide_match(
                        entry["prediction"], quote, fixture.kickoff_utc, policy,
                        available_bankroll=available,
                    )
                    batch.append(entry)
                batch.sort(key=lambda x: (
                    -(x["decision"].get("ev_stressed") if x["decision"].get("ev_stressed") is not None else float("-inf")),
                    str(x["fixture"].match_id),
                ))
                for entry in batch:
                    fixture, decision = entry["fixture"], entry["decision"]
                    stake = float(decision["proposed_stake"])
                    reason_code = str(decision["reason_code"])
                    action = str(decision["action"])
                    selection = decision.get("selection")
                    explanation = str(decision["explanation"])
                    all_reason_codes = list(decision["reason_codes_all"])
                    if action == "BET":
                        if stake > available + 1e-9:
                            reason_code, action, selection, stake = "INSUFFICIENT_BANKROLL", "NO_BET", None, 0.0
                            explanation = D.explain({**decision, "reason_code": reason_code,
                                                     "selection": None, "proposed_stake": 0.0})
                        elif sum(x["stake"] for x in open_positions) + stake > exposure_ceiling + 1e-9:
                            reason_code, action, selection, stake = "EXPOSURE_LIMIT_TOTAL", "NO_BET", None, 0.0
                            explanation = D.explain({**decision, "reason_code": reason_code,
                                                     "selection": None, "proposed_stake": 0.0})
                        if action == "NO_BET":
                            all_reason_codes = [reason_code if code == "ACCEPTED" else code for code in all_reason_codes]

                    record = {
                        "decision_id": f"{job_run_id}-{policy_id}-{model_id}-{fixture.match_id}",
                        "run_id": job_run_id, "policy_id": policy_id, "match_id": fixture.match_id,
                        "model_id": model_id, "split": split, "decision_time_utc": entry["decision_time"],
                        "batch_key": batch_date.isoformat().replace("+00:00", "Z"),
                        "quote_id": decision.get("quote_id"), "action": action, "selection": selection,
                        "bookmaker": decision.get("bookmaker") if action == "BET" else None,
                        "p_model": decision.get("p_model"), "p_stressed": decision.get("p_stressed"),
                        "odds_offered": decision.get("odds_offered"), "odds_adjusted": decision.get("odds_adjusted"),
                        "ev_raw": decision.get("ev_raw"), "ev_stressed": decision.get("ev_stressed"),
                        "stake": float(round(stake, 6)), "reason_code": reason_code,
                        "reason_codes_all": "|".join(all_reason_codes),
                        "explanation": explanation, "settled_pnl": None,
                        "closing_fair_prob": None, "clv": None, "config_hash": entry["config_hash"],
                        "is_exploratory": False,
                    }
                    ledger.append(record)
                    ledger_index = len(ledger) - 1
                    if action == "BET":
                        available -= stake
                        close = close_probs.get(str(fixture.match_id))
                        if close is not None and selection in M.OUTCOMES:
                            outcome_index_k = M.OUTCOMES.index(selection)
                            record["closing_fair_prob"] = float(close[outcome_index_k])
                            record["clv"] = float(M.clv(float(record["odds_offered"]), float(close[outcome_index_k])))
                        open_positions.append({
                            "ledger_index": ledger_index, "match_id": str(fixture.match_id),
                            "selection": selection, "stake": stake, "odds": float(record["odds_offered"]),
                            "settle_at": settle_by[str(fixture.match_id)],
                        })

            # The split is closed at this point; settle recorded results without reusing them.
            for position in sorted(open_positions, key=lambda x: (x["settle_at"], x["match_id"])):
                settled_bankroll = _settle_position(position, outcome_index, ledger, settled_bankroll)

    result = pd.DataFrame(ledger, columns=list(S.SCHEMAS["decisions"]))
    for col in ("decision_id", "run_id", "policy_id", "match_id", "model_id", "split", "batch_key",
                "action", "selection", "reason_code", "reason_codes_all", "explanation", "config_hash"):
        result[col] = result[col].astype("string")
    # Keep the entirely nullable execution-book column as object so contract
    # validation handles the legitimate all-NO_BET case across pandas versions.
    result["bookmaker"] = result["bookmaker"].astype(object)
    result["quote_id"] = result["quote_id"].astype(object)
    result["decision_time_utc"] = pd.to_datetime(result["decision_time_utc"], utc=True)
    for col in ("p_model", "p_stressed", "odds_offered", "odds_adjusted", "ev_raw", "ev_stressed", "stake",
                "settled_pnl", "closing_fair_prob", "clv"):
        result[col] = pd.to_numeric(result[col], errors="coerce").astype(float)
    result["is_exploratory"] = result["is_exploratory"].astype(bool)
    S.validate("decisions", result)
    return result

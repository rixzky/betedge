"""Build validated, leakage-aware Part 1 tables from local Football-Data CSVs."""
from __future__ import annotations

import argparse
import csv
import difflib
import json
import os
import re
import sys
import tempfile
from collections import Counter, defaultdict
from datetime import datetime, time, timezone
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression

from contract import maths as M
from contract import schemas as S
from data_pipeline.download import download_archives, parse_seasons

TZ = ZoneInfo("Europe/London")
SOURCE = "https://www.football-data.co.uk"
NOTES = "https://www.football-data.co.uk/notes.txt"
FAIR_USE = "https://www.football-data.co.uk/contact.php"
CURRENT_LEAGUES = ["E0", "E1", "SP1", "D1", "I1", "F1", "N1", "P1"]


class PipelineError(RuntimeError):
    """Actionable source, parsing, or validation failure."""


def _json_default(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (pd.Timestamp, datetime)):
        return value.isoformat().replace("+00:00", "Z")
    if pd.isna(value):
        return None
    raise TypeError(f"Cannot encode {type(value).__name__}")


def read_aliases(path: Path) -> dict[str, str]:
    if not path.exists():
        raise PipelineError(f"Team alias file is missing: {path}")
    table = pd.read_csv(path, dtype=str, keep_default_na=False, encoding="utf-8-sig")
    if not {"raw_name", "canonical_name"}.issubset(table.columns):
        raise PipelineError("team_aliases.csv must have raw_name,canonical_name columns")
    aliases: dict[str, str] = {}
    for row in table.itertuples(index=False):
        raw = str(row.raw_name).strip()
        canonical = str(row.canonical_name).strip()
        if not raw or not canonical:
            continue
        if raw in aliases and aliases[raw] != canonical:
            raise PipelineError(f"Conflicting alias for {raw!r}: {aliases[raw]!r} vs {canonical!r}")
        aliases[raw] = canonical
    return aliases


def _canonical_name(name: Any, aliases: dict[str, str], canonical_names: set[str]) -> str | None:
    if pd.isna(name) or not str(name).strip():
        return None
    raw = str(name).strip()
    if raw in aliases:
        return aliases[raw]
    if raw in canonical_names:
        return raw
    return None


def _parse_kickoff(date_value: Any, time_value: Any) -> tuple[pd.Timestamp | None, str | None]:
    date = pd.to_datetime(str(date_value).strip(), dayfirst=True, format="mixed", errors="coerce")
    if pd.isna(date):
        return None, None
    local_date = date.date()
    text = "" if pd.isna(time_value) else str(time_value).strip()
    if not text or text.lower() in {"nan", "nat", "none", "null"}:
        return pd.Timestamp(datetime.combine(local_date, time.min), tz="UTC"), "DATE"
    parsed = pd.to_datetime(text, format="mixed", errors="coerce")
    if pd.isna(parsed):
        raise PipelineError(f"Unrecognised kickoff time {text!r} on {local_date}")
    # Football-Data records source-local kickoff times. The agreed contract uses UK local.
    try:
        local = pd.Timestamp(datetime.combine(local_date, parsed.time())).tz_localize(
            TZ, ambiguous="raise", nonexistent="raise"
        )
    except Exception as exc:
        raise PipelineError(f"Cannot resolve UK-local kickoff {local_date} {text}: {exc}") from exc
    return local.tz_convert("UTC"), "EXACT"


def _preclosing_capture_window(kickoff_utc: pd.Timestamp) -> pd.Timestamp:
    """Return the end of the provider's stated collection window, never an exact quote time."""
    local = kickoff_utc.tz_convert(TZ)
    weekday = local.weekday()
    if weekday in (1, 2):  # Tuesday/Wednesday fixtures: Tuesday collection window.
        days_since_tuesday = (weekday - 1) % 7
        capture_date = (local - pd.Timedelta(days=days_since_tuesday)).date()
        capture_time = time(13, 0)
    else:  # Weekend and other fixtures: preceding Friday collection window.
        days_since_friday = (weekday - 4) % 7
        capture_date = (local - pd.Timedelta(days=days_since_friday)).date()
        capture_time = time(17, 0)
    end_local = pd.Timestamp(datetime.combine(capture_date, capture_time)).tz_localize(TZ)
    return end_local.tz_convert("UTC")


def _season_for_date(date_value: pd.Timestamp) -> str:
    year = date_value.year if date_value.month >= 7 else date_value.year - 1
    return f"{year}-{(year + 1) % 100:02d}"


def _belongs_to_source_season(season: str, date_value: pd.Timestamp) -> bool:
    start, end = S.season_date_bounds(season)
    utc_date = pd.Timestamp(date_value.date(), tz="UTC")
    return start <= utc_date <= end


def _split_for_season(season: str) -> str:
    year = int(season[:4])
    if 2005 <= year <= 2009:
        return "warmup"
    if 2010 <= year <= 2022:
        return "train"
    if year == 2023:
        return "calibration"
    if year == 2024:
        return "validation"
    if year == 2025:
        return "holdout"
    raise PipelineError(f"Season {season} is outside contract splits; 2026-27 is not in scope")


def _season_code(season: str) -> str:
    year = int(season[:4])
    return f"{year % 100:02d}{(year + 1) % 100:02d}"


def _read_source(path: Path) -> pd.DataFrame:
    try:
        df = pd.read_csv(path, encoding="cp1252", low_memory=False)
    except (UnicodeDecodeError, pd.errors.ParserError):
        encoding = "utf-8-sig" if _is_utf8_source(path) else "cp1252"
        with path.open("r", encoding=encoding, newline="") as handle:
            expected_columns = len(next(csv.reader(handle)))
        repaired_rows = 0

        def repair_overlong_row(fields: list[str]) -> list[str] | None:
            nonlocal repaired_rows
            if len(fields) > expected_columns and all(not x.strip() for x in fields[expected_columns:]):
                repaired_rows += 1
                return fields[:expected_columns]
            raise PipelineError(f"Unrepairable overlong CSV row in {path}; refusing to drop or guess fields")

        df = pd.read_csv(path, encoding=encoding, engine="python", on_bad_lines=repair_overlong_row)
        df.attrs["trailing_empty_fields_removed"] = repaired_rows
    df.columns = [str(c).strip().replace("\ufeff", "") for c in df.columns]
    return df


def _is_utf8_source(path: Path) -> bool:
    try:
        path.read_text(encoding="utf-8-sig")
        return True
    except UnicodeDecodeError:
        return False


def _first_present(row: pd.Series, candidates: tuple[str, ...]) -> Any:
    for col in candidates:
        if col in row.index and pd.notna(row[col]) and str(row[col]).strip() != "":
            return row[col]
    return np.nan


ODDS_COLUMNS = {
    ("B365", "PRE_CLOSING"): (("B365H",), ("B365D",), ("B365A",)),
    ("PS", "PRE_CLOSING"): (("PSH", "PH"), ("PSD", "PD"), ("PSA", "PA")),
    ("BW", "PRE_CLOSING"): (("BWH",), ("BWD",), ("BWA",)),
    ("IW", "PRE_CLOSING"): (("IWH",), ("IWD",), ("IWA",)),
    ("WH", "PRE_CLOSING"): (("WHH",), ("WHD",), ("WHA",)),
    ("VC", "PRE_CLOSING"): (("VCH",), ("VCD",), ("VCA",)),
    ("MAX", "PRE_CLOSING"): (("MaxH", "BbMxH"), ("MaxD", "BbMxD"), ("MaxA", "BbMxA")),
    ("AVG", "PRE_CLOSING"): (("AvgH", "BbAvH"), ("AvgD", "BbAvD"), ("AvgA", "BbAvA")),
    ("B365", "CLOSING"): (("B365CH",), ("B365CD",), ("B365CA",)),
    ("PS", "CLOSING"): (("PSCH",), ("PSCD",), ("PSCA",)),
    ("BW", "CLOSING"): (("BWCH",), ("BWCD",), ("BWCA",)),
    ("IW", "CLOSING"): (("IWCH",), ("IWCD",), ("IWCA",)),
    ("WH", "CLOSING"): (("WHCH",), ("WHCD",), ("WHCA",)),
    ("VC", "CLOSING"): (("VCCH",), ("VCCD",), ("VCCA",)),
    ("MAX", "CLOSING"): (("MaxCH", "BbMxCH"), ("MaxCD", "BbMxCD"), ("MaxCA", "BbMxCA")),
    ("AVG", "CLOSING"): (("AvgCH", "BbAvCH"), ("AvgCD", "BbAvCD"), ("AvgCA", "BbAvCA")),
}


def _quote_values(row: pd.Series, key: tuple[str, str]) -> tuple[float | None, float | None, float | None] | None:
    groups = ODDS_COLUMNS[key]
    raw = [_first_present(row, group) for group in groups]
    values = [pd.to_numeric(value, errors="coerce") for value in raw]
    # No columns or a wholly empty group means this source/snapshot is unavailable.
    present_columns = [any(col in row.index for col in group) for group in groups]
    if not any(present_columns):
        return None
    result: list[float | None] = []
    for value in values:
        if pd.isna(value):
            result.append(None)
        else:
            result.append(float(value))
    return tuple(result)  # type: ignore[return-value]


def _invalid_reason(odds: tuple[float | None, float | None, float | None]) -> str | None:
    if any(value is not None and not np.isfinite(value) for value in odds):
        return "NON_FINITE"
    if any(value is None for value in odds):
        return "MISSING_ODDS"
    if any(value <= 1.0 for value in odds if value is not None):
        return "ODDS_LE_1"
    return None


def _typed_tables(matches: list[dict], outcomes: list[dict], quotes: list[dict]) -> tuple[pd.DataFrame, ...]:
    match_cols = list(S.SCHEMAS["matches"])
    outcome_cols = list(S.SCHEMAS["outcomes"])
    quote_cols = list(S.SCHEMAS["quotes"])
    match_df = pd.DataFrame(matches, columns=match_cols)
    outcome_df = pd.DataFrame(outcomes, columns=outcome_cols)
    quote_df = pd.DataFrame(quotes, columns=quote_cols)
    for df, names in ((match_df, ("match_id", "league", "season", "kickoff_precision", "home_team", "away_team", "matchweek_key")),
                      (outcome_df, ("match_id", "result")),
                      (quote_df, ("quote_id", "match_id", "bookmaker", "snapshot", "timestamp_precision", "source"))):
        for col in names:
            df[col] = df[col].astype("string")
    for df, names in ((match_df, ("kickoff_utc", "feature_cutoff_utc")),
                      (quote_df, ("observed_at_utc", "ingested_at_utc"))):
        for col in names:
            df[col] = pd.to_datetime(df[col], utc=True)
    for col in ("home_goals", "away_goals"):
        outcome_df[col] = pd.to_numeric(outcome_df[col], errors="raise").astype("int64")
    for col in ("odds_home", "odds_draw", "odds_away"):
        quote_df[col] = pd.to_numeric(quote_df[col], errors="coerce").astype("float64")
    quote_df["is_valid"] = quote_df["is_valid"].astype("bool")
    quote_df["invalid_reason"] = quote_df["invalid_reason"].astype("string")
    return match_df, outcome_df, quote_df


def _write_unmapped(path: Path, names: set[str], known: set[str]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    suggestions = []
    for name in sorted(names):
        match = difflib.get_close_matches(name, sorted(known), n=3, cutoff=0.55)
        suggestions.append({"raw_name": name, "possible_canonical_names": " | ".join(match)})
    pd.DataFrame(suggestions, columns=["raw_name", "possible_canonical_names"]).to_csv(path, index=False)


def load_rows(raw_dir: Path, leagues: list[str], seasons: list[str], aliases_path: Path) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, dict]:
    aliases = read_aliases(aliases_path)
    canonical_names = set(aliases.values())
    parsed: list[tuple[str, str, pd.DataFrame]] = []
    missing_files: list[str] = []
    raw_rows = 0
    unreadable_rows = Counter()
    duplicate_count = 0

    for season in seasons:
        # Confirm the season name rather than accepting a plausible-looking arbitrary path.
        if season != f"{int(season[:4])}-{(int(season[:4]) + 1) % 100:02d}":
            raise PipelineError(f"Malformed season {season!r}; expected YYYY-YY")
        if _split_for_season(season) == "holdout":
            # Loaded for checks; never evaluated by the ingestion pipeline.
            pass
        for league in leagues:
            path = raw_dir / _season_code(season) / f"{league}.csv"
            if not path.is_file() or path.stat().st_size == 0:
                missing_files.append(f"{season}/{league}")
                continue
            df = _read_source(path)
            raw_rows += len(df)
            must = {"Date", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "FTR"}
            absent = sorted(must - set(df.columns))
            if absent:
                raise PipelineError(f"{path} is missing required source columns: {absent}")
            parsed.append((season, league, df))
    if not parsed:
        raise PipelineError(f"No source CSVs found under {raw_dir}; run `python -m data_pipeline.download` first.")

    all_raw_names: set[str] = set()
    for _, _, frame in parsed:
        all_raw_names.update(str(x).strip() for x in pd.concat([frame["HomeTeam"], frame["AwayTeam"]]).dropna().unique())
    unknown = {name for name in all_raw_names if _canonical_name(name, aliases, canonical_names) is None}
    if unknown:
        report = raw_dir / "unmapped_team_names.csv"
        _write_unmapped(report, unknown, canonical_names | set(aliases))
        preview = ", ".join(sorted(unknown)[:14])
        more = f" (and {len(unknown) - 14} more)" if len(unknown) > 14 else ""
        raise PipelineError(f"{len(unknown)} team names are missing from {aliases_path}. Review {report}: {preview}{more}; map variants deliberately, then rerun.")

    kickoff_rows: list[dict] = []
    outcome_rows: list[dict] = []
    quote_rows: list[dict] = []
    invalid_dates: list[dict] = []
    bad_season_dates: list[dict] = []
    covid_extended_season_rows: list[dict] = []
    source_manifest: list[dict] = []
    source_row_seen: set[tuple[str, str, str, str]] = set()
    duplicates_by_league = Counter()
    missing_results = 0
    result_mismatches = []
    now = pd.Timestamp.now(tz="UTC")

    for season, league, frame in parsed:
        path = raw_dir / _season_code(season) / f"{league}.csv"
        mtime = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat().replace("+00:00", "Z")
        source_manifest.append({
            "name": f"{league} {season} season CSV",
            "url": f"{SOURCE}/mmz4281/{_season_code(season)}/{league}.csv",
            "local_file_mtime_utc": mtime,
            "source_archive": f"{SOURCE}/mmz4281/{_season_code(season)}/data.zip",
            "source_columns": [str(column) for column in frame.columns],
            "trailing_empty_fields_removed": int(frame.attrs.get("trailing_empty_fields_removed", 0)),
            "odds_column_availability": {
                f"{bookmaker}_{snapshot}": [column for group in groups for column in group if column in frame.columns]
                for (bookmaker, snapshot), groups in ODDS_COLUMNS.items()
            },
            "bookmakers_with_pre_closing_columns": sorted({
                bookmaker for (bookmaker, snapshot), groups in ODDS_COLUMNS.items()
                if snapshot == "PRE_CLOSING" and all(any(col in frame.columns for col in group) for group in groups)
            }),
            "bookmakers_with_closing_columns": sorted({
                bookmaker for (bookmaker, snapshot), groups in ODDS_COLUMNS.items()
                if snapshot == "CLOSING" and all(any(col in frame.columns for col in group) for group in groups)
            }),
        })
        for source_row_number, row in frame.iterrows():
            date = pd.to_datetime(str(row.get("Date", "")).strip(), dayfirst=True, format="mixed", errors="coerce")
            home = _canonical_name(row.get("HomeTeam"), aliases, canonical_names)
            away = _canonical_name(row.get("AwayTeam"), aliases, canonical_names)
            if pd.isna(date) or home is None or away is None:
                invalid_dates.append({"season": season, "league": league, "source_row": int(source_row_number) + 2,
                                      "invalid_date": bool(pd.isna(date)), "missing_team": bool(home is None or away is None)})
                unreadable_rows[league] += 1
                continue
            # The source season is authoritative. The shared contract explicitly
            # extends 2019-20 through 2020-08-31 for COVID-delayed fixtures.
            actual_season = _season_for_date(date)
            if not _belongs_to_source_season(season, date):
                bad_season_dates.append({"season_file": season, "actual_season": actual_season, "league": league,
                                         "source_row": int(source_row_number) + 2})
                unreadable_rows[league] += 1
                continue
            if season == "2019-20" and date.date() > pd.Timestamp("2020-06-30").date():
                covid_extended_season_rows.append({"season": season, "league": league,
                                                   "source_row": int(source_row_number) + 2})
            date_text = str(row.get("Date", "")).strip()
            time_value = row.get("Time") if "Time" in row.index else None
            kickoff, precision = _parse_kickoff(date_text, time_value)
            assert kickoff is not None and precision is not None
            duplicate_key = (league, date.strftime("%Y-%m-%d"), home, away)
            if duplicate_key in source_row_seen:
                duplicate_count += 1
                duplicates_by_league[league] += 1
                continue
            source_row_seen.add(duplicate_key)

            match_id = S.make_match_id(league, season, kickoff, home, away)
            kickoff_rows.append({
                "match_id": match_id, "league": league, "season": season, "kickoff_utc": kickoff,
                "kickoff_precision": precision, "home_team": home, "away_team": away,
                "matchweek_key": S.matchweek_key(league, kickoff), "feature_cutoff_utc": S.feature_cutoff(kickoff),
            })

            raw_home_goals = pd.to_numeric(row.get("FTHG"), errors="coerce")
            raw_away_goals = pd.to_numeric(row.get("FTAG"), errors="coerce")
            result = str(row.get("FTR", "")).strip().upper()
            if pd.isna(raw_home_goals) or pd.isna(raw_away_goals) or result not in S.RESULTS:
                missing_results += 1
            else:
                derived = "H" if raw_home_goals > raw_away_goals else "A" if raw_home_goals < raw_away_goals else "D"
                if result != derived:
                    result_mismatches.append({"match_id": match_id, "source_result": result, "score_result": derived})
                outcome_rows.append({"match_id": match_id, "home_goals": int(raw_home_goals),
                                     "away_goals": int(raw_away_goals), "result": result})

            for (bookmaker, snapshot), groups in ODDS_COLUMNS.items():
                odds = _quote_values(row, (bookmaker, snapshot))
                if odds is None:
                    continue
                reason = _invalid_reason(odds)
                if snapshot == "PRE_CLOSING":
                    observed = _preclosing_capture_window(kickoff)
                    timestamp_precision = "WINDOW"
                else:
                    observed = kickoff
                    timestamp_precision = "WINDOW"
                quote_rows.append({
                    "quote_id": f"{match_id}|{bookmaker}|{snapshot}", "match_id": match_id,
                    "bookmaker": bookmaker, "snapshot": snapshot, "observed_at_utc": observed,
                    "timestamp_precision": timestamp_precision, "ingested_at_utc": now,
                    "odds_home": odds[0], "odds_draw": odds[1], "odds_away": odds[2],
                    "source": f"football-data.co.uk/{_season_code(season)}/{league}.csv",
                    "is_valid": reason is None, "invalid_reason": reason,
                })

    match_df, outcome_df, quote_df = _typed_tables(kickoff_rows, outcome_rows, quote_rows)
    S.validate("matches", match_df)
    S.validate("outcomes", outcome_df)
    S.validate("quotes", quote_df)
    if result_mismatches:
        raise PipelineError(f"{len(result_mismatches)} source result/score mismatches. First: {result_mismatches[:3]}")
    diagnostics = {
        "missing_files": missing_files,
        "raw_source_rows": raw_rows,
        "invalid_date_or_team_rows": invalid_dates,
        "rows_with_wrong_season_date": bad_season_dates,
        "covid_extended_season_rows": covid_extended_season_rows,
        "duplicates_removed": duplicate_count,
        "duplicates_removed_by_league": dict(duplicates_by_league),
        "unsettled_matches": missing_results,
        "source_manifest": source_manifest,
        "invalid_quote_counts": dict(Counter(quote_df.loc[~quote_df.is_valid, "invalid_reason"].astype(str))),
        "timestamp_precision_counts": dict(Counter(quote_df.timestamp_precision.astype(str))),
        "quotes_retained_invalid": int((~quote_df.is_valid).sum()),
        "trailing_empty_fields_removed": int(sum(x.get("trailing_empty_fields_removed", 0) for x in source_manifest)),
        "quote_outliers": [],
    }
    return match_df, outcome_df, quote_df, diagnostics


def build_market_probs(quotes: pd.DataFrame, matches: pd.DataFrame) -> tuple[pd.DataFrame, list[dict]]:
    valid = quotes[quotes.is_valid].copy()
    if valid.empty:
        raise PipelineError("No valid three-way bookmaker quotes were found")
    # Bet365 is the reference in every season. If missing or invalid, the match
    # has no reference quote; another bookmaker is never silently substituted.
    valid_ref_keys = set(zip(
        valid.loc[valid.bookmaker.eq(S.REFERENCE_BOOKMAKER), "match_id"].astype(str),
        valid.loc[valid.bookmaker.eq(S.REFERENCE_BOOKMAKER), "snapshot"].astype(str),
    ))
    rows = []
    for quote in valid.itertuples(index=False):
        odds = [quote.odds_home, quote.odds_draw, quote.odds_away]
        probabilities, overround = M.implied_probs(odds)
        rows.append({
            "match_id": quote.match_id, "bookmaker": quote.bookmaker, "snapshot": quote.snapshot,
            "is_reference": (str(quote.match_id), str(quote.snapshot)) in valid_ref_keys
                            and quote.bookmaker == S.REFERENCE_BOOKMAKER,
            "q_home": probabilities[0], "q_draw": probabilities[1], "q_away": probabilities[2],
            "overround": overround,
        })
    table = pd.DataFrame(rows, columns=list(S.SCHEMAS["market_probs"]))
    for col in ("match_id", "bookmaker", "snapshot"):
        table[col] = table[col].astype("string")
    table["is_reference"] = table["is_reference"].astype(bool)
    for col in ("q_home", "q_draw", "q_away", "overround"):
        table[col] = table[col].astype(float)
    S.validate("market_probs", table)
    ref_counts = table.groupby(["match_id", "snapshot"]).is_reference.sum()
    if (ref_counts > 1).any():
        raise PipelineError("More than one reference quote was selected for a match snapshot")

    # Preserve suspect observations but expose, rather than silently remove, their flags.
    reasons_by_quote: dict[str, set[str]] = defaultdict(set)
    market_by_quote = table.merge(quotes[["quote_id", "match_id", "bookmaker", "snapshot", "odds_home", "odds_draw", "odds_away"]],
                                  on=["match_id", "bookmaker", "snapshot"], how="left")
    for row in market_by_quote.itertuples(index=False):
        if row.overround < 0 or row.overround > 0.25:
            reasons_by_quote[str(row.quote_id)].add("OVERROUND_OUTSIDE_0_25")
        if max(row.odds_home, row.odds_draw, row.odds_away) > 100:
            reasons_by_quote[str(row.quote_id)].add("ODDS_ABOVE_100")
    pre = table[table.snapshot.eq("PRE_CLOSING")]
    for match_id, group in pre.groupby("match_id", sort=False):
        refs = group[group.bookmaker.eq(S.REFERENCE_BOOKMAKER)]
        if refs.empty:
            continue
        ref = refs.iloc[0]
        for row in group.itertuples(index=False):
            if row.bookmaker == S.REFERENCE_BOOKMAKER:
                continue
            gap = max(abs(row.q_home - ref.q_home), abs(row.q_draw - ref.q_draw), abs(row.q_away - ref.q_away))
            if gap > 0.15:
                reasons_by_quote[f"{match_id}|{row.bookmaker}|PRE_CLOSING"].add("REFERENCE_PROBABILITY_GAP_ABOVE_0_15")
    outliers = []
    quote_index = quotes.set_index("quote_id")
    for quote_id in sorted(reasons_by_quote):
        quote = quote_index.loc[quote_id]
        outliers.append({"quote_id": quote_id, "match_id": str(quote.match_id),
                         "bookmaker": str(quote.bookmaker), "snapshot": str(quote.snapshot),
                         "reason_codes": sorted(reasons_by_quote[quote_id])})
    return table, outliers


def _calibration_slope(probabilities: np.ndarray, actual: np.ndarray) -> float | None:
    if len(probabilities) < 10 or len(np.unique(actual)) < 2 or np.std(probabilities) < 1e-10:
        return None
    eps = 1e-9
    p = np.clip(probabilities, eps, 1 - eps)
    x = np.log(p / (1 - p)).reshape(-1, 1)
    try:
        model = LogisticRegression(C=1e6, solver="lbfgs", max_iter=1000)
        model.fit(x, actual.astype(int))
        return float(model.coef_[0, 0])
    except (ValueError, FloatingPointError):
        return None


def build_efficiency_map(markets: pd.DataFrame, outcomes: pd.DataFrame, matches: pd.DataFrame,
                         *, include_holdout: bool = False) -> pd.DataFrame:
    eligible = markets.copy()
    if not include_holdout:
        eligible = eligible[~eligible.match_id.isin(matches.loc[matches.season.eq("2025-26"), "match_id"])]
    scored = eligible.merge(matches[["match_id", "league", "season"]], on="match_id", how="inner")
    scored = scored.merge(outcomes[["match_id", "result"]], on="match_id", how="inner")
    result_col = np.select([scored.result.eq("H"), scored.result.eq("D"), scored.result.eq("A")], [0, 1, 2], default=-1)
    scored = scored.loc[result_col >= 0].copy()
    if not include_holdout:
        scored = scored[scored.season.ne("2025-26")]
    rows = []
    for (league, season, snapshot, bookmaker), group in scored.groupby(
        ["league", "season", "snapshot", "bookmaker"], sort=True
    ):
        n = len(group)
        if n < 100:
            continue
        qs = group[["q_home", "q_draw", "q_away"]].to_numpy(float)
        y_idx = group.result.map({"H": 0, "D": 1, "A": 2}).to_numpy(int)
        labels = np.eye(3, dtype=int)[y_idx]
        losses = [M.log_loss_row(p, r) for p, r in zip(qs, group.result.astype(str))]
        briers = [M.brier_row(p, r) for p, r in zip(qs, group.result.astype(str))]
        pooled_q = qs.ravel()
        pooled_y = labels.ravel()
        residuals = pooled_y - pooled_q
        longshots = residuals[pooled_q < 0.25]
        favourites = residuals[pooled_q > 0.6]
        fav_longshot_gap = float(np.mean(longshots) - np.mean(favourites)) if len(longshots) and len(favourites) else None
        rows.append({
            "league": league, "season": season, "snapshot": snapshot, "bookmaker": bookmaker,
            "n_matches": n, "log_loss": float(np.mean(losses)), "brier": float(np.mean(briers)),
            "mean_overround": float(group.overround.mean()),
            "calib_slope": _calibration_slope(pooled_q, pooled_y),
            "fav_longshot_gap": fav_longshot_gap,
            "draw_bias": float(np.mean((group.result.eq("D").to_numpy(dtype=float)) - group.q_draw.to_numpy(float))),
        })
    result = pd.DataFrame(rows, columns=list(S.SCHEMAS["efficiency_map"]))
    for col in ("league", "season", "snapshot", "bookmaker"):
        result[col] = result[col].astype("string")
    result["n_matches"] = result["n_matches"].astype("int64")
    for col in ("log_loss", "brier", "mean_overround", "calib_slope", "fav_longshot_gap", "draw_bias"):
        result[col] = pd.to_numeric(result[col], errors="coerce").astype("float64")
    S.validate("efficiency_map", result)
    return result


def _build_audit(matches: pd.DataFrame, outcomes: pd.DataFrame, quotes: pd.DataFrame,
                 diagnostics: dict, outliers: list[dict], dataset_mode: str) -> dict:
    invalid_reason_counts = Counter(quotes.loc[~quotes.is_valid, "invalid_reason"].dropna().astype(str))
    utc_minutes = matches.kickoff_utc.dt.hour * 60 + matches.kickoff_utc.dt.minute
    near_midnight = int(((utc_minutes < 120) | (utc_minutes >= 1320)).sum())
    return {
        "dataset_mode": dataset_mode,
        "raw_counts": {"matches": int(diagnostics["raw_source_rows"]), "quotes": int(len(quotes))},
        "accepted_counts": {"matches": int(len(matches)), "quotes": int(quotes.is_valid.sum()),
                            "outcomes": int(len(outcomes))},
        "retained_invalid_quote_count": int((~quotes.is_valid).sum()),
        "source_row_repairs": {"trailing_empty_fields_removed": int(diagnostics.get("trailing_empty_fields_removed", 0))},
        "invalid_quotes_by_reason": dict(invalid_reason_counts),
        "timestamp_precision_counts": dict(Counter(quotes.timestamp_precision.astype(str))),
        "missing_value_counts": {
            "odds_home": int(quotes.odds_home.isna().sum()),
            "odds_draw": int(quotes.odds_draw.isna().sum()),
            "odds_away": int(quotes.odds_away.isna().sum()),
            "observed_at_utc": int(quotes.observed_at_utc.isna().sum()),
        },
        "duplicates_removed": int(diagnostics["duplicates_removed"]),
        "invalid_date_or_team_row_count": len(diagnostics["invalid_date_or_team_rows"]),
        "wrong_season_date_row_count": len(diagnostics["rows_with_wrong_season_date"]),
        "covid_extended_season_row_count": len(diagnostics.get("covid_extended_season_rows", [])),
        "near_midnight_utc_match_count": near_midnight,
        "unsettled_match_count": int(diagnostics["unsettled_matches"]),
        "flagged_outliers": outliers,
        "missing_source_files": diagnostics["missing_files"],
        "exclusions": [{"reason": "INVALID_DATE_TEAM_OR_SEASON", "count":
                        len(diagnostics["invalid_date_or_team_rows"]) + len(diagnostics["rows_with_wrong_season_date"])}],
        "note": "Invalid odds are retained in quotes.parquet and excluded only from market probabilities. Exclusions do not use match results.",
    }


def _manifest_note(seasons: list[str], leagues: list[str], diagnostics: dict, audit: dict,
                   dataset_mode: str, holdout_in_efficiency: bool, permission_statement: str | None) -> str:
    columns_by_file = "\n".join(
        f"| {Path(x['url']).parent.name} | {x['name'].split()[0]} | {x['local_file_mtime_utc']} | "
        f"{', '.join(x['bookmakers_with_pre_closing_columns']) or '—'} | "
        f"{', '.join(x['bookmakers_with_closing_columns']) or '—'} |"
        for x in diagnostics["source_manifest"]
    )
    return f"""# Data provenance and limitations

Dataset mode: **{dataset_mode}**  
Contract: {S.CONTRACT_VERSION}  
Pipeline run (UTC): {pd.Timestamp.now(tz='UTC').isoformat()}  
Requested coverage: {', '.join(leagues)} · {seasons[0]} through {seasons[-1]}  
Rows ingested: {len(audit['accepted_counts'].keys()) and audit['accepted_counts']['matches']:,} matches; {len(audit['accepted_counts']) and audit['accepted_counts'].get('quotes', 0):,} valid quotes; {len(diagnostics['missing_files'])} unavailable files

## Source and use

- Provider: [Football-Data.co.uk]({SOURCE}); results/odds are distributed as season CSV archives. The notes are at [{NOTES}]({NOTES}).
- Fair-use terms were reviewed by Marlon on 2026-10-24: [{FAIR_USE}]({FAIR_USE}). The provider describes its free files as intended for personal betting or academic interest/research, limits automated downloads to light use, and says to assume permission is not granted when requests seek commercial, AI or model-training rights. The team has confirmed its intended use is authorised. This project documents that assertion; it is not a separate licence grant.
- Team permission confirmation recorded for this run: {permission_statement or 'not supplied; see manifest'}
- No training-data rights are inferred solely from the fact a CSV can be downloaded. Do not expand the use or redistribute raw files.
- Raw provider data stays in `data/raw/` (gitignored); it is not copied into the artifacts bundle.

## Files inspected

| Archive season code | League | Local CSV-file modification time (not provider capture time) | Pre-closing columns available | Closing columns available |
|---|---|---|---|---|
{columns_by_file or '| — | — | — | — |'}

## Time and odds semantics

- The provider calls the early quote **pre-closing**, never opening. For the documented weekly capture schedule, the pipeline records the stated upper-window bound (Friday 17:00 UK local for weekend fixtures; Tuesday 13:00 UK local for Tuesday/Wednesday fixtures), tagged `WINDOW`. This is an assumed endpoint of a collection window, not an exact observation time; the provider warns historical collection times vary.
- Closing quotes are tagged `WINDOW` and attached to kickoff only as the contract's proxy. They are never used as prediction inputs.
- Kickoff `Time` values are converted from `Europe/London` as directed by the shared contract. The provider's field key documents a kickoff time but does not itself spell out a timezone; confirm the contract assumption for non-English leagues before making timezone-sensitive claims. Missing kickoff times are midnight UTC with precision `DATE`.
- {audit['near_midnight_utc_match_count']:,} kickoff instants fall within two hours of midnight UTC; this count supports the contract's timezone audit.
- The source notes say closing odds are generally available from 2019/20; Pinnacle closing home/draw/away odds exist further back. The pipeline reads the available named columns per source CSV and never fills a missing price.
- 2019-20 fixtures played after the ordinary season end remain in their source season through the contract's 2020-08-31 COVID exception; the retained count appears in `data_audit.json`.
- The provider warns its Pinnacle odds have been systematically stale since 2025-07-23. Pinnacle rows are retained, and the contract excludes them from execution for 2025-26.
- Bet365 is the reference for all seasons and snapshots. If it is missing or invalid, there is no reference. `MAX` and `AVG` aggregate quotes are retained for the efficiency map and are never executable.
- `controlled_best_price` line-shops across valid individual quotes after outlier, season-exclusion, and Bet365 probability-gap checks. The decision ledger records the selected bookmaker; CLV always uses Bet365 closing probabilities.
- Odds are normalized proportionally using `contract.maths.implied_probs`. `fav_longshot_gap` is mean `(observed - predicted)` for q<0.25 minus the same mean for q>0.60; negative values indicate relative longshot underperformance. `draw_bias` is mean observed-draw indicator minus predicted draw probability. `calib_slope` is the pooled logistic-regression slope on logit(q); 1 is calibrated.
- Efficiency rows require at least 100 scored matches. The normal run excludes 2025-26 until the team freeze. This table describes historical calibration, not a proof that an outcome can be profitably traded.

## Audit summary

- Accepted matches: {audit['accepted_counts']['matches']:,}; scored outcomes: {audit['accepted_counts']['outcomes']:,}; invalid date/team rows: {audit['invalid_date_or_team_row_count']:,}; duplicate matches removed: {audit['duplicates_removed']:,}.
- Retained COVID-extended 2019-20 fixtures: {audit.get('covid_extended_season_row_count', 0):,}; source rows with other out-of-season dates: {audit['wrong_season_date_row_count']:,}.
- Kickoffs within two hours of midnight UTC: {audit['near_midnight_utc_match_count']:,}.
- Quote candidates: {audit['raw_counts']['quotes']:,}; valid: {audit['accepted_counts']['quotes']:,}; retained invalid: {audit['retained_invalid_quote_count']:,}.
- Source-row formatting repairs: {audit.get('source_row_repairs', {}).get('trailing_empty_fields_removed', 0):,} excess trailing empty CSV fields removed; no non-empty field data was dropped.
- Missing season/league files: {', '.join(diagnostics['missing_files']) if diagnostics['missing_files'] else 'none'}.
- Flagged quote outliers: {len(audit['flagged_outliers']):,}. They remain in the source tables and are not silently deleted.
- Holdout excluded from efficiency map: {'no; this run was explicitly requested after freeze' if holdout_in_efficiency else 'yes'}.

## Interpretation limits

Historical prices are sparse snapshots, their timestamps are not exact, and coverage differs by league, bookmaker, and season. A validation success is exploratory until the frozen configuration is evaluated once on the 2025-26 holdout. Report results only from the corresponding model evaluation, with uncertainty and turnover.
"""


def run_pipeline(*, raw_dir: Path, artifacts_dir: Path, leagues: list[str], seasons: list[str],
                 aliases_path: Path, include_holdout_efficiency: bool = False,
                 downloader: dict | None = None, permission_statement: str | None = None,
                 freeze_verified: bool = False) -> dict:
    if include_holdout_efficiency and not freeze_verified:
        raise PipelineError("Including 2025-26 in the efficiency map requires the team's completed freeze")
    matches, outcomes, quotes, diagnostics = load_rows(raw_dir, leagues, seasons, aliases_path)
    if downloader is None:
        download_manifest = raw_dir / "download_manifest.json"
        if download_manifest.exists():
            downloader = json.loads(download_manifest.read_text(encoding="utf-8"))
    market_probs, outliers = build_market_probs(quotes, matches)
    diagnostics["quote_outliers"] = outliers
    efficiency = build_efficiency_map(market_probs, outcomes, matches, include_holdout=include_holdout_efficiency)
    dataset_mode = "REAL"
    audit = _build_audit(matches, outcomes, quotes, diagnostics, outliers, dataset_mode)
    by_season = {season: _split_for_season(season) for season in seasons}
    split_doc = {"contract_version": S.CONTRACT_VERSION, "by_season": by_season,
                 "holdout_season": S.HOLDOUT_SEASON,
                 "note": "Role assignment follows contract v1.2.0. Holdout source rows may be ingested and validated; never evaluate them before team freeze."}
    generated_at = pd.Timestamp.now(tz="UTC").isoformat().replace("+00:00", "Z")
    manifest = {
        "contract_version": S.CONTRACT_VERSION, "dataset_mode": dataset_mode, "produced_at_utc": generated_at,
        "leagues": leagues, "seasons": seasons,
        "season_exceptions": {"2019-20_covid_extension_rows": audit["covid_extended_season_row_count"]},
        "sources": [{"name": "Football-Data.co.uk season CSV archives", "url": f"{SOURCE}/mmz4281/YYZZ/data.zip",
                     "notes_url": NOTES, "terms_url": FAIR_USE, "terms_checked_at_utc": generated_at,
                     "terms_checked_by": "Marlon (team data owner)",
                     "team_owner_use_authorization_confirmed": bool(permission_statement),
                     "team_owner_use_authorization_note": permission_statement,
        "download_date": (downloader or {}).get("download_date_utc") or
                         (downloader or {}).get("finished_at_utc", "")[:10] or None,
                     "download_summary": downloader, "limitations": "Coverage and timestamp precision vary by season; see data_manifest.md and data_audit.json."}]
                     + diagnostics["source_manifest"],
    }
    manifest_json = json.dumps(manifest, indent=2, ensure_ascii=False, default=_json_default) + "\n"
    audit_json = json.dumps(audit, indent=2, ensure_ascii=False, default=_json_default) + "\n"
    manifest_md = _manifest_note(seasons, leagues, diagnostics, audit, dataset_mode,
                                 include_holdout_efficiency, permission_statement)

    tables = {
        "matches": matches, "outcomes": outcomes, "quotes": quotes,
        "market_probs": market_probs, "efficiency_map": efficiency,
    }
    artifacts_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="part1-build-", dir=artifacts_dir.parent) as temp_name:
        staging = Path(temp_name)
        for name, table in tables.items():
            S.write_table(table, staging / f"{name}.parquet", name)
        (staging / "manifest.json").write_text(manifest_json, encoding="utf-8")
        (staging / "splits.json").write_text(json.dumps(split_doc, indent=2) + "\n", encoding="utf-8")
        (staging / "data_audit.json").write_text(audit_json, encoding="utf-8")
        (staging / "data_manifest.md").write_text(manifest_md, encoding="utf-8")
        for path in staging.iterdir():
            path.replace(artifacts_dir / path.name)
    return {"matches": len(matches), "outcomes": len(outcomes), "quotes": len(quotes),
            "valid_quotes": int(quotes.is_valid.sum()), "market_probs": len(market_probs),
            "efficiency_rows": len(efficiency), "missing_files": diagnostics["missing_files"],
            "outliers": len(outliers), "artifacts_dir": str(artifacts_dir)}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--leagues", nargs="+", default=["E0"])
    parser.add_argument("--seasons", default="2005-06:2025-26")
    parser.add_argument("--raw-dir", type=Path, default=Path("data/raw"))
    parser.add_argument("--aliases", type=Path, default=Path("data_pipeline/team_aliases.csv"))
    parser.add_argument("--artifacts-dir", type=Path, default=Path(os.getenv("ARTIFACTS_DIR", "./artifacts")))
    parser.add_argument("--download", action="store_true", help="Fetch missing source season archives once; cached files are reused.")
    parser.add_argument("--include-holdout-efficiency", action="store_true",
                        help="Use only after the whole team freeze; the default excludes 2025-26.")
    parser.add_argument("--frozen-config", type=Path,
                        help="Required with --include-holdout-efficiency; the completed current-contract freeze.")
    parser.add_argument("--permission-note", default=os.getenv("FOOTBALL_DATA_PERMISSION_NOTE"),
                        help="Short factual note recording the project owner's confirmed intended-use authorization.")
    args = parser.parse_args()
    seasons = parse_seasons(args.seasons)
    downloader = None
    if args.download:
        downloader = download_archives(args.raw_dir, args.leagues, seasons)
    freeze_verified = False
    if args.include_holdout_efficiency:
        if args.frozen_config is None or not args.frozen_config.is_file():
            parser.error("--include-holdout-efficiency requires --frozen-config")
        frozen = json.loads(args.frozen_config.read_text(encoding="utf-8"))
        if frozen.get("contract_version") != S.CONTRACT_VERSION or not frozen.get("frozen_at_utc"):
            parser.error("--frozen-config must be a completed freeze for the current contract version")
        freeze_verified = True
    result = run_pipeline(raw_dir=args.raw_dir, artifacts_dir=args.artifacts_dir,
                         leagues=args.leagues, seasons=seasons, aliases_path=args.aliases,
                         include_holdout_efficiency=args.include_holdout_efficiency,
                         downloader=downloader, permission_statement=args.permission_note,
                         freeze_verified=freeze_verified)
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

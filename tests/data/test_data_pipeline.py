import csv

import pandas as pd
import pytest

from data_pipeline.run import (PipelineError, _belongs_to_source_season, _parse_kickoff,
                               _quote_values, build_market_probs, load_rows, run_pipeline)


@pytest.mark.parametrize(
    ("date", "time", "expected"),
    [
        ("12/08/21", "15:00", "2021-08-12T14:00:00Z"),
        ("12/08/2021", "15:00", "2021-08-12T14:00:00Z"),
    ],
)
def test_parse_kickoff_two_source_date_formats(date, time, expected):
    kickoff, precision = _parse_kickoff(date, time)
    assert kickoff.isoformat().replace("+00:00", "Z") == expected
    assert precision == "EXACT"


def test_old_pinnacle_column_falls_back_when_new_column_is_blank():
    row = pd.Series({"PSH": None, "PH": 2.0, "PSD": None, "PD": 3.4, "PSA": None, "PA": 3.6})
    assert _quote_values(row, ("PS", "PRE_CLOSING")) == (2.0, 3.4, 3.6)


def test_incomplete_present_quote_columns_are_retained_as_invalid_candidate():
    row = pd.Series({"B365H": 2.0, "B365D": None, "B365A": 3.6})
    assert _quote_values(row, ("B365", "PRE_CLOSING")) == (2.0, None, 3.6)


def test_covid_delayed_2019_20_fixtures_remain_in_their_source_season():
    assert _belongs_to_source_season("2019-20", pd.Timestamp("2020-07-01"))
    assert not _belongs_to_source_season("2019-20", pd.Timestamp("2020-09-01"))
    assert _belongs_to_source_season("2020-21", pd.Timestamp("2020-07-01"))


def test_market_reference_and_outlier_audit_use_quote_ids():
    matches = pd.DataFrame([{"match_id": "m", "league": "E0", "season": "2024-25"}])
    quotes = pd.DataFrame([
        {"quote_id": "m|B365|PRE_CLOSING", "match_id": "m", "bookmaker": "B365", "snapshot": "PRE_CLOSING",
         "is_valid": True, "odds_home": 2.1, "odds_draw": 3.4, "odds_away": 3.6},
        {"quote_id": "m|PS|PRE_CLOSING", "match_id": "m", "bookmaker": "PS", "snapshot": "PRE_CLOSING",
         "is_valid": True, "odds_home": 10.0, "odds_draw": 2.0, "odds_away": 2.0},
        {"quote_id": "m|MAX|PRE_CLOSING", "match_id": "m", "bookmaker": "MAX", "snapshot": "PRE_CLOSING",
         "is_valid": True, "odds_home": 2.2, "odds_draw": 3.5, "odds_away": 3.7},
    ])
    markets, outliers = build_market_probs(quotes, matches)
    assert markets.loc[markets.is_reference, "bookmaker"].tolist() == ["B365"]
    flagged = {item["quote_id"]: item["reason_codes"] for item in outliers}
    assert "m|PS|PRE_CLOSING" in flagged
    assert "REFERENCE_PROBABILITY_GAP_ABOVE_0_15" in flagged["m|PS|PRE_CLOSING"]
    assert "m|MAX|PRE_CLOSING" not in flagged or "OVERROUND_OUTSIDE_0_25" not in flagged["m|MAX|PRE_CLOSING"]


def test_holdout_efficiency_requires_verified_team_freeze(tmp_path):
    with pytest.raises(PipelineError, match="completed freeze"):
        run_pipeline(raw_dir=tmp_path / "raw", artifacts_dir=tmp_path / "artifacts",
                     leagues=["E0"], seasons=["2025-26"], aliases_path=tmp_path / "aliases.csv",
                     include_holdout_efficiency=True)


def test_unmapped_team_fails_and_writes_review_file(tmp_path):
    raw_dir = tmp_path / "raw"
    season_dir = raw_dir / "2526"
    season_dir.mkdir(parents=True)
    with (season_dir / "E0.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["Date", "Time", "HomeTeam", "AwayTeam", "FTHG", "FTAG", "FTR"])
        writer.writerow(["01/08/25", "15:00", "Known FC", "Mystery FC", 1, 0, "H"])
    aliases = tmp_path / "aliases.csv"
    aliases.write_text("raw_name,canonical_name\nKnown FC,Known FC\n", encoding="utf-8")
    with pytest.raises(PipelineError, match="missing from"):
        load_rows(raw_dir, ["E0"], ["2025-26"], aliases)
    report = pd.read_csv(raw_dir / "unmapped_team_names.csv")
    assert report.raw_name.tolist() == ["Mystery FC"]

import pandas as pd

from decisions.backtest import run_backtest, select_reference_quote
from contract import decisions as D
from contract import maths as M


def _fixture_frames(count=25):
    kickoff = pd.Timestamp("2025-05-01T15:00:00Z")
    cutoff = pd.Timestamp("2025-04-29T00:00:00Z")
    matches, quotes, predictions = [], [], []
    for i in range(count):
        match_id = f"E0_2024-25_20250501_home-{i}_away-{i}"
        matches.append({"match_id": match_id, "league": "E0", "season": "2024-25",
                        "kickoff_utc": kickoff, "feature_cutoff_utc": cutoff})
        quotes.append({"quote_id": f"{match_id}|B365|PRE_CLOSING", "match_id": match_id,
                       "bookmaker": "B365", "snapshot": "PRE_CLOSING", "is_valid": True,
                       "odds_home": 2.2, "odds_draw": 3.5, "odds_away": 3.2,
                       "timestamp_precision": "WINDOW", "observed_at_utc": pd.Timestamp("2025-04-28T12:00:00Z")})
        predictions.append({"match_id": match_id, "model_id": "market", "model_version": "test-v1",
                            "split": "validation", "p_home": 0.52, "p_draw": 0.25, "p_away": 0.23})
    market_cols = ["match_id", "bookmaker", "snapshot", "is_reference", "q_home", "q_draw", "q_away", "overround"]
    return (pd.DataFrame(matches), pd.DataFrame(columns=["match_id", "result"]), pd.DataFrame(quotes),
            pd.DataFrame(columns=market_cols), pd.DataFrame(predictions))


def test_reference_uses_b365_when_valid_pinnacle_is_not_available():
    quotes = pd.DataFrame([
        {"match_id": "m", "snapshot": "PRE_CLOSING", "bookmaker": "PS", "is_valid": False,
         "quote_id": "ps", "odds_home": 2.0, "odds_draw": 3.0, "odds_away": 4.0,
         "timestamp_precision": "WINDOW", "observed_at_utc": pd.Timestamp("2025-01-01T00:00Z")},
        {"match_id": "m", "snapshot": "PRE_CLOSING", "bookmaker": "B365", "is_valid": True,
         "quote_id": "b365", "odds_home": 2.1, "odds_draw": 3.1, "odds_away": 4.1,
         "timestamp_precision": "WINDOW", "observed_at_utc": pd.Timestamp("2025-01-01T00:00Z")},
    ])
    assert select_reference_quote(quotes, "m", "PRE_CLOSING")["quote_id"] == "b365"


def test_reference_does_not_fall_back_when_b365_is_missing_or_invalid():
    quotes = pd.DataFrame([{
        "match_id": "m", "snapshot": "PRE_CLOSING", "bookmaker": "PS", "is_valid": True,
        "quote_id": "ps", "odds_home": 2.0, "odds_draw": 3.0, "odds_away": 4.0,
        "timestamp_precision": "WINDOW", "observed_at_utc": pd.Timestamp("2025-01-01T00:00Z"),
    }])
    assert select_reference_quote(quotes, "m", "PRE_CLOSING") is None


def test_golden_best_price_vectors():
    import json
    from pathlib import Path

    vectors = json.loads(Path("contract/golden/test_vectors.json").read_text())
    for case in vectors["best_price"]:
        result = D.best_price_quote(case["quotes"], case["season"])
        expected = case["expected"]
        if expected is None:
            assert result is None
        else:
            assert result["odds"] == expected["odds"]
            assert result["bookmakers"] == expected["bookmakers"]
            assert result["ref_odds"] == expected["ref_odds"]
            assert result["timestamp_precision"] == expected["timestamp_precision"]


def test_controlled_flat_stakes_obey_golden_total_exposure_vector():
    matches, outcomes, quotes, market_probs, predictions = _fixture_frames()
    decisions = run_backtest(matches, outcomes, quotes, market_probs, predictions,
                             split="validation", models=["market"])
    controlled = decisions[decisions.policy_id.eq("controlled")]
    assert len(controlled) == 25
    assert int(controlled.action.eq("BET").sum()) == 20
    rejected = controlled[controlled.reason_code.eq("EXPOSURE_LIMIT_TOTAL")]
    assert len(rejected) == 5
    assert rejected.stake.eq(0).all()
    assert rejected.reason_codes_all.eq("EXPOSURE_LIMIT_TOTAL").all()
    assert len(decisions) == 75
    assert set(decisions.policy_id.unique()) == set(D.POLICIES)
    best = decisions[decisions.policy_id.eq("controlled_best_price")]
    assert best.bookmaker.dropna().eq("B365").all()


def test_best_price_records_executed_book_and_b365_clv():
    matches, outcomes, quotes, market_probs, predictions = _fixture_frames(count=1)
    match_id = matches.iloc[0].match_id
    predictions.loc[0, ["p_home", "p_draw", "p_away"]] = [0.30, 0.28, 0.42]
    quotes.loc[0, ["odds_home", "odds_draw", "odds_away"]] = [3.1, 3.5, 2.8]
    quotes.loc[0, "quote_id"] = f"{match_id}|B365|PRE_CLOSING"
    quotes.loc[0, "bookmaker"] = "B365"
    quotes.loc[len(quotes)] = {
        "quote_id": f"{match_id}|PS|PRE_CLOSING", "match_id": match_id,
        "bookmaker": "PS", "snapshot": "PRE_CLOSING", "is_valid": True,
        "odds_home": 3.15, "odds_draw": 3.55, "odds_away": 2.85,
        "timestamp_precision": "WINDOW", "observed_at_utc": pd.Timestamp("2025-04-28T12:00:00Z"),
    }
    closing_q = M.implied_probs([3.0, 3.3, 2.7])[0]
    market_probs = pd.DataFrame([{
        "match_id": match_id, "bookmaker": "B365", "snapshot": "CLOSING", "is_reference": True,
        "q_home": closing_q[0], "q_draw": closing_q[1], "q_away": closing_q[2],
        "overround": sum(1 / x for x in [3.0, 3.3, 2.7]) - 1,
    }])
    ledger = run_backtest(matches, outcomes, quotes, market_probs, predictions,
                          split="validation", models=["market"])
    row = ledger[ledger.policy_id.eq("controlled_best_price")].iloc[0]
    assert row.action == "BET"
    assert row.selection == "A"
    assert row.bookmaker == "PS"
    assert row.closing_fair_prob == closing_q[2]
    assert abs(row.clv - M.clv(2.85, closing_q[2])) < 1e-12

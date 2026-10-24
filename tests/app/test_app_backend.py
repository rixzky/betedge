"""Part 3 backend tests (SPEC section 6), run on the golden files.

    python -m pytest -q
"""
from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[2]
GOLDEN = ROOT / "contract" / "golden"
API = GOLDEN / "api"
EXAMPLE_MATCH = json.loads((API / "replay.json").read_text())["match"]["match_id"]
NO_CLOSING_KEYS = {"closing_quote", "closing_fair_probs", "closing_fair_prob", "result", "home_goals",
                   "away_goals", "clv", "settled_pnl"}


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setenv("USE_GOLDEN", "1")
    for var in ("DATABASE_URL", "GEMINI_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    from app.backend.main import app

    return TestClient(app)


def example(name):
    return json.loads((API / f"{name}.json").read_text())


def all_keys(obj) -> set:
    keys = set()
    if isinstance(obj, dict):
        for k, v in obj.items():
            keys.add(k)
            keys |= all_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            keys |= all_keys(v)
    return keys


def assert_same_shape(actual, expected, path="$"):
    """Every key in the golden example exists in the response (recursively); x_ extras are allowed."""
    if isinstance(expected, dict):
        assert isinstance(actual, dict), f"{path} should be an object"
        missing = set(expected) - set(actual)
        assert not missing, f"{path} missing keys {missing}"
        extra = {k for k in actual if k not in expected and not k.startswith("x_")}
        assert not extra, f"{path} has unexpected keys {extra} (extras must start with x_)"
        for k, v in expected.items():
            if v is not None and actual[k] is not None:
                assert_same_shape(actual[k], v, f"{path}.{k}")
    elif isinstance(expected, list) and expected and isinstance(expected[0], (dict, list)):
        assert isinstance(actual, list), f"{path} should be a list"
        if actual:
            assert_same_shape(actual[0], expected[0], f"{path}[0]")


ENDPOINTS = [
    ("meta", "/api/meta"),
    ("efficiency_map", "/api/efficiency-map"),
    ("fixtures", "/api/fixtures?league=E0&season=2024-25"),
    ("replay", f"/api/replay/{EXAMPLE_MATCH}?model_id=lgbm"),
    ("reveal", f"/api/replay/{EXAMPLE_MATCH}/reveal?model_id=lgbm"),
    ("evidence", "/api/evidence?model_id=lgbm&split=validation"),
    ("audit", "/api/audit"),
    ("scenarios", "/api/scenarios"),
]


@pytest.mark.parametrize("name,url", ENDPOINTS)
def test_endpoint_ok_and_shape(client, name, url):
    r = client.get(url)
    assert r.status_code == 200, r.text
    assert_same_shape(r.json(), example(name))


def test_explain_unavailable_without_key(client):
    r = client.post(f"/api/explain/{EXAMPLE_MATCH}")
    assert r.status_code == 200
    body = r.json()
    assert_same_shape(body, example("explain"))
    assert body["available"] is False and body["text"] is None


def test_replay_matches_golden_example(client):
    got = client.get(f"/api/replay/{EXAMPLE_MATCH}?model_id=lgbm").json()
    want = example("replay")
    for key in ("per_outcome", "decision", "market_probs", "model", "offered_quote", "config_used",
                "information_cutoff_utc", "match", "config_hash", "is_exploratory", "policy_id", "price_source"):
        assert got[key] == want[key], key
    assert got["x_decision_source"] == "ledger"


def test_reveal_matches_golden_example(client):
    got = client.get(f"/api/replay/{EXAMPLE_MATCH}/reveal?model_id=lgbm").json()
    want = example("reveal")
    for key in want:
        assert got[key] == want[key], key


def test_replay_never_contains_closing_or_result(client):
    for fx in client.get("/api/fixtures?league=E0&season=2024-25").json()[:10]:
        body = client.get(f"/api/replay/{fx['match_id']}").json()
        leaked = all_keys(body) & NO_CLOSING_KEYS
        assert not leaked, f"replay leaks {leaked}"
        assert body["offered_quote"] is None or body["offered_quote"]["snapshot"] == "PRE_CLOSING"


def test_reveal_contains_closing_and_result(client):
    body = client.get(f"/api/replay/{EXAMPLE_MATCH}/reveal").json()
    assert body["closing_quote"]["snapshot"] == "CLOSING"
    assert body["result"]["result"] in ("H", "D", "A")
    assert {"clv", "settled_pnl", "closing_fair_probs"} <= set(body)


def _snapshot_files() -> dict:
    out = {}
    for p in sorted(GOLDEN.rglob("*")):
        if p.is_file():
            out[str(p)] = hashlib.sha256(p.read_bytes()).hexdigest()
    return out


def _ledger_bet_match(policy_id="controlled", model_id="lgbm") -> str:
    import pandas as pd

    d = pd.read_parquet(GOLDEN / "tables" / "decisions.parquet")
    rows = d[(d.policy_id == policy_id) & (d.model_id == model_id) & (d.action == "BET") & (d.split == "validation")]
    return rows.match_id.iloc[0]


def test_slider_override_is_exploratory_and_writes_nothing(client):
    before = _snapshot_files()
    match_id = _ledger_bet_match()
    locked = client.get(f"/api/replay/{match_id}?model_id=lgbm").json()
    assert locked["is_exploratory"] is False and locked["decision"]["action"] == "BET"
    r = client.get(f"/api/replay/{match_id}?model_id=lgbm&prob_stress_delta=0.5&price_haircut=0.05")
    assert r.status_code == 200
    body = r.json()
    assert body["is_exploratory"] is True and body["x_decision_source"] == "live"
    assert body["config_used"]["prob_stress_delta"] == 0.5
    assert body["config_used"]["price_haircut"] == 0.05
    assert body["decision"]["action"] == "NO_BET"  # no edge survives a 50pp probability cut
    assert _snapshot_files() == before


def test_best_price_policy(client):
    ref = client.get(f"/api/replay/{EXAMPLE_MATCH}?model_id=lgbm").json()
    best = client.get(f"/api/replay/{EXAMPLE_MATCH}?model_id=lgbm&policy_id=controlled_best_price").json()
    assert ref["price_source"] == "REFERENCE" and ref["offered_quote"]["bookmakers"] == ["B365"] * 3
    assert best["policy_id"] == "controlled_best_price" and best["price_source"] == "BEST_AVAILABLE"
    q = best["offered_quote"]
    assert q["quote_id"].startswith("BEST:") and q["snapshot"] == "PRE_CLOSING" and len(q["bookmakers"]) == 3
    assert all(b >= r for b, r in zip(q["odds"], ref["offered_quote"]["odds"]))
    # q_market stays Bet365 under both price sources
    assert [o["q_market"] for o in best["per_outcome"]] == [o["q_market"] for o in ref["per_outcome"]]
    assert [o["bookmaker"] for o in best["per_outcome"]] == q["bookmakers"]
    assert best["x_decision_source"] == "ledger" and best["is_exploratory"] is False
    assert all(not k.startswith("closing") for k in all_keys(best))


def test_best_price_ledger_decision_matches(client):
    import pandas as pd

    match_id = _ledger_bet_match("controlled_best_price")
    body = client.get(f"/api/replay/{match_id}?model_id=lgbm&policy_id=controlled_best_price").json()
    d = pd.read_parquet(GOLDEN / "tables" / "decisions.parquet")
    row = d[(d.match_id == match_id) & (d.model_id == "lgbm") & (d.policy_id == "controlled_best_price")].iloc[0]
    assert body["decision"]["action"] == row.action == "BET"
    assert body["decision"]["bookmaker"] == row.bookmaker
    assert body["decision"]["selection"] == row.selection


def test_unknown_policy_is_422(client):
    assert client.get(f"/api/replay/{EXAMPLE_MATCH}?policy_id=naive").status_code == 422
    assert client.get(f"/api/replay/{EXAMPLE_MATCH}/reveal?policy_id=bogus").status_code == 422


def test_evidence_has_three_policies_and_line_shopping_slot(client):
    ev = client.get("/api/evidence?model_id=lgbm&split=validation").json()
    assert {p["policy_id"] for p in ev["policies"]} == {"naive", "controlled", "controlled_best_price"}
    assert "x_line_shopping" in ev  # passed through from policy_metrics.json, never computed here


def test_slider_bounds_are_validated(client):
    assert client.get(f"/api/replay/{EXAMPLE_MATCH}?price_haircut=1.5").status_code == 422
    assert client.get(f"/api/replay/{EXAMPLE_MATCH}?prob_stress_delta=-0.1").status_code == 422


def test_meta_integrations_inactive_without_env(client):
    meta = client.get("/api/meta").json()
    assert meta["gemini_enabled"] is False
    assert meta["storage_backend"] == "local"
    assert meta["dataset_mode"] == "SYNTHETIC"


def test_regression_scenario_rejected(client):
    sc = {s["id"]: s for s in client.get("/api/scenarios").json()["scenarios"]}
    short = sc["likely_winner_negative_ev"]
    home = next(o for o in short["per_outcome"] if o["outcome"] == "H")
    assert home["p_model"] == 0.52 and home["odds_offered"] == 1.9
    assert home["ev_raw"] == pytest.approx(-0.012)
    assert short["decision"]["action"] == "NO_BET"


def test_unknown_match_is_404(client):
    assert client.get("/api/replay/NOPE").status_code == 404


# ------------------------------------------------------------------ real-artifacts mode
@pytest.fixture()
def artifacts(tmp_path, monkeypatch):
    """A copy of the golden files laid out like a real artifacts/ folder."""
    for p in (GOLDEN / "tables").glob("*.parquet"):
        shutil.copy(p, tmp_path / p.name)
    for p in (GOLDEN / "artifacts_json").glob("*.json"):
        shutil.copy(p, tmp_path / p.name)
    monkeypatch.setenv("USE_GOLDEN", "0")
    monkeypatch.setenv("ARTIFACTS_DIR", str(tmp_path))
    for var in ("DATABASE_URL", "GEMINI_API_KEY"):
        monkeypatch.delenv(var, raising=False)
    from app.backend.main import app

    return tmp_path, TestClient(app)


def test_holdout_hidden_until_locked(artifacts):
    folder, client = artifacts
    (folder / "holdout_locked.json").unlink()
    meta = client.get("/api/meta").json()
    assert meta["holdout_locked"] is False
    fixtures = client.get("/api/fixtures").json()
    assert fixtures and all(f["season"] != "2025-26" for f in fixtures)
    eff = client.get("/api/efficiency-map").json()
    assert all(r["season"] != "2025-26" for r in eff["rows"])
    ev = client.get("/api/evidence?split=holdout").json()
    assert ev["is_locked_holdout"] is False and ev["forecast"] == [] and ev["policies"] == []
    from app.backend import files

    matches = files.table("matches")
    holdout_id = matches[matches.season == "2025-26"].match_id.iloc[0]
    assert client.get(f"/api/replay/{holdout_id}").status_code == 403
    assert client.get(f"/api/replay/{holdout_id}/reveal").status_code == 403


def test_locked_holdout_shows_config_hash(artifacts):
    _, client = artifacts
    ev = client.get("/api/evidence?split=holdout").json()
    assert ev["is_locked_holdout"] is True
    assert ev["x_config_hash"] == client.get("/api/meta").json()["frozen_config_hash"]


def test_pinnacle_never_executes_in_2025_26(artifacts):
    _, client = artifacts
    from app.backend import files

    matches = files.table("matches")
    for match_id in matches[matches.season == "2025-26"].match_id.iloc[:25]:
        body = client.get(f"/api/replay/{match_id}?policy_id=controlled_best_price").json()
        if body["offered_quote"]:
            assert "PS" not in body["offered_quote"]["bookmakers"]
        board = {b["bookmaker"]: b for b in body["x_quote_board"]}
        if "PS" in board:
            assert board["PS"]["is_excluded_this_season"] is True


def test_missing_files_give_nulls_not_errors(artifacts):
    folder, client = artifacts
    for name in ("decisions.parquet", "predictions.parquet", "prediction_explanations.parquet",
                 "policy_metrics.json", "forecast_metrics.json", "data_audit.json", "efficiency_map.parquet"):
        (folder / name).unlink()
    assert client.get("/api/meta").json()["models"] == []
    assert client.get("/api/efficiency-map").json()["rows"] == []
    body = client.get(f"/api/replay/{EXAMPLE_MATCH}").json()
    assert body["model"] is None
    assert body["decision"]["reason_code"] == "MISSING_PREDICTION"
    assert body["x_decision_source"] == "live" and body["x_notes"]
    ev = client.get("/api/evidence").json()
    assert ev["forecast"] == [] and ev["policies"] == []
    assert client.get("/api/audit").status_code == 200


def test_invalid_table_is_reported_not_guessed(artifacts):
    folder, client = artifacts
    (folder / "matches.parquet").write_bytes(b"not a parquet file")
    assert client.get(f"/api/replay/{EXAMPLE_MATCH}").status_code == 503
    health = client.get("/api/health").json()
    assert health["files"]["matches.parquet"]["valid"] is False

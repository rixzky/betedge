"""Consumer-side regressions for the staggered Marlon -> Ricky -> Armaan hand-off."""
import json

from tests.app.test_app_backend import artifacts, client, EXAMPLE_MATCH, _ledger_bet_match


def test_forecast_models_stay_available_before_policy_metrics(artifacts):
    folder, api = artifacts
    (folder / "policy_metrics.json").unlink()
    source = json.loads((folder / "forecast_metrics.json").read_text())
    expected = {r["model_id"] for r in source["rows"] if r["split"] == "validation"}
    response = api.get("/api/evidence?split=validation")
    assert response.status_code == 200
    body = response.json()
    assert set(body["x_models"]) == expected
    assert body["model_id"] in expected
    assert {r["model_id"] for r in body["forecast"]} == expected
    assert body["policies"] == [] and body["equity_curve"] == []
    assert body["x_line_shopping"] is None


def test_five_forecast_models_need_no_policy_rows(artifacts):
    folder, api = artifacts
    (folder / "policy_metrics.json").unlink()
    path = folder / "forecast_metrics.json"
    doc = json.loads(path.read_text())
    row = next(r for r in doc["rows"] if r["split"] == "validation")
    # Synthetic test fixture only, not an app artifact or a claimed model result.
    models = ["market", "elo", "dixon_coles", "marketnet", "lgbm"]
    doc["rows"] = [{**row, "model_id": model} for model in models]
    path.write_text(json.dumps(doc))
    body = api.get("/api/evidence?split=validation&model_id=marketnet").json()
    assert body["x_models"] == models
    assert body["model_id"] == "marketnet"
    assert len(body["forecast"]) == 5
    assert body["policies"] == []


def test_unlocked_holdout_exposes_no_feature_importance_or_model_list(artifacts):
    folder, api = artifacts
    (folder / "holdout_locked.json").unlink()
    body = api.get("/api/evidence?split=holdout").json()
    assert body["forecast"] == [] and body["policies"] == []
    assert body["feature_importance"] == [] and body["equity_curve"] == []
    assert body["x_models"] == []
    assert body["is_locked_holdout"] is False


def test_line_shopping_is_passed_through_without_recalculation(artifacts):
    folder, api = artifacts
    path = folder / "policy_metrics.json"
    doc = json.loads(path.read_text())
    row = next(r for r in doc["rows"] if r["split"] == "validation" and r["model_id"] == "lgbm")
    comparison = {"roi_diff": -0.04, "roi_diff_ci_95": [-0.08, 0.02], "n_bets_diff": 7, "turnover_diff": 70.0}
    row["line_shopping"] = comparison
    path.write_text(json.dumps(doc))
    before = path.read_bytes()
    body = api.get("/api/evidence?split=validation&model_id=lgbm").json()
    assert body["x_line_shopping"] == comparison
    assert path.read_bytes() == before


def test_reveal_keeps_selected_best_price_ledger(client):
    from app.backend import files
    match = _ledger_bet_match("controlled_best_price")
    response = client.get(f"/api/replay/{match}/reveal?model_id=lgbm&policy_id=controlled_best_price")
    assert response.status_code == 200
    ledger = files.table("decisions")
    expected = ledger[(ledger.match_id == match) & (ledger.model_id == "lgbm") & (ledger.policy_id == "controlled_best_price")].iloc[-1]
    body = response.json()
    assert body["x_policy_id"] == "controlled_best_price"
    assert body["settled_pnl"] == round(float(expected.settled_pnl), 6)
    assert body["clv"] == round(float(expected.clv), 6)


def test_explainer_receives_selected_price_policy(client, monkeypatch):
    from app.backend import gemini
    captured = {}
    def explain(record, names):
        captured.update(record)
        return {"available": True, "text": "The checks passed.", "reason": None}
    monkeypatch.setattr(gemini, "explain", explain)
    response = client.post(f"/api/explain/{EXAMPLE_MATCH}?model_id=lgbm&policy_id=controlled_best_price")
    assert response.status_code == 200
    assert captured["price_source"] == "BEST_AVAILABLE"


def test_synthetic_metrics_are_not_presented_under_real_manifest(artifacts):
    folder, api = artifacts
    path = folder / "manifest.json"
    manifest = json.loads(path.read_text())
    manifest["dataset_mode"] = "REAL"
    path.write_text(json.dumps(manifest))
    body = api.get("/api/evidence?split=validation").json()
    assert body["dataset_mode"] == "REAL"
    assert body["forecast"] == [] and body["policies"] == []
    assert body["feature_importance"] == []
    health = api.get("/api/health").json()
    assert health["files"]["forecast_metrics.json"]["valid"] is False
    assert "does not match" in health["files"]["forecast_metrics.json"]["error"]


def test_preflight_reads_only_and_reports_forecast_first(artifacts):
    from app.backend.check_artifacts import report
    folder, _ = artifacts
    (folder / "policy_metrics.json").unlink()
    before = {p.name: p.read_bytes() for p in folder.iterdir() if p.is_file()}
    status = report()
    assert status["screens"]["Forecast evidence"]["ready"] is True
    assert status["screens"]["Policy evidence"]["ready"] is False
    assert status["screens"]["Policy evidence"]["missing_or_invalid"] == ["policy_metrics.json"]
    assert {p.name: p.read_bytes() for p in folder.iterdir() if p.is_file()} == before

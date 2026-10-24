"""Read-only hand-off preflight. No statistics, processing or files written.

    python -m app.backend.check_artifacts --golden
    python -m app.backend.check_artifacts
"""
from __future__ import annotations

import argparse
import json
import os

OWNERS = {
    "Marlon": ["matches.parquet", "outcomes.parquet", "quotes.parquet", "market_probs.parquet",
               "efficiency_map.parquet", "manifest.json", "splits.json", "data_audit.json", "decisions.parquet"],
    "Ricky": ["predictions.parquet", "prediction_explanations.parquet", "forecast_metrics.json",
              "feature_importance.json", "policy_metrics.json", "holdout_locked.json"],
}
SCREEN_INPUTS = {
    "Efficiency map": ["manifest.json", "splits.json", "efficiency_map.parquet"],
    "Recorded match replay": ["manifest.json", "splits.json", "matches.parquet", "quotes.parquet",
                              "market_probs.parquet", "predictions.parquet", "decisions.parquet"],
    "Forecast evidence": ["manifest.json", "forecast_metrics.json"],
    "Policy evidence": ["manifest.json", "decisions.parquet", "policy_metrics.json"],
    "Data audit": ["manifest.json", "data_audit.json"],
}


def report() -> dict:
    from .payloads import build_health
    health = build_health()
    states = health["files"]
    screens = {screen: {"ready": all(states.get(name, {}).get("valid", False) for name in names),
                        "missing_or_invalid": [name for name in names if not states.get(name, {}).get("valid", False)]}
               for screen, names in SCREEN_INPUTS.items()}
    return {"contract_version": health["contract_version"], "dataset_mode": health["dataset_mode"],
            "reading_from": health["reading_from"], "screens": screens, "files": states,
            "owners": OWNERS, "holdout_locked": health["holdout_locked"],
            "note": "Readiness checks file presence and contract validation, not statistical quality or ledger completeness."}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--golden", action="store_true")
    parser.add_argument("--json", action="store_true", help="print the file and screen checks as JSON")
    args = parser.parse_args()
    if args.golden:
        os.environ["USE_GOLDEN"] = "1"
    data = report()
    if args.json:
        print(json.dumps(data, indent=2))
    else:
        print(f"Contract {data['contract_version']} | {data['dataset_mode']} | {data['reading_from']}")
        for name, status in data["screens"].items():
            print(f"{'READY' if status['ready'] else 'WAITING':7} {name}")
            for filename in status["missing_or_invalid"]:
                owner = next((person for person, names in OWNERS.items() if filename in names), "team")
                error = data["files"].get(filename, {}).get("error")
                print(f"         {filename} ({owner}){': ' + error if error else ''}")
        print(data["note"])
        print("Holdout: " + ("locked artifact present" if data["holdout_locked"] else "hidden until the agreed freeze"))
    return 0 if all(s["ready"] for s in data["screens"].values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())

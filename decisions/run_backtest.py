"""Run the deterministic Part 1 decision ledger on predictions and validated tables."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from contract import schemas as S
from decisions.backtest import run_backtest


def _read_inputs(golden: bool, artifacts_dir: Path, predictions_path: Path | None) -> tuple[dict, Path]:
    if golden:
        base = Path("contract/golden/tables")
        tables = {name: S.read_table(base / f"{name}.parquet", name)
                  for name in ("matches", "outcomes", "quotes", "market_probs")}
        pred_path = predictions_path or base / "predictions.parquet"
        output = artifacts_dir / "synthetic_decisions.parquet"
    else:
        tables = {name: S.read_table(artifacts_dir / f"{name}.parquet", name)
                  for name in ("matches", "outcomes", "quotes", "market_probs")}
        pred_path = predictions_path or artifacts_dir / "predictions.parquet"
        output = artifacts_dir / "decisions.parquet"
    tables["predictions"] = S.read_table(pred_path, "predictions")
    return tables, output


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--golden", action="store_true", help="Use synthetic contract/golden tables and write a separately named synthetic ledger.")
    parser.add_argument("--split", choices=S.SPLITS, required=True)
    parser.add_argument("--models", default=",".join(S.MODEL_IDS))
    parser.add_argument("--predictions", type=Path, help="Optional validated Part 2 predictions.parquet path.")
    parser.add_argument("--artifacts-dir", type=Path, default=Path(os.getenv("ARTIFACTS_DIR", "./artifacts")))
    parser.add_argument("--run-id")
    parser.add_argument("--frozen-config", type=Path, help="Required for holdout; must contain a completed freeze timestamp.")
    args = parser.parse_args()
    models = [model.strip() for model in args.models.split(",") if model.strip()]
    if args.split == "holdout":
        if args.frozen_config is None or not args.frozen_config.is_file():
            parser.error("holdout requires --frozen-config from the team freeze")
        frozen = json.loads(args.frozen_config.read_text(encoding="utf-8"))
        if frozen.get("contract_version") != S.CONTRACT_VERSION or not frozen.get("frozen_at_utc"):
            parser.error("holdout requires a completed freeze for the current contract version")
    tables, output = _read_inputs(args.golden, args.artifacts_dir, args.predictions)
    audit_path = Path("contract/golden/artifacts_json/data_audit.json") if args.golden else args.artifacts_dir / "data_audit.json"
    outlier_quote_ids = set()
    if audit_path.is_file():
        audit = json.loads(audit_path.read_text(encoding="utf-8"))
        outlier_quote_ids = {str(item["quote_id"]) for item in audit.get("flagged_outliers", [])
                             if item.get("quote_id")}
    overrides = None
    if args.split == "holdout":
        frozen_model = frozen.get("model_id")
        frozen_version = str(frozen.get("model_version", ""))
        if frozen_model not in S.MODEL_IDS or (args.models != ",".join(S.MODEL_IDS) and models != [frozen_model]):
            parser.error("holdout must use exactly the model selected in frozen_config.json")
        models = [frozen_model]
        policy = frozen.get("policy")
        if not isinstance(policy, dict):
            parser.error("frozen_config.json is missing its frozen policy")
        matching = tables["predictions"][(tables["predictions"].split == "holdout") &
                                         (tables["predictions"].model_id == frozen_model)]
        versions = matching.model_version.dropna().astype(str).unique().tolist()
        if versions != [frozen_version]:
            parser.error(f"holdout prediction version {versions} does not match frozen model version {frozen_version!r}")
        overrides = {"controlled": policy}
    decisions = run_backtest(
        tables["matches"], tables["outcomes"], tables["quotes"], tables["market_probs"],
        tables["predictions"], split=args.split, models=models, run_id=args.run_id,
        policy_overrides=overrides, outlier_quote_ids=outlier_quote_ids,
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    S.write_table(decisions, output, "decisions")
    counts = decisions.groupby(["model_id", "policy_id", "action"], dropna=False).size().to_dict()
    print(json.dumps({"rows": len(decisions), "output": str(output), "counts": {
        "|".join(map(str, key)): int(value) for key, value in counts.items()
    }}, indent=2))


if __name__ == "__main__":
    main()

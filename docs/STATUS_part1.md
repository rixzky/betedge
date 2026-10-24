# Part 1 status

Contract version: 1.2.0  
Last updated: 2026-10-24

## Works

- Supplied v1.2.0 contract, integration guide, Part 1 specification, and change notes are installed unchanged. All 43 shared contract tests pass.
- Cached 21 season archives (168 league CSVs) cover E0, E1, SP1, D1, I1, F1, N1 and P1 from 2005-06 through 2025-26. Raw provider files stay in ignored `data/raw/` and are excluded from the handoff archive.
- Explicit team aliases map every observed source name. Unmapped teams fail with a review file rather than being guessed.
- Current real data build: 61,865 matches and outcomes; 630,288 quote rows across every available individual book and MAX/AVG aggregate, including invalid partial quotes; 619,442 valid market-probability rows; 1,632 efficiency rows. All eight leagues were previously hand-checked against source results.
- Bet365 is the reference in both snapshots. Outliers remain in the data and are audited by `quote_id`; this build flags 24,676. The audit records 345 COVID-extended 2019-20 fixtures, 41,332 kickoffs within two hours of midnight UTC, 64 harmless trailing-empty-field repairs, invalid quote counts, and source availability by file.
- The deterministic backtest calls the shared `reference_quote`, `best_price_quote`, and `decide_match` functions and writes all three policies: naive, controlled, and controlled-best-price. The synthetic validation run produced 1,314 rows for market, Elo and LightGBM. It is kept separate from the real data handoff.
- Ricky supplied schema-valid predictions for all five models at their current versions (`market-1.0`, `elo-1.0`, `dc-1.0`, `mn-1.1`, `lgbm-1.1`): 2,916 validation rows per model. The file also includes warmup, train and calibration predictions, and no holdout rows. Its `splits.json` matches Part 1.
- The refreshed validation backtest produced 43,740 decision rows: five models x three policies x 2,916 fixtures. It uses Ricky's current predictions for all models, so policy evaluation is based on one consistent prediction set. No holdout predictions or decisions were included. The full Part 1 test suite passes (59 tests).
- An updated five-model real validation handoff archive is available at `artifacts/artifacts-real-validation-5models.zip`; synthetic outputs and the previously superseded two-model forecast metrics are excluded.
- Team freeze completed on 2026-10-24 using validation-only selection: MarketNet `mn-1.1` with the contract-default controlled policy. `artifacts/frozen_config.json` records hash `beac4753cb5f` and all 29 logged trials. The freeze command refuses to overwrite this file.
- The reconciled freeze-input trial log is `artifacts/trials_log.jsonl`: 15 Part 1 policy-evaluation entries plus all 14 finite Part 2 model-trial entries retained from Ricky's earlier 191-row log. Ricky confirmed the 175 null and two infinite Part 2 records came from failed runs and should be omitted. Duplicate finite entries are retained as separate runs. The log is strict JSON and passes the freeze-input validation.
- Part 1 validation-trial records are now prepared in local `artifacts/trials_log_part1.jsonl`: 15 entries covering the five current model versions and three contract policies. The settings' hashes match the validation decisions ledger; the metrics are validation-only and the source file provides no evaluation timestamp.
- Holdout metrics and decisions remain gated on the completed freeze; no holdout run has occurred yet.

## Waiting on team inputs

- Ricky's generated artifacts remain untracked in his repo, so transfers continue through ZIP/shared drive. The refreshed predictions and decisions are local in this repo's ignored `artifacts/` directory and in the updated validation archive.
- Ricky's model status reports all five real models complete and recommends MarketNet based on validation forecast results. The team freeze is complete; Ricky must receive `artifacts/frozen_config.json` to run and lock the holdout.
- Ricky's final validation-only `policy_metrics.json` has been validated and copied to `artifacts/policy_metrics.json`. Part 1 trial records are prepared locally and are present in Ricky's merged log.
- The local `artifacts/forecast_metrics.json` currently has only market and Elo rows, despite Ricky's statement that a five-model copy exists in the merged artifacts. This is not read by the freeze command, but the final five-model validation metrics still need to be transferred for the complete app/submission evidence bundle.
- A holdout run needs Ricky to consume the completed `frozen_config.json`; do not rerun freeze or inspect holdout until Ricky performs the one-time locked run.
- Optional Tiger Data loading is not implemented; there is no configured database connection.

## How to run

Use Python 3.11 from this repository root:

```sh
python -m pytest -q
python -m data_pipeline.download --leagues E0 E1 SP1 D1 I1 F1 N1 P1 --seasons 2005-06:2025-26
python -m data_pipeline.run --leagues E0 E1 SP1 D1 I1 F1 N1 P1 --seasons 2005-06:2025-26 --permission-note "Team owner confirmed intended hackathon training use."
python -m decisions.run_backtest --split validation --models market,elo,dixon_coles,marketnet,lgbm
python -m decisions.run_backtest --golden --split validation --models market,elo,lgbm
# Already completed for the team freeze; do not rerun (the command refuses to overwrite the freeze):
python -m decisions.freeze --model marketnet --model-version mn-1.1
# Add --policy-json artifacts/frozen_policy.json only if the team selects non-default settings.
```

The real backtest reads `artifacts/predictions.parquet` and writes `artifacts/decisions.parquet`. Do not run holdout before the freeze.

## Known assumptions and limits

- `QUESTIONS.md` records how v1.2.0 resolved all four cross-part questions. `Europe/London` remains a contract assumption for source kickoff times; the midnight audit is available in `artifacts/data_audit.json`.
- Source terms and the team's intended-use confirmation are recorded in `artifacts/data_manifest.md` and `artifacts/manifest.json`. This records the team's confirmation and does not create a provider licence. Raw CSVs are not redistributed.
- Quotes are sparse snapshots with `WINDOW` timestamps and differing bookmaker coverage. The outputs support leakage-aware evaluation; they do not establish profitable performance.

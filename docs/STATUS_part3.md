# Part 3 status: Armaan's app

Contract: v1.2.0. Owner: Ricky. Verified: 24 October 2026.

## Implemented
- The existing React 18 / TypeScript / Vite frontend and file-reading FastAPI remain in place.
- Armaan approved a large 2D pitch home, opaque dark-green research screens and an editorial football style. Four labelled pitch components open the existing Efficiency map, Match replay, Evidence and Data audit screens immediately. The centre ball opens Match replay.
- Research navigation uses normal readable tabs. The chart library is loaded only when Evidence opens. The UI uses system fonts and native vector pitch markings, with reduced-motion support.
- v1.2.0 price-source selection reaches replay, exploratory requests, reveal and Gemini requests. The quote and per-outcome table show each price's bookmaker. Revealing a recorded result does not mislabel its P&L as a slider scenario's result.
- Evidence stays usable when forecast metrics arrive before policy metrics. All five model IDs are supported. Model choices use forecast and policy files; no metrics are calculated in this part.
- Three policies remain visible. The optional line-shopping record is passed through exactly as supplied, with the required stale-price caveat. Its field names/units still need confirmation from Ricky; no comparison is inferred or calculated when missing.
- Holdout feature importance and model lists are hidden before the lock artifact exists.
- JSON artifacts with a dataset_mode inconsistent with the manifest are rejected rather than mixed. The health endpoint explains why.
- Cache fingerprints include nanosecond modification time, size and inode for file replacements.
- Read-only preflight: `python -m app.backend.check_artifacts` (or `--golden`). It reports file/schema readiness per screen, not statistical quality or full ledger coverage.
- Root npm shortcuts and ARMAAN_START_HERE.md cover setup, real-file integration, ownership and teammate handoffs.

## Verification
- Original backend baseline: 70 tests passed before implementation.
- Final test and build results: see APP_CHANGES.md.
- API-client checks exercise the real client with both policies, including reveal/explain, encoded match IDs, zero-valued overrides and explicit HTTP errors.
- Protected shared files are checked byte-for-byte against the upload during packaging.
- Browser visual QA is incomplete. The managed preview did not expose the parent contract files when started from the frontend subdirectory; the subsequent browser action was blocked by the environment URL policy. No full-browser visual or phone-width pass is claimed for this revision.
- Python checks ran on the provided Python 3.12 runtime. The team's target remains Python 3.11; a Python 3.11 run on the final demo machine is still needed.

## Waiting for teammates
- No real artifacts are present in the supplied artifacts/ directory.
- Marlon: real validated data, efficiency map, audit and the complete validation decisions.parquet for all agreed models/policies, including abstentions.
- Ricky: actual five-model forecast_metrics.json / predictions and explanations, then policy_metrics.json after receiving Marlon's ledger.
- Ricky: confirm the non-null line_shopping shape and units (QUESTIONS.md).
- Team: freeze and the one locked holdout run. The app does not perform this work.
- Gemini and Tiger live paths have no credentials here and remain unverified/inactive.

## Run
Read ARMAAN_START_HERE.md first. The delivery includes the built React UI:
`python -m app.backend.main --golden --port 8000`, then open http://localhost:8000.
For real artifact files, omit --golden. For frontend development, use `npm run setup`
and `npm run dev` from this repo root. `npm run dev:mock` is a static-example mode.

## User-reference interaction revision
The user-supplied Omma canvas is now adapted into React (referencePitch.js plus typed controller). It animates 22 illustrative player markers, passing, shots and trails. The existing dark palette and native research overlay remain. Motion pauses behind the overlay/offscreen/in hidden tabs, with user pause and reduced-motion support. The reference analytical modules are not imported. 78 Python tests, API client checks, production build and canvas lifecycle checks pass. Full visual pointer/touch QA remains pending on the user laptop. See REFERENCE_PITCH_README.md in the delivery.

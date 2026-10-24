"""FastAPI backend for Part 3 (App). It READS artifact files and serves the contract API.

Run from the repo root:
    uvicorn app.backend.main:app --port 8000            # reads ARTIFACTS_DIR (default ./artifacts)
    USE_GOLDEN=1 uvicorn app.backend.main:app --port 8000
    python -m app.backend.main --golden --port 8000     # same, without remembering the env var

Response shapes: contract/api_types.ts. Examples: contract/golden/api/*.json.
If app/frontend/dist exists (after `npm run build`), the UI is served at / as well.
"""
from __future__ import annotations

import argparse
import os
import threading
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from contract.schemas import CONTRACT_VERSION

from . import payloads as P

app = FastAPI(title="oxhack-app API (Part 3)", version=CONTRACT_VERSION,
              description="Reads artifact files from Parts 1 and 2. No statistics, no data processing.")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _warm_caches() -> None:
    """Precompute /api/bets payloads in a background thread so the first request is instant."""
    threading.Thread(target=P.warm_bets_cache, name="warm-bets-cache", daemon=True).start()


@app.exception_handler(P.AppError)
async def _app_error(_request, exc: P.AppError):
    return JSONResponse(status_code=exc.status, content={"detail": exc.detail})


StressQ = Query(None, ge=0.0, le=0.5, description="Sensitivity assumption (not a confidence interval)")
HaircutQ = Query(None, ge=0.0, lt=1.0, description="Adverse-price haircut on the profit part of the odds")
MinEvQ = Query(None, ge=-1.0, le=1.0, description="Minimum expected value per unit staked")


def _overrides(prob_stress_delta, price_haircut, min_ev) -> dict:
    return {"prob_stress_delta": prob_stress_delta, "price_haircut": price_haircut, "min_ev": min_ev}


@app.get("/api/meta")
def meta():
    return P.build_meta()


@app.get("/api/efficiency-map")
def efficiency_map():
    return P.build_efficiency_map()


@app.get("/api/fixtures")
def fixtures(league: Optional[str] = None, season: Optional[str] = None):
    return P.build_fixtures(league, season)


@app.get("/api/bets")
def bets(league: Optional[str] = None, season: Optional[str] = None):
    return P.build_bets(league, season)


PolicyQ = Query(None, description="controlled (Bet365 prices, default) or controlled_best_price")


@app.get("/api/replay/{match_id}")
def replay(match_id: str, model_id: Optional[str] = None, policy_id: Optional[str] = PolicyQ,
           prob_stress_delta: Optional[float] = StressQ, price_haircut: Optional[float] = HaircutQ,
           min_ev: Optional[float] = MinEvQ):
    return P.build_replay(match_id, model_id, _overrides(prob_stress_delta, price_haircut, min_ev), policy_id)


@app.get("/api/replay/{match_id}/reveal")
def reveal(match_id: str, model_id: Optional[str] = None, policy_id: Optional[str] = PolicyQ):
    return P.build_reveal(match_id, model_id, policy_id)


@app.get("/api/evidence")
def evidence(model_id: Optional[str] = None, split: Optional[str] = None):
    return P.build_evidence(model_id, split)


@app.get("/api/audit")
def audit():
    return P.build_audit()


@app.get("/api/scenarios")
def scenarios():
    return P.build_scenarios()


@app.post("/api/explain/{match_id}")
def explain(match_id: str, model_id: Optional[str] = None, policy_id: Optional[str] = PolicyQ,
            prob_stress_delta: Optional[float] = StressQ, price_haircut: Optional[float] = HaircutQ,
            min_ev: Optional[float] = MinEvQ):
    return P.build_explain(match_id, model_id, _overrides(prob_stress_delta, price_haircut, min_ev), policy_id)


@app.get("/api/health")
def health():
    """Not part of the contract API: which artifact files are present and valid (for integration)."""
    return P.build_health()


# Serve the built UI (npm run build) from the same port, for the demo.
_DIST = Path(__file__).resolve().parents[1] / "frontend" / "dist"
if _DIST.exists():
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        target = _DIST / path
        if path and target.is_file():
            return FileResponse(target)
        return FileResponse(_DIST / "index.html")


def _cli() -> None:
    import uvicorn

    ap = argparse.ArgumentParser(description="Run the Part 3 API")
    ap.add_argument("--golden", action="store_true", help="read contract/golden instead of ARTIFACTS_DIR")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--reload", action="store_true")
    args = ap.parse_args()
    if args.golden:
        os.environ["USE_GOLDEN"] = "1"
    uvicorn.run("app.backend.main:app", host=args.host, port=args.port, reload=args.reload)


if __name__ == "__main__":
    _cli()

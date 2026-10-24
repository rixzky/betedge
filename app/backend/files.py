"""Read artifact files. Part 3 does no statistics and no data processing.

Everything here only locates, reads, validates and caches files:
  * parquet tables via contract.schemas.read_table (validated against the contract),
  * JSON artifacts via json.

Where files come from:
  * USE_GOLDEN=1 (or `python -m app.backend.main --golden`): contract/golden/tables and
    contract/golden/artifacts_json (synthetic examples).
  * otherwise ARTIFACTS_DIR (default ./artifacts, relative to the repo root you run from).

Files are re-read automatically when their modification time changes, so dropping a new
artifacts.zip into artifacts/ needs no restart.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Callable, Optional

import pandas as pd

from contract.schemas import HOLDOUT_SEASON, read_table

REPO_ROOT = Path(__file__).resolve().parents[2]
GOLDEN_DIR = REPO_ROOT / "contract" / "golden"

TABLE_NAMES = [
    "matches", "outcomes", "quotes", "market_probs", "efficiency_map",
    "predictions", "prediction_explanations", "decisions",
]
JSON_NAMES = [
    "manifest.json", "splits.json", "data_audit.json", "frozen_config.json",
    "forecast_metrics.json", "policy_metrics.json", "feature_importance.json",
    "holdout_locked.json",
]

_cache: dict[str, tuple[tuple[int, int, int], Any]] = {}
_errors: dict[str, str] = {}


# ------------------------------------------------------------------ locations
def use_golden() -> bool:
    return os.environ.get("USE_GOLDEN", "0").strip().lower() in {"1", "true", "yes", "on"}


def artifacts_dir() -> Path:
    raw = os.environ.get("ARTIFACTS_DIR", "").strip() or "./artifacts"
    p = Path(raw).expanduser()
    if p.is_absolute():
        return p
    here = Path.cwd() / p
    # Commands are meant to run from the repo root; fall back to it if cwd is elsewhere.
    return here if here.exists() else REPO_ROOT / p


def tables_dir() -> Path:
    return GOLDEN_DIR / "tables" if use_golden() else artifacts_dir()


def json_dir() -> Path:
    return GOLDEN_DIR / "artifacts_json" if use_golden() else artifacts_dir()


def source_label() -> str:
    return "golden (contract/golden, synthetic)" if use_golden() else f"artifacts ({artifacts_dir()})"


# ------------------------------------------------------------------ cached readers
def _cached(path: Path, loader: Callable[[Path], Any]) -> Any:
    key = str(path)
    try:
        stat = path.stat()
        mtime = (stat.st_mtime_ns, stat.st_size, stat.st_ino)
    except FileNotFoundError:
        _cache.pop(key, None)
        _errors.pop(path.name, None)
        return None
    hit = _cache.get(key)
    if hit is not None and hit[0] == mtime:
        return hit[1]
    value = loader(path)
    _cache[key] = (mtime, value)
    return value


def _read_with_fallback(path: Path, name: str) -> pd.DataFrame:
    """Try PyArrow first (golden files); fall back to fastparquet for real artifacts."""
    from contract.schemas import validate
    try:
        return read_table(path, name)
    except Exception:
        df = pd.read_parquet(path, engine="fastparquet")
        for col in ["kickoff_utc", "feature_cutoff_utc", "decision_time_utc", "training_cutoff_utc"]:
            if col in df.columns:
                df[col] = pd.to_datetime(df[col], utc=True)
        return validate(name, df)


def table(name: str) -> Optional[pd.DataFrame]:
    """Validated table, or None if the file is missing or fails the contract validator."""
    path = tables_dir() / f"{name}.parquet"
    try:
        df = _cached(path, lambda p: _read_with_fallback(p, name))
    except Exception as exc:
        _errors[path.name] = f"{type(exc).__name__}: {exc}"
        return None
    if df is not None:
        _errors.pop(path.name, None)
    return df


def jfile(name: str) -> Optional[Any]:
    """Parsed JSON artifact, or None if missing or unreadable."""
    path = json_dir() / name
    try:
        doc = _cached(path, lambda p: json.loads(p.read_text()))
        if name != "manifest.json" and isinstance(doc, dict) and doc.get("dataset_mode") is not None:
            if doc["dataset_mode"] != dataset_mode():
                raise ValueError(f"dataset_mode {doc['dataset_mode']} does not match manifest.json; artifact ignored")
    except Exception as exc:
        _errors[path.name] = f"{type(exc).__name__}: {exc}"
        return None
    if doc is not None:
        _errors.pop(path.name, None)
    return doc


def golden_api(name: str) -> Any:
    """Example API payloads shipped with the contract (used for fixed text such as scenarios)."""
    return json.loads((GOLDEN_DIR / "api" / f"{name}.json").read_text())


# ------------------------------------------------------------------ convenience lookups
def manifest() -> dict:
    return jfile("manifest.json") or {}


def dataset_mode() -> str:
    """REAL or SYNTHETIC from manifest.json. Missing manifest -> SYNTHETIC (the cautious reading)."""
    mode = manifest().get("dataset_mode")
    return mode if mode in ("REAL", "SYNTHETIC") else "SYNTHETIC"


def splits_by_season() -> dict[str, str]:
    doc = jfile("splits.json") or {}
    return dict(doc.get("by_season") or {})


def holdout_season() -> str:
    doc = jfile("splits.json") or {}
    return doc.get("holdout_season") or HOLDOUT_SEASON


def frozen_config() -> Optional[dict]:
    return jfile("frozen_config.json")


def holdout_locked() -> Optional[dict]:
    return jfile("holdout_locked.json")


def is_holdout_locked() -> bool:
    return holdout_locked() is not None


def file_status() -> dict:
    """For /api/health: which artifact files are present, valid or broken."""
    out: dict[str, dict] = {}
    for name in TABLE_NAMES:
        path = tables_dir() / f"{name}.parquet"
        df = table(name)
        out[path.name] = {
            "present": path.exists(),
            "valid": df is not None,
            "rows": None if df is None else int(len(df)),
            "error": _errors.get(path.name),
        }
    for name in JSON_NAMES:
        path = json_dir() / name
        doc = jfile(name)
        out[name] = {"present": path.exists(), "valid": doc is not None, "error": _errors.get(name)}
    return out

"""Quote lookups: local parquet by default, Tiger Data (TimescaleDB / Postgres) when available.

Tiger Data is reported as active ONLY if DATABASE_URL is set AND a real query against the
`quotes` table works (CONTRACT section 9). Part 1 loads the tables (contract/tiger_schema.sql);
Part 3 only reads. Any Tiger failure falls back to the parquet files and is reported in
/api/health, never hidden.
"""
from __future__ import annotations

import os
import time
from typing import Optional

import pandas as pd

from . import files

_TTL_SECONDS = 300
_state: dict = {"checked_at": None, "url": None, "backend": "local", "error": None}

_QUOTE_COLS = [
    "quote_id", "match_id", "bookmaker", "snapshot", "observed_at_utc", "timestamp_precision",
    "ingested_at_utc", "odds_home", "odds_draw", "odds_away", "source", "is_valid", "invalid_reason",
]


def _db_url() -> Optional[str]:
    return os.environ.get("DATABASE_URL", "").strip() or None


def active_backend() -> str:
    """'tiger' only if configured and a test query succeeded recently, else 'local'."""
    url = _db_url()
    if not url:
        _state.update(checked_at=None, url=None, backend="local", error=None)
        return "local"
    now = time.monotonic()
    fresh = _state["checked_at"] is not None and now - _state["checked_at"] < _TTL_SECONDS
    if fresh and _state["url"] == url:
        return _state["backend"]
    try:
        import psycopg  # optional dependency

        with psycopg.connect(url, connect_timeout=4) as conn, conn.cursor() as cur:
            cur.execute("SELECT quote_id FROM quotes LIMIT 1")  # proves the table, not just the server
            cur.fetchall()
        _state.update(backend="tiger", error=None)
    except Exception as exc:
        _state.update(backend="local", error=f"{type(exc).__name__}: {exc}")
    _state.update(checked_at=now, url=url)
    return _state["backend"]


def status() -> dict:
    backend = active_backend()
    return {"backend": backend, "database_url_set": _db_url() is not None, "error": _state["error"]}


def _mark_failed(exc: Exception) -> None:
    _state.update(backend="local", error=f"{type(exc).__name__}: {exc}", checked_at=time.monotonic())


def _ts(value) -> Optional[pd.Timestamp]:
    if value is None or (not isinstance(value, pd.Timestamp) and pd.isna(value)):
        return None
    t = pd.Timestamp(value)
    if pd.isna(t):
        return None
    return t.tz_localize("UTC") if t.tzinfo is None else t.tz_convert("UTC")


def _tiger_find(match_id: str, bookmaker: str, snapshot: str) -> Optional[dict]:
    import psycopg

    sql = (
        f"SELECT {', '.join(_QUOTE_COLS)} FROM quotes "
        "WHERE match_id = %s AND bookmaker = %s AND snapshot = %s "
        "ORDER BY observed_at_utc DESC NULLS LAST, quote_id LIMIT 1"
    )
    with psycopg.connect(_db_url(), connect_timeout=4) as conn, conn.cursor() as cur:
        cur.execute(sql, (match_id, bookmaker, snapshot))
        row = cur.fetchone()
    if row is None:
        return None
    rec = dict(zip(_QUOTE_COLS, row))
    rec["observed_at_utc"] = _ts(rec["observed_at_utc"])
    rec["ingested_at_utc"] = _ts(rec["ingested_at_utc"])
    return rec


def _parquet_find(match_id: str, bookmaker: str, snapshot: str) -> Optional[dict]:
    q = files.table("quotes")
    if q is None:
        return None
    rows = q[(q.match_id == match_id) & (q.bookmaker == bookmaker) & (q.snapshot == snapshot)]
    if rows.empty:
        return None
    # one capture per bookmaker and snapshot is expected; if several, take the latest observed
    rows = rows.sort_values(["observed_at_utc", "quote_id"], ascending=[False, True], na_position="last")
    rec = rows.iloc[0].to_dict()
    rec["observed_at_utc"] = _ts(rec.get("observed_at_utc"))
    rec["ingested_at_utc"] = _ts(rec.get("ingested_at_utc"))
    return rec


def _tiger_match_quotes(match_id: str, snapshot: str) -> list[dict]:
    import psycopg

    sql = (f"SELECT {', '.join(_QUOTE_COLS)} FROM quotes WHERE match_id = %s AND snapshot = %s "
           "ORDER BY bookmaker, observed_at_utc DESC NULLS LAST, quote_id")
    with psycopg.connect(_db_url(), connect_timeout=4) as conn, conn.cursor() as cur:
        cur.execute(sql, (match_id, snapshot))
        rows = cur.fetchall()
    out = []
    for row in rows:
        rec = dict(zip(_QUOTE_COLS, row))
        rec["observed_at_utc"] = _ts(rec["observed_at_utc"])
        rec["ingested_at_utc"] = _ts(rec["ingested_at_utc"])
        out.append(rec)
    return out


def _parquet_match_quotes(match_id: str, snapshot: str) -> list[dict]:
    q = files.table("quotes")
    if q is None:
        return []
    rows = q[(q.match_id == match_id) & (q.snapshot == snapshot)]
    rows = rows.sort_values(["bookmaker", "observed_at_utc", "quote_id"], ascending=[True, False, True],
                            na_position="last")
    out = []
    for rec in rows.to_dict(orient="records"):
        rec["observed_at_utc"] = _ts(rec.get("observed_at_utc"))
        rec["ingested_at_utc"] = _ts(rec.get("ingested_at_utc"))
        out.append(rec)
    return out


def match_quotes(match_id: str, snapshot: str) -> list[dict]:
    """Every quotes row for one match and snapshot (one per bookmaker expected), latest first."""
    if active_backend() == "tiger":
        try:
            return _tiger_match_quotes(match_id, snapshot)
        except Exception as exc:
            _mark_failed(exc)
    return _parquet_match_quotes(match_id, snapshot)


def find_quote(match_id: str, bookmaker: str, snapshot: str) -> Optional[dict]:
    """The quotes row for one match, bookmaker and snapshot (as a dict), or None."""
    if active_backend() == "tiger":
        try:
            return _tiger_find(match_id, bookmaker, snapshot)
        except Exception as exc:  # fall back loudly, never pretend Tiger worked
            _mark_failed(exc)
    return _parquet_find(match_id, bookmaker, snapshot)

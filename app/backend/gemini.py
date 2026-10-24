"""Optional Gemini explainer. It may only REPHRASE an existing decision record.

Rules (CONTRACT 6.4 and 9):
  * enabled only if GEMINI_API_KEY is set AND a test call to the model succeeds;
  * the prompt carries the decision record and asks for plain English with no numbers,
    odds, probabilities, predictions or news;
  * any reply that still contains digits (other than inside the team names) is discarded.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Optional

_TTL_SECONDS = 600
_state: dict = {"checked_at": None, "key": None, "ok": False, "reason": "GEMINI_API_KEY not set"}


def model_name() -> str:
    return os.environ.get("GEMINI_MODEL", "").strip() or "gemini-2.5-flash"


def _key() -> Optional[str]:
    return os.environ.get("GEMINI_API_KEY", "").strip() or None


def _client():
    from google import genai  # optional dependency (google-genai)

    return genai.Client(api_key=_key())


def is_enabled() -> bool:
    key = _key()
    if not key:
        _state.update(checked_at=None, key=None, ok=False, reason="GEMINI_API_KEY not set")
        return False
    now = time.monotonic()
    if _state["checked_at"] is not None and _state["key"] == key and now - _state["checked_at"] < _TTL_SECONDS:
        return _state["ok"]
    try:
        _client().models.get(model=model_name())  # a real, cheap call
        _state.update(ok=True, reason=None)
    except Exception as exc:
        _state.update(ok=False, reason=f"Gemini test call failed: {type(exc).__name__}: {exc}")
    _state.update(checked_at=now, key=key)
    return _state["ok"]


def status() -> dict:
    return {"enabled": is_enabled(), "model": model_name(), "reason": _state["reason"]}


PROMPT = """You rewrite one decision record from a football betting research tool
(paper trading only) in plain English for a non-expert judge.

Rules:
- Use only the information in the record. Do not add anything.
- Do not write any digits or numbers at all: no odds, percentages, probabilities, stakes,
  scores, dates or thresholds. Say "the threshold", "the price", "our probability" instead.
- Do not mention team news, injuries, form, history or predictions about the match.
- Do not recommend betting. At most three short sentences.

Decision record (JSON):
{record}
"""


def explain(record: dict, team_names: list[str]) -> dict:
    """Return {available, text, reason} for the Explain button."""
    if not is_enabled():
        return {"available": False, "text": None, "reason": _state["reason"] or "Gemini not available"}
    try:
        resp = _client().models.generate_content(
            model=model_name(), contents=PROMPT.format(record=json.dumps(record, indent=2))
        )
        text = (getattr(resp, "text", None) or "").strip()
    except Exception as exc:
        return {"available": False, "text": None, "reason": f"Gemini call failed: {type(exc).__name__}"}
    if not text:
        return {"available": False, "text": None, "reason": "Gemini returned an empty answer"}
    scrubbed = text
    for name in team_names:
        if name:
            scrubbed = scrubbed.replace(name, "")
    if re.search(r"\d", scrubbed):
        return {"available": False, "text": None,
                "reason": "Gemini's answer contained numbers, so it was discarded (it may only rephrase)."}
    return {"available": True, "text": text}

"""Create the one-time, validation-only frozen configuration for holdout."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from contract import decisions as D
from contract import schemas as S

_UNSET = object()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _trial_count(path: Path) -> int:
    if not path.is_file():
        raise ValueError(f"trial log not found: {path}")
    count = 0
    parts: set[int] = set()

    def reject_nonstandard_constant(value: str) -> None:
        raise ValueError(f"non-standard JSON number {value}")

    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line, parse_constant=reject_nonstandard_constant)
        except (json.JSONDecodeError, ValueError) as exc:
            raise ValueError(f"invalid JSON in {path} on line {number}: {exc}") from exc
        if not isinstance(record, dict):
            raise ValueError(f"trial log line {number} must contain a JSON object")
        if not isinstance(record.get("time"), str) or not record["time"].strip():
            raise ValueError(f"trial log line {number} must include its trial time")
        if not isinstance(record.get("what_changed"), str) or not record["what_changed"].strip():
            raise ValueError(f"trial log line {number} must describe what changed")
        part = record.get("part")
        if isinstance(part, bool) or str(part) not in {"1", "2"}:
            raise ValueError(f"trial log line {number} must identify part 1 or part 2")
        part_number = int(part)
        if part_number == 1:
            if record.get("split") != "validation" or not isinstance(record.get("validation_metrics"), dict):
                raise ValueError(f"trial log line {number} must include Part 1 validation metrics")
        else:
            value = record.get("val_log_loss")
            if (not isinstance(value, (int, float)) or isinstance(value, bool)
                    or not math.isfinite(value)):
                raise ValueError(f"trial log line {number} must include a finite Part 2 val_log_loss")
        parts.add(part_number)
        count += 1
    if count < 1:
        raise ValueError("trial log must contain at least one recorded trial")
    if parts != {1, 2}:
        missing = ", ".join(f"part {part}" for part in sorted({1, 2} - parts))
        raise ValueError(f"trial log must merge model and policy trials; missing {missing}")
    return count


def make_frozen_config(
    *,
    model_id: str,
    model_version: str,
    policy: dict[str, Any],
    n_trials_logged: int,
    frozen_at_utc: str | None | object = _UNSET,
) -> dict[str, Any]:
    """Build the contract v1.2.0 config and its canonical 12-character hash."""
    if model_id not in S.MODEL_IDS:
        raise ValueError(f"model_id must be one of {', '.join(S.MODEL_IDS)}")
    if not isinstance(model_version, str) or not model_version.strip():
        raise ValueError("model_version must be a non-empty string")
    if not isinstance(policy, dict):
        raise ValueError("policy must be a JSON object")
    unknown = set(policy) - set(D.DEFAULT_POLICY)
    if unknown:
        raise ValueError(f"unknown policy field(s): {', '.join(sorted(unknown))}")
    if not isinstance(n_trials_logged, int) or isinstance(n_trials_logged, bool) or n_trials_logged < 1:
        raise ValueError("n_trials_logged must be a positive integer")

    payload: dict[str, Any] = {
        "contract_version": S.CONTRACT_VERSION,
        "frozen_at_utc": _utc_now() if frozen_at_utc is _UNSET else frozen_at_utc,
        "model_id": model_id,
        "model_version": model_version.strip(),
        "policy": {**D.DEFAULT_POLICY, **policy},
        "chosen_using": ["validation"],
        "n_trials_logged": n_trials_logged,
    }
    canonical = json.dumps(payload, sort_keys=True).encode("utf-8")
    payload["config_hash"] = hashlib.sha256(canonical).hexdigest()[:12]
    return payload


def freeze_to_file(
    *,
    model_id: str,
    model_version: str,
    policy: dict[str, Any],
    trials_log: Path,
    output: Path,
) -> dict[str, Any]:
    """Write a frozen config once; refuse to overwrite an existing freeze."""
    config = make_frozen_config(
        model_id=model_id,
        model_version=model_version,
        policy=policy,
        n_trials_logged=_trial_count(trials_log),
    )
    output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with output.open("x", encoding="utf-8") as stream:
            json.dump(config, stream, indent=2, sort_keys=True)
            stream.write("\n")
    except FileExistsError as exc:
        raise FileExistsError(f"refusing to overwrite frozen config: {output}") from exc
    return config


def main() -> None:
    artifacts_dir = Path(os.getenv("ARTIFACTS_DIR", "./artifacts"))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", required=True, choices=S.MODEL_IDS, help="Model selected by Part 2 using validation only.")
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--policy-json", type=Path, help="Optional JSON object with the team's selected policy settings; defaults to the contract policy.")
    parser.add_argument("--trials-log", type=Path, default=artifacts_dir / "trials_log.jsonl")
    parser.add_argument("--output", type=Path, default=artifacts_dir / "frozen_config.json")
    args = parser.parse_args()
    try:
        policy = json.loads(args.policy_json.read_text(encoding="utf-8")) if args.policy_json else {}
        config = freeze_to_file(
            model_id=args.model,
            model_version=args.model_version,
            policy=policy,
            trials_log=args.trials_log,
            output=args.output,
        )
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        parser.error(str(exc))
    print(json.dumps({"output": str(args.output), "config_hash": config["config_hash"],
                      "model_id": config["model_id"], "model_version": config["model_version"],
                      "n_trials_logged": config["n_trials_logged"]}, indent=2))


if __name__ == "__main__":
    main()

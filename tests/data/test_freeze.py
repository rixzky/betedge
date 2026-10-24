import json
from pathlib import Path

import pytest

from decisions.freeze import freeze_to_file, make_frozen_config


def test_golden_frozen_config_hash_reproduces_contract_vector():
    golden = json.loads(Path("contract/golden/artifacts_json/frozen_config.json").read_text())
    config = make_frozen_config(
        model_id=golden["model_id"],
        model_version=golden["model_version"],
        policy=golden["policy"],
        n_trials_logged=golden["n_trials_logged"],
        frozen_at_utc=golden["frozen_at_utc"],
    )
    assert config == golden


def test_freeze_uses_defaults_and_counts_trial_log_once(tmp_path):
    trials = tmp_path / "trials_log.jsonl"
    trials.write_text(
        '{"part":"1","time":"2026-10-24T00:00:00Z","split":"validation",'
        '"what_changed":"initial policy","validation_metrics":{"roi":0.0}}\n'
        '{"part":"2","time":"2026-10-24T00:00:00Z","what_changed":"model trial",'
        '"val_log_loss":0.9}\n'
    )
    output = tmp_path / "artifacts" / "frozen_config.json"
    config = freeze_to_file(
        model_id="elo", model_version="elo-v2", policy={"min_ev": 0.03},
        trials_log=trials, output=output,
    )
    assert config["n_trials_logged"] == 2
    assert config["policy"]["min_ev"] == 0.03
    assert config["policy"]["initial_bankroll"] == 1000.0
    assert json.loads(output.read_text()) == config
    with pytest.raises(FileExistsError, match="refusing to overwrite"):
        freeze_to_file(
            model_id="elo", model_version="elo-v2", policy={"min_ev": 0.03},
            trials_log=trials, output=output,
        )


def test_freeze_rejects_unknown_policy_keys_and_invalid_trials(tmp_path):
    with pytest.raises(ValueError, match="unknown policy field"):
        make_frozen_config(model_id="elo", model_version="v1", policy={"roi_target": 0.1}, n_trials_logged=1)
    with pytest.raises(ValueError, match="positive integer"):
        make_frozen_config(model_id="elo", model_version="v1", policy={}, n_trials_logged=0)
    log = tmp_path / "trials_log.jsonl"
    log.write_text("not json\n")
    with pytest.raises(ValueError, match="invalid JSON"):
        freeze_to_file(model_id="elo", model_version="v1", policy={}, trials_log=log,
                       output=tmp_path / "frozen_config.json")


def test_freeze_requires_trials_from_both_parts(tmp_path):
    log = tmp_path / "trials_log.jsonl"
    log.write_text('{"part":2,"time":"now","what_changed":"model trial","val_log_loss":0.9}\n')
    with pytest.raises(ValueError, match="missing part 1"):
        freeze_to_file(model_id="marketnet", model_version="mn-1.1", policy={},
                       trials_log=log, output=tmp_path / "frozen_config.json")


def test_freeze_rejects_part2_trial_without_finite_validation_metric(tmp_path):
    log = tmp_path / "trials_log.jsonl"
    log.write_text('{"part":2,"time":"now","what_changed":"model trial","val_log_loss":null}\n')
    with pytest.raises(ValueError, match="finite Part 2 val_log_loss"):
        freeze_to_file(model_id="marketnet", model_version="mn-1.1", policy={},
                       trials_log=log, output=tmp_path / "frozen_config.json")


def test_freeze_rejects_nonstandard_json_numbers(tmp_path):
    log = tmp_path / "trials_log.jsonl"
    log.write_text('{"part":2,"time":"now","what_changed":"model trial","val_log_loss":Infinity}\n')
    with pytest.raises(ValueError, match="invalid JSON.*non-standard JSON number Infinity"):
        freeze_to_file(model_id="marketnet", model_version="mn-1.1", policy={},
                       trials_log=log, output=tmp_path / "frozen_config.json")

import json

import pytest

from phosphor_spacetime.cli import main


def test_demo_controls_realized_rate_and_preserves_event_jump_state(capsys):
    assert main(["temporal-demo", "--rate", "2.5", "--quanta", "20"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["receipt_status"] == "CONFIRMED"
    assert result["realized_rate"] == 2.5
    assert result["logical_tick"] == 50
    assert result["state"] == {"counter": 2, "phase": "complete"}
    assert result["state_hash_equal"] is True
    assert result["event_jump_tick_iterations"] == 0
    assert result["idle_ticks_skipped"] == 47


def test_demo_zero_rate_freezes_logical_progress(capsys):
    assert main(["temporal-demo", "--rate", "0"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert result["logical_tick"] == 0
    assert result["state"] == {}
    assert result["state_hash_equal"] is True


@pytest.mark.parametrize("rate", ["nan", "inf", "-1", "21"])
def test_demo_rejects_invalid_rates_before_actuation(rate):
    with pytest.raises(SystemExit) as exc:
        main(["temporal-demo", "--rate", rate])
    assert exc.value.code == 2

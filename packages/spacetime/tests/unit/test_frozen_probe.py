import sys

from phosphor_spacetime.processes import PROBE_CHILD_ARGUMENT, observation_probe_command


def test_frozen_probe_launches_application_worker_instead_of_python_interpreter(monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert observation_probe_command() == [sys.executable, PROBE_CHILD_ARGUMENT]


def test_source_probe_uses_python_interpreter(monkeypatch):
    monkeypatch.delattr(sys, "frozen", raising=False)
    assert observation_probe_command() == [sys.executable, "-c", "import time; time.sleep(5)"]

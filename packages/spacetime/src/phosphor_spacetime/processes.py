"""Start the owned observation probe in Python and frozen distributions."""
from __future__ import annotations

import subprocess
import sys

PROBE_CHILD_ARGUMENT = "--_pss-observation-probe"


def observation_probe_command() -> list[str]:
    if getattr(sys, "frozen", False):
        return [sys.executable, PROBE_CHILD_ARGUMENT]
    return [sys.executable, "-c", "import time; time.sleep(5)"]


def spawn_observation_probe() -> subprocess.Popen:
    options = {}
    if sys.platform == "win32":
        options["creationflags"] = subprocess.CREATE_NO_WINDOW
    return subprocess.Popen(observation_probe_command(), **options)

from __future__ import annotations

import tomllib
from pathlib import Path

import phosphor_spacetime


def test_package_version_matches_pyproject_and_cli_is_exposed():
    root = Path(__file__).resolve().parents[2]
    with (root / "pyproject.toml").open("rb") as f:
        project = tomllib.load(f)["project"]

    assert phosphor_spacetime.__version__ == project["version"]
    assert project["scripts"]["pss"] == "phosphor_spacetime.cli:main"

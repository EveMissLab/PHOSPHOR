"""Portable console entry: normal CLI arguments or a double-click menu."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

from phosphor_spacetime.cli import main
from phosphor_spacetime.processes import PROBE_CHILD_ARGUMENT


def menu() -> int:
    print("PHOSPHOR Spacetime 0.1.0a9 / Windows x64 Preview")
    print("時空間版本不是作弊引擎。")
    print("Spacetime edition is not a cheat engine.")
    print("\n1  Temporal demo / 時間控制示範")
    print("2  B0-B3 benchmark matrix")
    print("3  Gate 0-6")
    print("4  CLI help")
    print("0  Exit")
    while True:
        try:
            choice = input("\nSelect / 選擇 [0-4]: ").strip()
        except (EOFError, KeyboardInterrupt):
            return 0
        if choice == "0":
            return 0
        args = {
            "1": ["temporal-demo", "--rate", "2.5", "--quanta", "20"],
            "2": ["matrix", "C_EVENT_SPARSE"],
            "3": ["gate", "--git-commit", "preview-2026.10.04"],
            "4": ["--help"],
        }.get(choice)
        if args is None:
            continue
        try:
            code = main(args)
            print(f"\nExit code: {code}")
        except SystemExit as exc:
            if exc.code not in (None, 0):
                print(f"Exit code: {exc.code}")
        except Exception as exc:
            print(f"{type(exc).__name__}: {exc}")


def entry() -> int:
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")
    if sys.argv[1:] == [PROBE_CHILD_ARGUMENT]:
        time.sleep(5)
        return 0
    if len(sys.argv) > 1:
        return main(sys.argv[1:])
    return menu()


if __name__ == "__main__":
    raise SystemExit(entry())

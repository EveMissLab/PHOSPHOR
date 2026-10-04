# Windows x64 distribution

The release includes `PHOSPHOR-Spacetime.exe`. It contains its Python runtime and JSON schemas; users do not need to install Python.

Double-click the EXE for the console menu, or run it in PowerShell:

```powershell
.\PHOSPHOR-Spacetime.exe temporal-demo --rate 2.5 --quanta 20
.\PHOSPHOR-Spacetime.exe matrix C_EVENT_SPARSE
.\PHOSPHOR-Spacetime.exe gate --git-commit preview-2026.10.04
```

Run artifacts are written to `runs/` in the current directory. Use a writable folder. The EXE is an unsigned Preview build.

Build from a Windows x64 Python >= 3.12 environment:

```powershell
python -m pip install -e ".[dev]"
python -m pip install -r packaging/requirements-build.txt
python -m PyInstaller packaging/spacetime.spec --noconfirm --distpath dist --workpath build
```

PyInstaller's frozen child-process mode is handled explicitly, so Gate 1 creates an owned probe process without assuming an installed Python interpreter.

時空間版本不是作弊引擎。

Spacetime edition is not a cheat engine.

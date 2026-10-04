from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files

package_root = Path(SPECPATH).parent
a = Analysis(
    [str(Path(SPECPATH) / "windows_entry.py")],
    pathex=[str(package_root / "src")],
    binaries=[],
    datas=collect_data_files("phosphor_spacetime"),
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["pytest", "tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz, a.scripts, a.binaries, a.datas,
    [("X utf8", None, "OPTION")],
    name="PHOSPHOR-Spacetime",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
)

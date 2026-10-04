"""Build deterministic source downloads without local state or Git history."""
from __future__ import annotations

import hashlib
import json
import os
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "packages/eai/web/public/download"
IGNORED = {".git", ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", "build", "dist", "dist-single", "traces", "runs", ".claude", ".codex"}
ARCHIVES = {
    "phosphor-preview-source.zip": ROOT,
    "phosphor-eai-v0.8.0-beta-source.zip": ROOT / "packages/eai",
    "phosphor-spacetime-v0.1.0a9-source.zip": ROOT / "packages/spacetime",
    "phosphor-mccp-v0.0.1-source.zip": ROOT / "packages/mccp",
}


def source_files(root: Path):
    for directory, dirs, names in os.walk(root):
        base = Path(directory)
        dirs[:] = sorted(d for d in dirs if d not in IGNORED and not d.endswith(".egg-info") and base / d != OUTPUT)
        for name in sorted(names):
            path = base / name
            if path.is_symlink():
                raise ValueError("Source export does not accept symlinks")
            if name.startswith(".env") and name != ".env.example":
                continue
            if path.suffix in {".pyc", ".log", ".exe", ".blob"}:
                continue
            yield path


def build() -> None:
    OUTPUT.mkdir(parents=True, exist_ok=True)
    entries = []
    for name, root in ARCHIVES.items():
        target = OUTPUT / name
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as bundle:
            count = 0
            for path in source_files(root):
                data = path.read_bytes()
                try:
                    data = data.decode("utf-8").replace("\r\n", "\n").encode("utf-8")
                except UnicodeDecodeError:
                    pass
                info = zipfile.ZipInfo(path.relative_to(root).as_posix(), date_time=(2026, 10, 4, 0, 0, 0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                bundle.writestr(info, data)
                count += 1
        data = target.read_bytes()
        entries.append({"path": "/download/" + name, "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest(), "source_files": count})
    manifest = {"schema_version": "phosphor-source-downloads-v1", "channel": "preview", "generated": "2026-10-04", "archives": entries}
    (OUTPUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    build()

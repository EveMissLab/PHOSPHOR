from __future__ import annotations

from copy import deepcopy
from typing import Any, Iterator

from pydantic import BaseModel

from .models import SpacetimeSnapshot
from .patch import IRPatch


def _leaf_paths(prefix: str, value: Any) -> Iterator[tuple[str, Any]]:
    if isinstance(value, dict):
        for key, child in value.items():
            path = f"{prefix}.{key}" if prefix else key
            yield from _leaf_paths(path, child)
        return
    yield prefix, value


def _read_path(root: Any, path: str) -> Any:
    current = root
    for part in path.split("."):
        if isinstance(current, BaseModel):
            current = getattr(current, part)
        elif isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


def _write_path(root: Any, path: str, value: Any) -> None:
    parts = path.split(".")
    current = root
    for part in parts[:-1]:
        if isinstance(current, BaseModel):
            current = getattr(current, part)
        elif isinstance(current, dict):
            current = current.setdefault(part, {})
        else:
            raise TypeError(f"cannot traverse {path!r}")
    last = parts[-1]
    if isinstance(current, BaseModel):
        setattr(current, last, value)
    elif isinstance(current, dict):
        current[last] = value
    else:
        raise TypeError(f"cannot write {path!r}")


def apply_patch(snapshot: SpacetimeSnapshot, patch: IRPatch) -> SpacetimeSnapshot:
    """Apply a derived observation patch without silently overwriting disagreements."""
    updated = snapshot.model_copy(deep=True)
    domain = updated.get_domain(patch.domain_id)
    domain.observation = deepcopy(domain.observation)
    field_sources = domain.observation.setdefault("_field_sources", {})
    conflicts = domain.observation.setdefault("conflicts", [])

    for path, incoming in _leaf_paths("", patch.fields):
        existing = _read_path(domain, path)
        existing_source = field_sources.get(path)
        if existing_source is None:
            _write_path(domain, path, incoming)
            field_sources[path] = patch.source
            continue
        if existing_source == patch.source:
            _write_path(domain, path, incoming)
            continue
        if existing == incoming:
            continue
        conflicts.append({"path": path, "existing": existing, "incoming": incoming, "existing_source": existing_source, "incoming_source": patch.source, "epistemic_level": patch.epistemic_level, "timestamp": patch.timestamp.isoformat(), "evidence_refs": [ref.model_dump(mode="json") for ref in patch.evidence_refs]})

    if patch.evidence_refs:
        known = {(r.source, r.id, r.kind) for r in domain.evidence_refs}
        for ref in patch.evidence_refs:
            key = (ref.source, ref.id, ref.kind)
            if key not in known:
                domain.evidence_refs.append(ref)
                known.add(key)
    return updated

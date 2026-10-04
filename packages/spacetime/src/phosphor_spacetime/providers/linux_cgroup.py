from __future__ import annotations

import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Protocol
from uuid import uuid4

from phosphor_spacetime.control.intent import CommandIntent
from phosphor_spacetime.control.receipts import ActuationReceipt, ProviderRef
from phosphor_spacetime.control.validator import CapabilitySpec

_DEVICE_RE = re.compile(r"^\d+:\d+$")
_IO_KEYS = ("rbps", "wbps", "riops", "wiops")


class CgroupV2Backend(Protocol):
    def create_group(self, name: str) -> object: ...
    def remove_group(self, group: object) -> None: ...
    def attach_process(self, group: object, pid: int) -> None: ...
    def read(self, group: object, filename: str) -> str | None: ...
    def write(self, group: object, filename: str, value: str) -> None: ...
    def exists(self, group: object, filename: str) -> bool: ...


@dataclass
class _LinuxTarget:
    domain_id: str
    pid: int
    group: object
    spawned_by_mvp: bool
    allowlisted: bool


class NativeCgroupV2Backend:
    """Thin filesystem-backed cgroup v2 adapter for one dedicated subtree."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        if not self.root.exists():
            raise FileNotFoundError(f"cgroup test root does not exist: {self.root}")
        if not (self.root / "cgroup.procs").exists() and not (self.root / "cgroup.controllers").exists():
            raise RuntimeError(f"path does not look like cgroup v2: {self.root}")

    @staticmethod
    def _safe_name(name: str) -> str:
        safe = re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip("-.")
        if not safe:
            raise ValueError("cgroup name has no safe characters")
        return safe[:120]

    def create_group(self, name: str) -> object:
        path = self.root / self._safe_name(name)
        path.mkdir(exist_ok=False)
        return path

    def remove_group(self, group: object) -> None:
        path = Path(group)
        try:
            path.rmdir()
        except FileNotFoundError:
            return

    def attach_process(self, group: object, pid: int) -> None:
        self.write(group, "cgroup.procs", str(pid))

    def read(self, group: object, filename: str) -> str | None:
        path = Path(group) / filename
        if not path.exists():
            return None
        return path.read_text(encoding="utf-8").strip()

    def write(self, group: object, filename: str, value: str) -> None:
        path = Path(group) / filename
        if not path.exists():
            raise FileNotFoundError(f"cgroup control unavailable: {filename}")
        path.write_text(f"{value}\n", encoding="utf-8")

    def exists(self, group: object, filename: str) -> bool:
        return (Path(group) / filename).exists()


class FakeCgroupV2Backend:
    """Deterministic in-memory cgroup v2 backend for contract tests."""

    def __init__(self) -> None:
        self.groups: dict[str, dict[str, str]] = {}
        self.next_id = 1

    def create_group(self, name: str) -> object:
        group = f"cg:{self.next_id}:{name}"
        self.next_id += 1
        self.groups[group] = {
            "cgroup.procs": "",
            "cpu.weight": "100",
            "cpu.max": "max 100000",
            "memory.max": "max",
            "io.weight": "default 100",
            "io.max": "",
            "cgroup.freeze": "0",
            "cgroup.events": "populated 0\nfrozen 0",
        }
        return group

    def remove_group(self, group: object) -> None:
        self.groups.pop(str(group), None)

    def attach_process(self, group: object, pid: int) -> None:
        key = str(group)
        self.groups[key]["cgroup.procs"] = str(pid)
        frozen = "1" if self.groups[key]["cgroup.freeze"] == "1" else "0"
        self.groups[key]["cgroup.events"] = f"populated 1\nfrozen {frozen}"

    def read(self, group: object, filename: str) -> str | None:
        return self.groups[str(group)].get(filename)

    def write(self, group: object, filename: str, value: str) -> None:
        key = str(group)
        if filename not in self.groups[key]:
            raise FileNotFoundError(f"cgroup control unavailable: {filename}")
        self.groups[key][filename] = str(value)
        if filename == "cgroup.freeze":
            populated = "1" if self.groups[key]["cgroup.procs"] else "0"
            self.groups[key]["cgroup.events"] = f"populated {populated}\nfrozen {value}"

    def exists(self, group: object, filename: str) -> bool:
        return filename in self.groups[str(group)]


def _parse_flat_int(raw: str | None) -> int | None:
    if raw is None or raw == "max" or raw == "":
        return None
    return int(raw.split()[0])


def _parse_cpu_max(raw: str | None) -> dict | None:
    if raw is None:
        return None
    parts = raw.split()
    if len(parts) != 2:
        raise ValueError(f"unexpected cpu.max format: {raw!r}")
    quota = None if parts[0] == "max" else int(parts[0])
    return {"quota_us": quota, "period_us": int(parts[1])}


def _parse_io_weight(raw: str | None) -> int | None:
    if not raw:
        return None
    first = raw.splitlines()[0].split()
    if len(first) == 1:
        return int(first[0])
    if first[0] == "default":
        return int(first[1])
    return None


def _parse_io_max(raw: str | None) -> dict[str, dict[str, int | str]]:
    result: dict[str, dict[str, int | str]] = {}
    if not raw:
        return result
    for line in raw.splitlines():
        parts = line.split()
        if not parts:
            continue
        device = parts[0]
        values: dict[str, int | str] = {}
        for item in parts[1:]:
            if "=" not in item:
                continue
            key, value = item.split("=", 1)
            if key in _IO_KEYS:
                values[key] = value if value == "max" else int(value)
        result[device] = values
    return result


def _parse_frozen(raw: str | None) -> bool | None:
    if raw is None:
        return None
    for line in raw.splitlines():
        parts = line.split()
        if len(parts) == 2 and parts[0] == "frozen":
            return parts[1] == "1"
    return None


def _format_io_max(spec: dict) -> str:
    device = spec.get("device")
    if not isinstance(device, str) or not _DEVICE_RE.fullmatch(device):
        raise ValueError("io_max.device must be a major:minor device identifier")
    fields: list[str] = []
    for key in _IO_KEYS:
        if key not in spec:
            continue
        value = spec[key]
        if value != "max" and (not isinstance(value, int) or isinstance(value, bool) or value < 1):
            raise ValueError(f"io_max.{key} must be positive integer or 'max'")
        fields.append(f"{key}={value}")
    if not fields:
        raise ValueError("io_max requires at least one limit field")
    return " ".join([device, *fields])


class CgroupV2Provider:
    """Bounded cgroup v2 provider for a dedicated test subtree."""

    def __init__(
        self,
        *,
        backend: CgroupV2Backend | None = None,
        root: Path | None = None,
        provider_id: str = "linux-cgroup-v2:local",
        epoch: int = 1,
        health: str = "HEALTHY",
    ) -> None:
        if backend is None:
            if root is None:
                raise ValueError("root is required when no cgroup backend is supplied")
            backend = NativeCgroupV2Backend(root)
        self._backend = backend
        self._provider_ref = ProviderRef(
            provider_id=provider_id,
            instance_id=f"{provider_id}:{uuid4()}",
            epoch=epoch,
        )
        self._health = health
        self._targets: dict[str, _LinuxTarget] = {}

    @property
    def provider_ref(self) -> ProviderRef:
        return self._provider_ref

    @property
    def health(self) -> str:
        return self._health

    def capability_for(self, action: str) -> CapabilitySpec | None:
        epoch = self.provider_ref.epoch
        if action == "domain.inspect":
            return CapabilitySpec(name=action, support="SUPPORTED", provider_epoch=epoch)
        if action == "domain.set_resource_budget":
            return CapabilitySpec(
                name=action,
                support="PARTIAL",
                provider_epoch=epoch,
                bounds={
                    "cpu_weight": {"min": 1, "max": 10000},
                    "cpu_quota_us": {"min": 1},
                    "cpu_period_us": {"min": 1000, "max": 1000000},
                    "memory_max_bytes": {"min": 1},
                    "io_weight": {"min": 1, "max": 10000},
                },
                projection_semantics="cgroup_v2_resource_subcontrols",
            )
        if action in {"domain.pause", "domain.resume"}:
            return CapabilitySpec(
                name=action,
                support="SUPPORTED",
                provider_epoch=epoch,
                projection_semantics="cgroup.freeze",
            )
        if action == "domain.set_temporal_rate":
            return CapabilitySpec(
                name=action,
                support="UNSUPPORTED",
                provider_epoch=epoch,
                projection_semantics="CPUServiceRate != LogicalTimeRate",
            )
        return CapabilitySpec(name=action, support="UNSUPPORTED", provider_epoch=epoch)

    def register_target(
        self,
        domain_id: str,
        pid: int,
        *,
        spawned_by_mvp: bool = False,
        allowlisted: bool = False,
    ) -> None:
        if not (spawned_by_mvp or allowlisted):
            raise PermissionError("target must be spawned by the MVP or explicitly allowlisted")
        if pid <= 0:
            raise ValueError("pid must be positive")
        if domain_id in self._targets:
            raise ValueError(f"target already registered: {domain_id}")
        group = self._backend.create_group(f"pss-{domain_id}")
        try:
            self._backend.attach_process(group, pid)
        except Exception:
            self._backend.remove_group(group)
            raise
        self._targets[domain_id] = _LinuxTarget(
            domain_id=domain_id,
            pid=pid,
            group=group,
            spawned_by_mvp=spawned_by_mvp,
            allowlisted=allowlisted,
        )

    def unregister_target(self, domain_id: str) -> None:
        target = self._targets.pop(domain_id, None)
        if target is not None:
            self._backend.remove_group(target.group)

    def close(self) -> None:
        for domain_id in list(self._targets):
            self.unregister_target(domain_id)

    def _target(self, domain_id: str) -> _LinuxTarget:
        try:
            return self._targets[domain_id]
        except KeyError as exc:
            raise PermissionError(f"target is not registered with Linux provider: {domain_id}") from exc

    def inspect(self, target_domain_id: str) -> dict:
        target = self._target(target_domain_id)
        io_max = _parse_io_max(self._backend.read(target.group, "io.max")) if self._backend.exists(target.group, "io.max") else {}
        return {
            "pid": target.pid,
            "cpu_weight": _parse_flat_int(self._backend.read(target.group, "cpu.weight")) if self._backend.exists(target.group, "cpu.weight") else None,
            "cpu_max": _parse_cpu_max(self._backend.read(target.group, "cpu.max")) if self._backend.exists(target.group, "cpu.max") else None,
            "memory_max_bytes": _parse_flat_int(self._backend.read(target.group, "memory.max")) if self._backend.exists(target.group, "memory.max") else None,
            "io_weight": _parse_io_weight(self._backend.read(target.group, "io.weight")) if self._backend.exists(target.group, "io.weight") else None,
            "io_max": io_max,
            "frozen": _parse_frozen(self._backend.read(target.group, "cgroup.events")) if self._backend.exists(target.group, "cgroup.events") else None,
        }

    def _write_required(self, target: _LinuxTarget, filename: str, value: str) -> None:
        if not self._backend.exists(target.group, filename):
            raise FileNotFoundError(f"required cgroup control unavailable: {filename}")
        self._backend.write(target.group, filename, value)

    def _wait_frozen(self, target: _LinuxTarget, expected: bool, timeout_s: float = 1.0) -> None:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            state = _parse_frozen(self._backend.read(target.group, "cgroup.events"))
            if state is expected:
                return
            time.sleep(0.01)
        raise TimeoutError(f"cgroup.freeze did not reach expected state {expected}")

    def apply(self, intent: CommandIntent) -> ActuationReceipt:
        target = self._target(intent.target_domain_id)
        before = self.inspect(intent.target_domain_id)

        if intent.action == "domain.set_resource_budget":
            args = intent.arguments
            if not args:
                raise ValueError("resource-budget intent requires at least one resource field")
            allowed = {
                "cpu_weight",
                "cpu_quota_us",
                "cpu_period_us",
                "memory_max_bytes",
                "io_weight",
                "io_max",
            }
            unknown = set(args) - allowed
            if unknown:
                raise ValueError(f"unsupported cgroup resource fields: {sorted(unknown)}")
            if "io_max" in args:
                _format_io_max(args["io_max"])
            if "cpu_weight" in args:
                self._write_required(target, "cpu.weight", str(int(args["cpu_weight"])))
            if "cpu_quota_us" in args or "cpu_period_us" in args:
                current = before.get("cpu_max") or {"quota_us": None, "period_us": 100000}
                current_quota = current["quota_us"]
                quota_value = args.get("cpu_quota_us", current_quota)
                quota_token = "max" if quota_value is None else str(int(quota_value))
                period = int(args.get("cpu_period_us", current["period_us"]))
                self._write_required(target, "cpu.max", f"{quota_token} {period}")
            if "memory_max_bytes" in args:
                self._write_required(target, "memory.max", str(int(args["memory_max_bytes"])))
            if "io_weight" in args:
                self._write_required(target, "io.weight", f"default {int(args['io_weight'])}")
            if "io_max" in args:
                self._write_required(target, "io.max", _format_io_max(args["io_max"]))
        elif intent.action == "domain.pause":
            self._write_required(target, "cgroup.freeze", "1")
            self._wait_frozen(target, True)
        elif intent.action == "domain.resume":
            self._write_required(target, "cgroup.freeze", "0")
            self._wait_frozen(target, False)
        elif intent.action == "domain.inspect":
            pass
        else:
            raise ValueError(f"unsupported Linux cgroup action: {intent.action}")

        realized = self.inspect(intent.target_domain_id)
        now = datetime.now(timezone.utc)
        return ActuationReceipt(
            receipt_id=f"receipt:{uuid4()}",
            command_id=intent.command_id,
            provider=self.provider_ref,
            status="CONFIRMED",
            started_at=now,
            finished_at=now,
            before=before,
            requested={
                "target_domain_id": intent.target_domain_id,
                "action": intent.action,
                "arguments": dict(intent.arguments),
            },
            realized=realized,
            observed_after=None,
            actuation_skew=None,
            fence_epoch=self.provider_ref.epoch,
            idempotency_key=intent.idempotency_key,
            evidence_refs=[],
        )

    def verify(self, receipt: ActuationReceipt) -> tuple[bool, dict]:
        target_domain_id = receipt.requested.get("target_domain_id")
        if not isinstance(target_domain_id, str):
            return False, {}
        observed = self.inspect(target_domain_id)
        realized = receipt.realized or {}
        match = all(observed.get(key) == value for key, value in realized.items())
        return match, observed

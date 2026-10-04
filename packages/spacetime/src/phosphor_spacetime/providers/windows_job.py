from __future__ import annotations

import ctypes
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Protocol
from uuid import uuid4

import psutil

from phosphor_spacetime.control.intent import CommandIntent
from phosphor_spacetime.control.receipts import ActuationReceipt, ProviderRef
from phosphor_spacetime.control.validator import CapabilitySpec


class WindowsJobBackend(Protocol):
    def create_job(self, name: str) -> object: ...
    def close_job(self, job: object) -> None: ...
    def assign_process(self, job: object, pid: int) -> None: ...
    def set_cpu_hard_cap(self, job: object, fraction: float) -> None: ...
    def query_cpu_policy(self, job: object) -> dict | None: ...
    def set_job_memory_limit(self, job: object, limit_bytes: int) -> None: ...
    def query_job_memory_limit(self, job: object) -> int | None: ...
    def suspend_process(self, pid: int) -> None: ...
    def resume_process(self, pid: int) -> None: ...
    def query_process_suspended(self, pid: int) -> bool | None: ...


@dataclass
class _WindowsTarget:
    domain_id: str
    pid: int
    job: object
    spawned_by_mvp: bool
    allowlisted: bool


class _NativeWindowsJobBackend:
    """Thin documented Win32 Job Object wrapper used only on Windows."""

    JOB_OBJECT_CPU_RATE_CONTROL_ENABLE = 0x1
    JOB_OBJECT_CPU_RATE_CONTROL_WEIGHT_BASED = 0x2
    JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP = 0x4
    JOB_OBJECT_CPU_RATE_CONTROL_MIN_MAX_RATE = 0x10
    JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200

    JobObjectExtendedLimitInformation = 9
    JobObjectCpuRateControlInformation = 15

    PROCESS_TERMINATE = 0x0001
    PROCESS_SET_QUOTA = 0x0100

    def __init__(self) -> None:
        if sys.platform != "win32":
            raise RuntimeError("native Windows Job Object backend is available only on Windows")

        from ctypes import wintypes

        class _MIN_MAX_RATE(ctypes.Structure):
            _fields_ = [("MinRate", wintypes.WORD), ("MaxRate", wintypes.WORD)]

        class _CPU_RATE_UNION(ctypes.Union):
            _fields_ = [
                ("CpuRate", wintypes.DWORD),
                ("Weight", wintypes.DWORD),
                ("MinMaxRate", _MIN_MAX_RATE),
            ]

        class _CPU_RATE_INFORMATION(ctypes.Structure):
            _anonymous_ = ("Rate",)
            _fields_ = [("ControlFlags", wintypes.DWORD), ("Rate", _CPU_RATE_UNION)]

        class _BASIC_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_longlong),
                ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.c_size_t),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _IO_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("ReadOperationCount", ctypes.c_ulonglong),
                ("WriteOperationCount", ctypes.c_ulonglong),
                ("OtherOperationCount", ctypes.c_ulonglong),
                ("ReadTransferCount", ctypes.c_ulonglong),
                ("WriteTransferCount", ctypes.c_ulonglong),
                ("OtherTransferCount", ctypes.c_ulonglong),
            ]

        class _EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _BASIC_LIMIT_INFORMATION),
                ("IoInfo", _IO_COUNTERS),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        self._wintypes = wintypes
        self._CPU_RATE_INFORMATION = _CPU_RATE_INFORMATION
        self._EXTENDED_LIMIT_INFORMATION = _EXTENDED_LIMIT_INFORMATION
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)

        self._kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        self._kernel32.CreateJobObjectW.restype = wintypes.HANDLE
        self._kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self._kernel32.OpenProcess.restype = wintypes.HANDLE
        self._kernel32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        self._kernel32.AssignProcessToJobObject.restype = wintypes.BOOL
        self._kernel32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
        self._kernel32.SetInformationJobObject.restype = wintypes.BOOL
        self._kernel32.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
        self._kernel32.QueryInformationJobObject.restype = wintypes.BOOL
        self._kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
        self._kernel32.CloseHandle.restype = wintypes.BOOL

    @staticmethod
    def _raise_last_error(prefix: str) -> None:
        error = ctypes.get_last_error()
        raise OSError(error, f"{prefix}: {ctypes.FormatError(error)}")

    def create_job(self, name: str) -> object:
        handle = self._kernel32.CreateJobObjectW(None, name)
        if not handle:
            self._raise_last_error("CreateJobObjectW failed")
        return handle

    def close_job(self, job: object) -> None:
        if job and not self._kernel32.CloseHandle(job):
            self._raise_last_error("CloseHandle(job) failed")

    def assign_process(self, job: object, pid: int) -> None:
        access = self.PROCESS_SET_QUOTA | self.PROCESS_TERMINATE
        process = self._kernel32.OpenProcess(access, False, pid)
        if not process:
            self._raise_last_error("OpenProcess failed")
        try:
            if not self._kernel32.AssignProcessToJobObject(job, process):
                self._raise_last_error("AssignProcessToJobObject failed")
        finally:
            self._kernel32.CloseHandle(process)

    def set_cpu_hard_cap(self, job: object, fraction: float) -> None:
        if not 0.01 <= fraction <= 1.0:
            raise ValueError("CPU hard-cap fraction must be within [0.01, 1.0]")
        info = self._CPU_RATE_INFORMATION()
        info.ControlFlags = self.JOB_OBJECT_CPU_RATE_CONTROL_ENABLE | self.JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP
        info.CpuRate = int(round(fraction * 10000.0))
        ok = self._kernel32.SetInformationJobObject(
            job,
            self.JobObjectCpuRateControlInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if not ok:
            self._raise_last_error("SetInformationJobObject(CPU rate) failed")

    def query_cpu_policy(self, job: object) -> dict | None:
        info = self._CPU_RATE_INFORMATION()
        returned = self._wintypes.DWORD(0)
        ok = self._kernel32.QueryInformationJobObject(
            job,
            self.JobObjectCpuRateControlInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
            ctypes.byref(returned),
        )
        if not ok:
            self._raise_last_error("QueryInformationJobObject(CPU rate) failed")
        flags = int(info.ControlFlags)
        if not flags & self.JOB_OBJECT_CPU_RATE_CONTROL_ENABLE:
            return None
        if flags & self.JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP:
            return {"mode": "hard_cap", "fraction": float(info.CpuRate) / 10000.0}
        if flags & self.JOB_OBJECT_CPU_RATE_CONTROL_WEIGHT_BASED:
            return {"mode": "weight", "weight": int(info.Weight)}
        if flags & self.JOB_OBJECT_CPU_RATE_CONTROL_MIN_MAX_RATE:
            return {
                "mode": "min_max",
                "min_fraction": float(info.MinMaxRate.MinRate) / 10000.0,
                "max_fraction": float(info.MinMaxRate.MaxRate) / 10000.0,
            }
        return {"mode": "enabled_unknown", "control_flags": flags}

    def _query_extended_limits(self, job: object):
        info = self._EXTENDED_LIMIT_INFORMATION()
        returned = self._wintypes.DWORD(0)
        ok = self._kernel32.QueryInformationJobObject(
            job,
            self.JobObjectExtendedLimitInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
            ctypes.byref(returned),
        )
        if not ok:
            self._raise_last_error("QueryInformationJobObject(extended limits) failed")
        return info

    def set_job_memory_limit(self, job: object, limit_bytes: int) -> None:
        if limit_bytes < 1:
            raise ValueError("job memory limit must be positive")
        info = self._query_extended_limits(job)
        info.BasicLimitInformation.LimitFlags |= self.JOB_OBJECT_LIMIT_JOB_MEMORY
        info.JobMemoryLimit = int(limit_bytes)
        ok = self._kernel32.SetInformationJobObject(
            job,
            self.JobObjectExtendedLimitInformation,
            ctypes.byref(info),
            ctypes.sizeof(info),
        )
        if not ok:
            self._raise_last_error("SetInformationJobObject(job memory) failed")

    def query_job_memory_limit(self, job: object) -> int | None:
        info = self._query_extended_limits(job)
        if not int(info.BasicLimitInformation.LimitFlags) & self.JOB_OBJECT_LIMIT_JOB_MEMORY:
            return None
        return int(info.JobMemoryLimit)

    def suspend_process(self, pid: int) -> None:
        psutil.Process(pid).suspend()

    def resume_process(self, pid: int) -> None:
        psutil.Process(pid).resume()

    def query_process_suspended(self, pid: int) -> bool | None:
        try:
            return psutil.Process(pid).status() == psutil.STATUS_STOPPED
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            return None


class WindowsJobProvider:
    """Bounded Windows provider for owned/allowlisted test processes.

    CPU and memory controls are Job Object resource semantics. Pause/resume is
    explicitly process-level PARTIAL semantics and is not logical-time control.
    """

    def __init__(
        self,
        *,
        backend: WindowsJobBackend | None = None,
        provider_id: str = "windows-job:local",
        epoch: int = 1,
        health: str = "HEALTHY",
    ) -> None:
        self._backend = backend or _NativeWindowsJobBackend()
        self._provider_ref = ProviderRef(
            provider_id=provider_id,
            instance_id=f"{provider_id}:{uuid4()}",
            epoch=epoch,
        )
        self._health = health
        self._targets: dict[str, _WindowsTarget] = {}

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
                support="SUPPORTED",
                provider_epoch=epoch,
                bounds={
                    "cpu_fraction": {"min": 0.01, "max": 1.0},
                    "job_memory_bytes": {"min": 1},
                },
                resource_semantics="job_object_policy",
            )
        if action in {"domain.pause", "domain.resume"}:
            return CapabilitySpec(
                name=action,
                support="PARTIAL",
                provider_epoch=epoch,
                projection_semantics="process_suspend_resume",
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
        job = self._backend.create_job(f"PHOSPHOR-Spacetime-{domain_id}")
        try:
            self._backend.assign_process(job, pid)
        except Exception:
            self._backend.close_job(job)
            raise
        self._targets[domain_id] = _WindowsTarget(
            domain_id=domain_id,
            pid=pid,
            job=job,
            spawned_by_mvp=spawned_by_mvp,
            allowlisted=allowlisted,
        )

    def unregister_target(self, domain_id: str) -> None:
        target = self._targets.pop(domain_id, None)
        if target is not None:
            self._backend.close_job(target.job)

    def close(self) -> None:
        for domain_id in list(self._targets):
            self.unregister_target(domain_id)

    def _target(self, domain_id: str) -> _WindowsTarget:
        try:
            return self._targets[domain_id]
        except KeyError as exc:
            raise PermissionError(f"target is not registered with Windows provider: {domain_id}") from exc

    def inspect(self, target_domain_id: str) -> dict:
        target = self._target(target_domain_id)
        return {
            "pid": target.pid,
            "cpu_policy": self._backend.query_cpu_policy(target.job),
            "job_memory_bytes": self._backend.query_job_memory_limit(target.job),
            "process_suspended": self._backend.query_process_suspended(target.pid),
        }

    def apply(self, intent: CommandIntent) -> ActuationReceipt:
        target = self._target(intent.target_domain_id)
        before = self.inspect(intent.target_domain_id)
        status = "CONFIRMED"

        if intent.action == "domain.set_resource_budget":
            if not intent.arguments:
                raise ValueError("resource-budget intent requires at least one resource field")
            if "cpu_fraction" in intent.arguments:
                self._backend.set_cpu_hard_cap(target.job, float(intent.arguments["cpu_fraction"]))
            if "job_memory_bytes" in intent.arguments:
                self._backend.set_job_memory_limit(target.job, int(intent.arguments["job_memory_bytes"]))
        elif intent.action == "domain.pause":
            self._backend.suspend_process(target.pid)
            status = "PARTIAL"
        elif intent.action == "domain.resume":
            self._backend.resume_process(target.pid)
            status = "PARTIAL"
        elif intent.action == "domain.inspect":
            status = "CONFIRMED"
        else:
            raise ValueError(f"unsupported Windows provider action: {intent.action}")

        realized = self.inspect(intent.target_domain_id)
        now = datetime.now(timezone.utc)
        return ActuationReceipt(
            receipt_id=f"receipt:{uuid4()}",
            command_id=intent.command_id,
            provider=self.provider_ref,
            status=status,
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

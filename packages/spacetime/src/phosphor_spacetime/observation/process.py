from __future__ import annotations

from datetime import datetime, timezone

import psutil

from phosphor_spacetime.registry.domains import DomainRegistry

from .bus import ObservationEvent


class ProcessObserver:
    """Observe only explicitly registered domain->PID mappings."""

    def __init__(self, *, registry: DomainRegistry, source: str = "process-observer") -> None:
        self._registry = registry
        self._source = source
        self._pids: dict[str, int] = {}

    def register_pid(self, domain_id: str, pid: int) -> None:
        self._registry.get(domain_id)
        if pid <= 0:
            raise ValueError("pid must be positive")
        self._pids[domain_id] = pid

    def unregister_pid(self, domain_id: str) -> None:
        self._pids.pop(domain_id, None)

    def sample(self, domain_id: str) -> ObservationEvent:
        # Domain registration is a hard boundary: no machine-wide discovery fallback.
        self._registry.get(domain_id)
        observed_at = datetime.now(timezone.utc)
        pid = self._pids.get(domain_id)
        if pid is None:
            return ObservationEvent(
                domain_id=domain_id,
                source=self._source,
                kind="process.sample",
                observed_at=observed_at,
                health="ERROR",
                payload={},
                error_code="PID_NOT_REGISTERED",
                error_detail="domain has no explicitly registered PID",
            )

        try:
            process = psutil.Process(pid)
            memory = process.memory_info()
            payload = {
                "pid": pid,
                "cpu_percent": max(0.0, float(process.cpu_percent(interval=None))),
                "memory_rss_bytes": max(0, int(memory.rss)),
                "memory_vms_bytes": max(0, int(memory.vms)),
                "status": process.status(),
                "create_time": float(process.create_time()),
            }
            return ObservationEvent(
                domain_id=domain_id,
                source=self._source,
                kind="process.sample",
                observed_at=observed_at,
                health="HEALTHY",
                payload=payload,
            )
        except psutil.NoSuchProcess as exc:
            code = "PROCESS_NOT_FOUND"
            detail = f"{type(exc).__name__}: {exc}"
        except psutil.AccessDenied as exc:
            code = "PROCESS_ACCESS_DENIED"
            detail = f"{type(exc).__name__}: {exc}"
        except Exception as exc:
            code = "PROCESS_OBSERVATION_FAILED"
            detail = f"{type(exc).__name__}: {exc}"

        return ObservationEvent(
            domain_id=domain_id,
            source=self._source,
            kind="process.sample",
            observed_at=observed_at,
            health="ERROR",
            payload={"pid": pid},
            error_code=code,
            error_detail=detail,
        )

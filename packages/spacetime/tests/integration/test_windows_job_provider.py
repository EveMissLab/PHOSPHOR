from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone

import pytest

from phosphor_spacetime.control.dispatcher import dispatch
from phosphor_spacetime.control.intent import ActorRef, CommandIntent
from phosphor_spacetime.governance.authority import AuthorityGrant, IdempotencyStore
from phosphor_spacetime.ir.models import DomainLifecycle, DomainState
from phosphor_spacetime.providers.windows_job import WindowsJobProvider


class FakeWindowsJobBackend:
    def __init__(self) -> None:
        self.jobs: dict[object, dict] = {}
        self.next_handle = 1
        self.suspended: dict[int, bool] = {}

    def create_job(self, name: str) -> object:
        handle = f"job:{self.next_handle}:{name}"
        self.next_handle += 1
        self.jobs[handle] = {"pids": set(), "cpu_policy": None, "job_memory_bytes": None}
        return handle

    def close_job(self, job: object) -> None:
        self.jobs.pop(job, None)

    def assign_process(self, job: object, pid: int) -> None:
        self.jobs[job]["pids"].add(pid)

    def set_cpu_hard_cap(self, job: object, fraction: float) -> None:
        self.jobs[job]["cpu_policy"] = {"mode": "hard_cap", "fraction": fraction}

    def query_cpu_policy(self, job: object) -> dict | None:
        policy = self.jobs[job]["cpu_policy"]
        return None if policy is None else dict(policy)

    def set_job_memory_limit(self, job: object, limit_bytes: int) -> None:
        self.jobs[job]["job_memory_bytes"] = limit_bytes

    def query_job_memory_limit(self, job: object) -> int | None:
        return self.jobs[job]["job_memory_bytes"]

    def suspend_process(self, pid: int) -> None:
        self.suspended[pid] = True

    def resume_process(self, pid: int) -> None:
        self.suspended[pid] = False

    def query_process_suspended(self, pid: int) -> bool | None:
        return self.suspended.get(pid, False)


def _domain(domain_id: str = "domain:win") -> DomainState:
    return DomainState(domain_id=domain_id, kind="PROCESS", lifecycle=DomainLifecycle.ATTACHED)


def _intent(action: str, arguments: dict, *, command_id: str = "cmd:win", key: str = "idem:win") -> CommandIntent:
    now = datetime.now(timezone.utc)
    return CommandIntent(
        command_id=command_id,
        actor=ActorRef(actor_id="governor:test", actor_type="governor"),
        target_domain_id="domain:win",
        action=action,
        arguments=arguments,
        requested_at=now,
        expires_at=now + timedelta(minutes=1),
        policy_source="RULE",
        required_capabilities=[action],
        authority_ref="grant:win",
        evidence_refs=[],
        idempotency_key=key,
    )


def _grant(action: str, *, epoch: int = 1) -> AuthorityGrant:
    now = datetime.now(timezone.utc)
    return AuthorityGrant(
        grant_id="grant:win",
        actor_id="governor:test",
        target_domain_ids={"domain:win"},
        actions={action},
        fence_epoch=epoch,
        issued_at=now,
        expires_at=now + timedelta(minutes=1),
    )


def test_windows_provider_reports_resource_budget_support_but_not_logical_time_support():
    provider = WindowsJobProvider(backend=FakeWindowsJobBackend(), epoch=1)
    resource = provider.capability_for("domain.set_resource_budget")
    temporal = provider.capability_for("domain.set_temporal_rate")
    assert resource is not None and resource.support == "SUPPORTED"
    assert resource.bounds["cpu_fraction"] == {"min": 0.01, "max": 1.0}
    assert resource.bounds["job_memory_bytes"]["min"] == 1
    assert temporal is not None and temporal.support == "UNSUPPORTED"


def test_windows_provider_refuses_unowned_unallowlisted_target_registration():
    provider = WindowsJobProvider(backend=FakeWindowsJobBackend(), epoch=1)
    with pytest.raises(PermissionError, match="spawned by the MVP or explicitly allowlisted"):
        provider.register_target("domain:win", 1234)


def test_windows_provider_cpu_hard_cap_round_trips_through_dispatch_and_readback():
    backend = FakeWindowsJobBackend()
    provider = WindowsJobProvider(backend=backend, epoch=1)
    provider.register_target("domain:win", 1234, spawned_by_mvp=True)
    receipt = dispatch(
        _intent("domain.set_resource_budget", {"cpu_fraction": 0.40}),
        domain=_domain(),
        grant=_grant("domain.set_resource_budget"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert receipt.status == "CONFIRMED"
    assert receipt.realized["cpu_policy"] == {"mode": "hard_cap", "fraction": 0.40}
    assert receipt.observed_after["cpu_policy"] == receipt.realized["cpu_policy"]
    assert receipt.actuation_skew["verification_match"] is True


def test_windows_provider_job_memory_limit_round_trips_through_dispatch_and_readback():
    backend = FakeWindowsJobBackend()
    provider = WindowsJobProvider(backend=backend, epoch=1)
    provider.register_target("domain:win", 1234, allowlisted=True)
    receipt = dispatch(
        _intent("domain.set_resource_budget", {"job_memory_bytes": 128 * 1024 * 1024}, command_id="cmd:mem", key="idem:mem"),
        domain=_domain(),
        grant=_grant("domain.set_resource_budget"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert receipt.status == "CONFIRMED"
    assert receipt.realized["job_memory_bytes"] == 128 * 1024 * 1024
    assert receipt.observed_after["job_memory_bytes"] == 128 * 1024 * 1024


def test_windows_provider_resource_bounds_are_enforced_before_backend_apply():
    backend = FakeWindowsJobBackend()
    provider = WindowsJobProvider(backend=backend, epoch=1)
    provider.register_target("domain:win", 1234, spawned_by_mvp=True)
    receipt = dispatch(
        _intent("domain.set_resource_budget", {"cpu_fraction": 0.0}, command_id="cmd:bad", key="idem:bad"),
        domain=_domain(),
        grant=_grant("domain.set_resource_budget"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert receipt.status == "FAILED"
    assert receipt.error["code"] == "ARGUMENT_OUT_OF_BOUNDS"
    assert backend.query_cpu_policy(next(iter(backend.jobs))) is None


def test_windows_provider_pause_resume_is_explicitly_process_level_partial_semantics():
    backend = FakeWindowsJobBackend()
    provider = WindowsJobProvider(backend=backend, epoch=1)
    provider.register_target("domain:win", 1234, spawned_by_mvp=True)
    pause_cap = provider.capability_for("domain.pause")
    assert pause_cap is not None and pause_cap.support == "PARTIAL"
    paused = dispatch(
        _intent("domain.pause", {}, command_id="cmd:pause", key="idem:pause"),
        domain=_domain(),
        grant=_grant("domain.pause"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert paused.status == "PARTIAL"
    assert paused.realized["process_suspended"] is True
    resumed = dispatch(
        _intent("domain.resume", {}, command_id="cmd:resume", key="idem:resume"),
        domain=_domain(),
        grant=_grant("domain.resume"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert resumed.status == "PARTIAL"
    assert resumed.realized["process_suspended"] is False


@pytest.mark.skipif(
    sys.platform != "win32" or os.environ.get("PSS_RUN_WINDOWS_JOB_TESTS") != "1",
    reason="opt-in real Windows Job Object integration test",
)
def test_real_windows_job_provider_cpu_hard_cap_round_trip():
    child = subprocess.Popen([sys.executable, "-c", "x=0\nwhile True: x=(x+1)%1000003"], text=True)
    provider = WindowsJobProvider(epoch=1)
    try:
        provider.register_target("domain:win", child.pid, spawned_by_mvp=True)
        receipt = dispatch(
            _intent("domain.set_resource_budget", {"cpu_fraction": 0.50}, command_id="cmd:real", key="idem:real"),
            domain=_domain(),
            grant=_grant("domain.set_resource_budget"),
            provider=provider,
            idempotency=IdempotencyStore(),
        )
        assert receipt.status == "CONFIRMED"
        assert abs(receipt.realized["cpu_policy"]["fraction"] - 0.50) <= 0.0001
    finally:
        provider.close()
        child.terminate()
        child.wait(timeout=5)


def test_windows_provider_is_exported_from_provider_package():
    from phosphor_spacetime.providers import WindowsJobProvider as ExportedWindowsJobProvider

    assert ExportedWindowsJobProvider is WindowsJobProvider

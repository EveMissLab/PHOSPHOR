from __future__ import annotations

import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from phosphor_spacetime.control.dispatcher import dispatch
from phosphor_spacetime.control.intent import ActorRef, CommandIntent
from phosphor_spacetime.governance.authority import AuthorityGrant, IdempotencyStore
from phosphor_spacetime.ir.models import DomainLifecycle, DomainState
from phosphor_spacetime.providers.linux_cgroup import CgroupV2Provider, FakeCgroupV2Backend


def _domain(domain_id: str = "domain:linux") -> DomainState:
    return DomainState(domain_id=domain_id, kind="PROCESS", lifecycle=DomainLifecycle.ATTACHED)


def _intent(action: str, arguments: dict, *, command_id: str = "cmd:linux", key: str = "idem:linux") -> CommandIntent:
    now = datetime.now(timezone.utc)
    return CommandIntent(
        command_id=command_id,
        actor=ActorRef(actor_id="governor:test", actor_type="governor"),
        target_domain_id="domain:linux",
        action=action,
        arguments=arguments,
        requested_at=now,
        expires_at=now + timedelta(minutes=1),
        policy_source="RULE",
        required_capabilities=[action],
        authority_ref="grant:linux",
        evidence_refs=[],
        idempotency_key=key,
    )


def _grant(action: str, *, epoch: int = 1) -> AuthorityGrant:
    now = datetime.now(timezone.utc)
    return AuthorityGrant(
        grant_id="grant:linux",
        actor_id="governor:test",
        target_domain_ids={"domain:linux"},
        actions={action},
        fence_epoch=epoch,
        issued_at=now,
        expires_at=now + timedelta(minutes=1),
    )


def test_linux_provider_reports_cgroup_resource_semantics_without_claiming_logical_time():
    provider = CgroupV2Provider(backend=FakeCgroupV2Backend(), epoch=1)
    resource = provider.capability_for("domain.set_resource_budget")
    temporal = provider.capability_for("domain.set_temporal_rate")
    pause = provider.capability_for("domain.pause")
    assert resource is not None and resource.support == "PARTIAL"
    assert resource.bounds["cpu_weight"] == {"min": 1, "max": 10000}
    assert resource.bounds["io_weight"] == {"min": 1, "max": 10000}
    assert temporal is not None and temporal.support == "UNSUPPORTED"
    assert pause is not None and pause.support == "SUPPORTED"


def test_linux_provider_refuses_unowned_unallowlisted_target_registration():
    provider = CgroupV2Provider(backend=FakeCgroupV2Backend(), epoch=1)
    with pytest.raises(PermissionError, match="spawned by the MVP or explicitly allowlisted"):
        provider.register_target("domain:linux", 1234)


def test_linux_provider_cpu_weight_and_cpu_max_round_trip_through_dispatch_and_readback():
    backend = FakeCgroupV2Backend()
    provider = CgroupV2Provider(backend=backend, epoch=1)
    provider.register_target("domain:linux", 1234, spawned_by_mvp=True)
    receipt = dispatch(
        _intent("domain.set_resource_budget", {"cpu_weight": 250, "cpu_quota_us": 50000, "cpu_period_us": 100000}),
        domain=_domain(),
        grant=_grant("domain.set_resource_budget"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert receipt.status == "CONFIRMED"
    assert receipt.realized["cpu_weight"] == 250
    assert receipt.realized["cpu_max"] == {"quota_us": 50000, "period_us": 100000}
    assert receipt.observed_after["cpu_max"] == receipt.realized["cpu_max"]
    assert receipt.actuation_skew["verification_match"] is True


def test_linux_provider_memory_and_io_controls_preserve_weight_vs_limit_semantics():
    backend = FakeCgroupV2Backend()
    provider = CgroupV2Provider(backend=backend, epoch=1)
    provider.register_target("domain:linux", 1234, allowlisted=True)
    receipt = dispatch(
        _intent(
            "domain.set_resource_budget",
            {
                "memory_max_bytes": 256 * 1024 * 1024,
                "io_weight": 300,
                "io_max": {"device": "8:0", "rbps": 1048576, "wbps": "max", "riops": 1000, "wiops": "max"},
            },
            command_id="cmd:linux-io",
            key="idem:linux-io",
        ),
        domain=_domain(),
        grant=_grant("domain.set_resource_budget"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert receipt.status == "CONFIRMED"
    assert receipt.realized["memory_max_bytes"] == 256 * 1024 * 1024
    assert receipt.realized["io_weight"] == 300
    assert receipt.realized["io_max"]["8:0"] == {"rbps": 1048576, "wbps": "max", "riops": 1000, "wiops": "max"}


def test_linux_provider_resource_bounds_fail_before_writing_backend_state():
    backend = FakeCgroupV2Backend()
    provider = CgroupV2Provider(backend=backend, epoch=1)
    provider.register_target("domain:linux", 1234, spawned_by_mvp=True)
    before = provider.inspect("domain:linux")
    receipt = dispatch(
        _intent("domain.set_resource_budget", {"cpu_weight": 0}, command_id="cmd:linux-bad", key="idem:linux-bad"),
        domain=_domain(),
        grant=_grant("domain.set_resource_budget"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert receipt.status == "FAILED"
    assert receipt.error["code"] == "ARGUMENT_OUT_OF_BOUNDS"
    assert provider.inspect("domain:linux") == before


def test_linux_provider_pause_resume_uses_cgroup_freeze_and_readback():
    backend = FakeCgroupV2Backend()
    provider = CgroupV2Provider(backend=backend, epoch=1)
    provider.register_target("domain:linux", 1234, spawned_by_mvp=True)
    paused = dispatch(
        _intent("domain.pause", {}, command_id="cmd:linux-pause", key="idem:linux-pause"),
        domain=_domain(),
        grant=_grant("domain.pause"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert paused.status == "CONFIRMED"
    assert paused.realized["frozen"] is True
    resumed = dispatch(
        _intent("domain.resume", {}, command_id="cmd:linux-resume", key="idem:linux-resume"),
        domain=_domain(),
        grant=_grant("domain.resume"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert resumed.status == "CONFIRMED"
    assert resumed.realized["frozen"] is False


def test_linux_provider_rejects_malformed_io_max_without_partial_write():
    backend = FakeCgroupV2Backend()
    provider = CgroupV2Provider(backend=backend, epoch=1)
    provider.register_target("domain:linux", 1234, spawned_by_mvp=True)
    before = provider.inspect("domain:linux")
    receipt = dispatch(
        _intent("domain.set_resource_budget", {"io_max": {"device": "../../oops", "rbps": 1}}, command_id="cmd:linux-bad-io", key="idem:linux-bad-io"),
        domain=_domain(),
        grant=_grant("domain.set_resource_budget"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert receipt.status == "FAILED"
    assert receipt.error["code"] == "PROVIDER_APPLY_FAILED"
    assert provider.inspect("domain:linux") == before


@pytest.mark.skipif(
    not sys.platform.startswith("linux") or os.environ.get("PSS_RUN_CGROUP_TESTS") != "1",
    reason="opt-in real Linux cgroup v2 integration test",
)
def test_real_linux_cgroup_provider_cpu_weight_and_max_round_trip():
    root = os.environ.get("PSS_CGROUP_TEST_ROOT")
    if not root:
        pytest.fail("PSS_CGROUP_TEST_ROOT must point to a dedicated writable cgroup v2 subtree")
    child = subprocess.Popen([sys.executable, "-c", "import time\nwhile True: time.sleep(0.1)"], text=True)
    provider = CgroupV2Provider(root=Path(root), epoch=1)
    try:
        provider.register_target("domain:linux", child.pid, spawned_by_mvp=True)
        receipt = dispatch(
            _intent(
                "domain.set_resource_budget",
                {"cpu_weight": 200, "cpu_quota_us": 50000, "cpu_period_us": 100000},
                command_id="cmd:linux-real",
                key="idem:linux-real",
            ),
            domain=_domain(),
            grant=_grant("domain.set_resource_budget"),
            provider=provider,
            idempotency=IdempotencyStore(),
        )
        assert receipt.status == "CONFIRMED"
        assert receipt.realized["cpu_weight"] == 200
        assert receipt.realized["cpu_max"] == {"quota_us": 50000, "period_us": 100000}
    finally:
        child.terminate()
        child.wait(timeout=5)
        provider.close()


def test_linux_provider_is_exported_from_provider_package():
    from phosphor_spacetime.providers import CgroupV2Provider as ExportedCgroupV2Provider
    assert ExportedCgroupV2Provider is CgroupV2Provider


def test_linux_provider_rejects_unknown_resource_field_fail_closed():
    backend = FakeCgroupV2Backend()
    provider = CgroupV2Provider(backend=backend, epoch=1)
    provider.register_target("domain:linux", 1234, spawned_by_mvp=True)
    before = provider.inspect("domain:linux")
    receipt = dispatch(
        _intent("domain.set_resource_budget", {"mystery_knob": 123}, command_id="cmd:linux-unknown", key="idem:linux-unknown"),
        domain=_domain(),
        grant=_grant("domain.set_resource_budget"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert receipt.status == "FAILED"
    assert receipt.error["code"] == "PROVIDER_APPLY_FAILED"
    assert provider.inspect("domain:linux") == before


def test_linux_provider_period_only_update_preserves_unlimited_cpu_quota():
    backend = FakeCgroupV2Backend()
    provider = CgroupV2Provider(backend=backend, epoch=1)
    provider.register_target("domain:linux", 1234, spawned_by_mvp=True)
    assert provider.inspect("domain:linux")["cpu_max"] == {"quota_us": None, "period_us": 100000}
    receipt = dispatch(
        _intent("domain.set_resource_budget", {"cpu_period_us": 200000}, command_id="cmd:linux-period", key="idem:linux-period"),
        domain=_domain(),
        grant=_grant("domain.set_resource_budget"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )
    assert receipt.status == "CONFIRMED"
    assert receipt.realized["cpu_max"] == {"quota_us": None, "period_us": 200000}

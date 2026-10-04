from __future__ import annotations

from datetime import datetime, timedelta, timezone

from phosphor_spacetime.control.dispatcher import dispatch
from phosphor_spacetime.control.intent import ActorRef, CommandIntent
from phosphor_spacetime.governance.authority import AuthorityGrant, IdempotencyStore
from phosphor_spacetime.ir.models import DomainLifecycle, DomainState
from phosphor_spacetime.providers.synthetic_runtime import SyntheticRuntime, SyntheticRuntimeProvider


def _schedule(runtime: SyntheticRuntime) -> None:
    runtime.schedule_event(5, "add", key="score", value=2)
    runtime.schedule_event(20, "random_add", key="score", low=1, high=7)
    runtime.schedule_event(50, "set", key="phase", value="done")
    runtime.schedule_event(50, "add", key="score", value=3)


def _domain(domain_id: str = "domain:synthetic") -> DomainState:
    return DomainState(domain_id=domain_id, kind="SIMULATION", lifecycle=DomainLifecycle.ATTACHED)


def _intent(action: str, arguments: dict, *, command_id: str, key: str) -> CommandIntent:
    now = datetime.now(timezone.utc)
    return CommandIntent(
        command_id=command_id,
        actor=ActorRef(actor_id="governor:test", actor_type="governor"),
        target_domain_id="domain:synthetic",
        action=action,
        arguments=arguments,
        requested_at=now,
        expires_at=now + timedelta(minutes=1),
        policy_source="RULE",
        required_capabilities=[action],
        authority_ref="grant:synthetic",
        evidence_refs=[],
        idempotency_key=key,
    )


def _grant(*actions: str, epoch: int = 1) -> AuthorityGrant:
    now = datetime.now(timezone.utc)
    return AuthorityGrant(
        grant_id="grant:synthetic",
        actor_id="governor:test",
        target_domain_ids={"domain:synthetic"},
        actions=set(actions),
        fence_epoch=epoch,
        issued_at=now,
        expires_at=now + timedelta(minutes=1),
    )


def test_same_seed_and_event_schedule_produce_same_state_hash():
    left = SyntheticRuntime(seed=1234)
    right = SyntheticRuntime(seed=1234)
    _schedule(left)
    _schedule(right)

    left.run_until(100, mode="tick")
    right.run_until(100, mode="tick")

    assert left.state_hash() == right.state_hash()
    assert left.state == right.state
    assert left.logical_tick == right.logical_tick == 100


def test_different_seed_changes_random_event_result():
    left = SyntheticRuntime(seed=1)
    right = SyntheticRuntime(seed=2)
    _schedule(left)
    _schedule(right)

    left.run_until(100, mode="tick")
    right.run_until(100, mode="tick")

    assert left.state_hash() != right.state_hash()


def test_tick_and_event_jump_are_exactly_equivalent_but_do_different_work():
    tick = SyntheticRuntime(seed=42)
    jump = SyntheticRuntime(seed=42)
    _schedule(tick)
    _schedule(jump)

    tick.run_until(100, mode="tick")
    jump.run_until(100, mode="event_jump")

    assert tick.state_hash() == jump.state_hash()
    assert tick.state == jump.state
    assert tick.logical_tick == jump.logical_tick == 100
    assert tick.metrics.tick_iterations == 100
    assert jump.metrics.tick_iterations == 0
    assert jump.metrics.jump_count >= 1
    assert jump.metrics.idle_ticks_skipped > 0


def test_native_rate_is_separate_from_wall_quanta_and_tracks_fractional_remainder():
    runtime = SyntheticRuntime(seed=7)
    runtime.set_rate(2.5)

    advanced = runtime.advance_wall_quanta(1)
    assert advanced == 2
    assert runtime.logical_tick == 2
    assert runtime.requested_rate == 2.5
    assert runtime.realized_rate == 2.5
    assert runtime.rate_remainder == 0.5

    advanced = runtime.advance_wall_quanta(1)
    assert advanced == 3
    assert runtime.logical_tick == 5
    assert runtime.rate_remainder == 0.0
    assert runtime.metrics.wall_quanta == 2


def test_pause_stops_logical_progress_without_changing_requested_rate():
    runtime = SyntheticRuntime(seed=3)
    runtime.set_rate(4.0)
    runtime.pause()

    assert runtime.advance_wall_quanta(10) == 0
    assert runtime.logical_tick == 0
    assert runtime.requested_rate == 4.0
    assert runtime.realized_rate == 4.0

    runtime.resume()
    assert runtime.advance_wall_quanta(1) == 4
    assert runtime.logical_tick == 4


def test_snapshot_restore_replays_future_exactly_including_rng_and_pending_events():
    runtime = SyntheticRuntime(seed=99)
    _schedule(runtime)
    runtime.run_until(10, mode="tick")
    snapshot = runtime.snapshot()

    runtime.run_until(100, mode="event_jump")
    first_future_hash = runtime.state_hash()
    first_future_state = dict(runtime.state)

    runtime.restore(snapshot)
    runtime.run_until(100, mode="event_jump")

    assert runtime.state_hash() == first_future_hash
    assert runtime.state == first_future_state


def test_provider_reports_native_temporal_and_snapshot_capabilities():
    provider = SyntheticRuntimeProvider(epoch=1)

    temporal = provider.capability_for("domain.set_temporal_rate")
    snapshot = provider.capability_for("domain.snapshot")
    restore = provider.capability_for("domain.restore")
    resources = provider.capability_for("domain.set_resource_budget")

    assert temporal is not None and temporal.support == "SUPPORTED"
    assert temporal.bounds["rate"] == {"min": 0.0, "max": 20.0}
    assert snapshot is not None and snapshot.support == "SUPPORTED"
    assert restore is not None and restore.support == "SUPPORTED"
    assert resources is not None and resources.support == "UNSUPPORTED"


def test_provider_requires_owned_or_allowlisted_runtime_registration():
    provider = SyntheticRuntimeProvider(epoch=1)
    runtime = SyntheticRuntime(seed=1)

    try:
        provider.register_runtime("domain:synthetic", runtime)
    except PermissionError as exc:
        assert "owned by the MVP or explicitly allowlisted" in str(exc)
    else:
        raise AssertionError("registration without ownership/allowlist should fail")


def test_provider_native_rate_dispatch_keeps_requested_realized_and_observed_distinct():
    runtime = SyntheticRuntime(seed=5)
    provider = SyntheticRuntimeProvider(epoch=1)
    provider.register_runtime("domain:synthetic", runtime, owned_by_mvp=True)

    receipt = dispatch(
        _intent("domain.set_temporal_rate", {"rate": 3.5}, command_id="cmd:rate", key="idem:rate"),
        domain=_domain(),
        grant=_grant("domain.set_temporal_rate"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )

    assert receipt.status == "CONFIRMED"
    assert receipt.requested["arguments"]["rate"] == 3.5
    assert receipt.realized["requested_rate"] == 3.5
    assert receipt.realized["realized_rate"] == 3.5
    assert receipt.observed_after["realized_rate"] == 3.5
    assert receipt.actuation_skew["verification_match"] is True


def test_provider_snapshot_restore_round_trip_restores_exact_state_hash():
    runtime = SyntheticRuntime(seed=77)
    _schedule(runtime)
    provider = SyntheticRuntimeProvider(epoch=1)
    provider.register_runtime("domain:synthetic", runtime, owned_by_mvp=True)
    store = IdempotencyStore()

    runtime.run_until(10, mode="tick")
    saved_hash = runtime.state_hash()
    snapshot_receipt = dispatch(
        _intent("domain.snapshot", {}, command_id="cmd:snap", key="idem:snap"),
        domain=_domain(),
        grant=_grant("domain.snapshot"),
        provider=provider,
        idempotency=store,
    )
    assert snapshot_receipt.status == "CONFIRMED"
    snapshot_id = snapshot_receipt.realized["snapshot_id"]

    runtime.run_until(100, mode="event_jump")
    assert runtime.state_hash() != saved_hash

    restore_receipt = dispatch(
        _intent("domain.restore", {"snapshot_id": snapshot_id}, command_id="cmd:restore", key="idem:restore"),
        domain=_domain(),
        grant=_grant("domain.restore"),
        provider=provider,
        idempotency=store,
    )

    assert restore_receipt.status == "CONFIRMED"
    assert restore_receipt.realized["state_hash"] == saved_hash
    assert restore_receipt.observed_after["state_hash"] == saved_hash
    assert restore_receipt.actuation_skew["verification_match"] is True


def test_provider_restore_unknown_snapshot_fails_closed():
    runtime = SyntheticRuntime(seed=2)
    provider = SyntheticRuntimeProvider(epoch=1)
    provider.register_runtime("domain:synthetic", runtime, owned_by_mvp=True)

    receipt = dispatch(
        _intent("domain.restore", {"snapshot_id": "missing"}, command_id="cmd:restore-missing", key="idem:restore-missing"),
        domain=_domain(),
        grant=_grant("domain.restore"),
        provider=provider,
        idempotency=IdempotencyStore(),
    )

    assert receipt.status == "FAILED"
    assert receipt.error["code"] == "PROVIDER_APPLY_FAILED"


def test_synthetic_provider_is_exported_from_provider_package():
    from phosphor_spacetime.providers import SyntheticRuntimeProvider as ExportedSyntheticRuntimeProvider

    assert ExportedSyntheticRuntimeProvider is SyntheticRuntimeProvider


def test_schedule_rejects_non_json_serializable_payload_before_it_enters_state():
    runtime = SyntheticRuntime(seed=1)

    try:
        runtime.schedule_event(5, "set", key="bad", value=object())
    except ValueError as exc:
        assert "JSON-serializable" in str(exc)
    else:
        raise AssertionError("non-JSON payload must be rejected before scheduling")

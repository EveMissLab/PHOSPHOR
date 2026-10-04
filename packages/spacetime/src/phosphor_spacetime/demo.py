"""An authority-bound demonstration on a runtime owned by this invocation."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from phosphor_spacetime.control.dispatcher import dispatch
from phosphor_spacetime.control.intent import ActorRef, CommandIntent
from phosphor_spacetime.governance.authority import AuthorityGrant, IdempotencyStore
from phosphor_spacetime.ir.models import DomainLifecycle, DomainState
from phosphor_spacetime.providers.synthetic_runtime import SyntheticRuntime, SyntheticRuntimeProvider


def temporal_demo(*, rate: float, quanta: int) -> dict:
    runtime = SyntheticRuntime(seed=42)
    runtime.schedule_event(10, "add", key="counter", value=1)
    runtime.schedule_event(25, "add", key="counter", value=1)
    runtime.schedule_event(50, "set", key="phase", value="complete")
    provider = SyntheticRuntimeProvider(epoch=1)
    domain = DomainState(domain_id="demo:temporal", kind="SIMULATION", lifecycle=DomainLifecycle.ATTACHED)
    provider.register_runtime(domain.domain_id, runtime, owned_by_mvp=True)
    now = datetime.now(timezone.utc)
    intent = CommandIntent(
        command_id="demo:set-rate", actor=ActorRef(actor_id="demo:owner", actor_type="system"),
        target_domain_id=domain.domain_id, action="domain.set_temporal_rate", arguments={"rate": rate},
        requested_at=now, expires_at=now + timedelta(minutes=1), policy_source="STATIC",
        required_capabilities=["domain.set_temporal_rate"], authority_ref="demo:grant",
        evidence_refs=[], idempotency_key="demo:set-rate",
    )
    grant = AuthorityGrant(
        grant_id="demo:grant", actor_id="demo:owner", target_domain_ids={domain.domain_id},
        actions={intent.action}, fence_epoch=1, issued_at=now - timedelta(seconds=1),
        expires_at=now + timedelta(minutes=1),
    )
    receipt = dispatch(intent, domain=domain, grant=grant, provider=provider, idempotency=IdempotencyStore())
    if receipt.status != "CONFIRMED":
        raise RuntimeError(f"rate change was not confirmed: {receipt.status}")
    jumped = SyntheticRuntime(seed=42)
    jumped.restore(runtime.snapshot())
    runtime.advance_wall_quanta(quanta)
    jumped.run_until(runtime.logical_tick, mode="event_jump")
    return {
        "schema_version": "pss-temporal-demo-v0.1", "target": "owned-synthetic-runtime",
        "receipt_status": receipt.status, "requested_rate": rate,
        "realized_rate": receipt.observed_after["realized_rate"], "quanta": quanta,
        "logical_tick": runtime.logical_tick, "projection_semantics": "LOGICAL_RATE_NATIVE",
        "state": runtime.state, "tick_state_hash": runtime.state_hash(),
        "event_jump_state_hash": jumped.state_hash(), "state_hash_equal": runtime.state_hash() == jumped.state_hash(),
        "tick_iterations": runtime.metrics.tick_iterations,
        "event_jump_tick_iterations": jumped.metrics.tick_iterations,
        "idle_ticks_skipped": jumped.metrics.idle_ticks_skipped,
        "performance_hypotheses_evaluated": False,
    }

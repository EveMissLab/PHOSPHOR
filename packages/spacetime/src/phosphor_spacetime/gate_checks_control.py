from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from phosphor_spacetime.control.dispatcher import dispatch
from phosphor_spacetime.control.intent import ActorRef, CommandIntent
from phosphor_spacetime.gate_models import GateCheckError
from phosphor_spacetime.governance.authority import AuthorityGrant, IdempotencyStore
from phosphor_spacetime.ir.models import DomainLifecycle, DomainState
from phosphor_spacetime.providers.mock import MockProvider
from phosphor_spacetime.providers.synthetic_runtime import SyntheticRuntime, SyntheticRuntimeProvider


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise GateCheckError(message)


def check_safe_actuation(run_dir: Path, git_commit: str) -> dict[str, Any]:
    def domain() -> DomainState:
        return DomainState(domain_id="gate:control", kind="PROCESS", lifecycle=DomainLifecycle.ATTACHED)

    def intent(action: str, key: str) -> CommandIntent:
        now = datetime.now(timezone.utc)
        args = {"rate": 2.0} if action == "domain.set_temporal_rate" else {}
        return CommandIntent(
            command_id=f"cmd:{key}",
            actor=ActorRef(actor_id="gate:governor", actor_type="governor"),
            target_domain_id="gate:control",
            action=action,
            arguments=args,
            requested_at=now,
            expires_at=now + timedelta(minutes=1),
            policy_source="RULE",
            required_capabilities=[action],
            authority_ref="gate:grant",
            evidence_refs=[],
            idempotency_key=key,
        )

    def grant(action: str, epoch: int) -> AuthorityGrant:
        now = datetime.now(timezone.utc)
        return AuthorityGrant(
            grant_id="gate:grant",
            actor_id="gate:governor",
            target_domain_ids={"gate:control"},
            actions={action},
            fence_epoch=epoch,
            issued_at=now - timedelta(seconds=1),
            expires_at=now + timedelta(minutes=1),
        )

    authorized_provider = MockProvider()
    authorized = dispatch(intent("domain.pause", "gate:authorized"), domain=domain(), grant=grant("domain.pause", 1), provider=authorized_provider, idempotency=IdempotencyStore())
    _require(authorized.status == "CONFIRMED", "authorized actuation did not confirm")

    unauthorized_provider = MockProvider()
    unauthorized = dispatch(intent("domain.pause", "gate:unauthorized"), domain=domain(), grant=None, provider=unauthorized_provider, idempotency=IdempotencyStore())
    _require(unauthorized.error["code"] == "AUTHORITY_DENIED", "unauthorized mutation was not denied")
    _require(unauthorized_provider.apply_count == 0, "unauthorized mutation reached provider apply")

    stale_provider = MockProvider(epoch=2)
    stale = dispatch(intent("domain.pause", "gate:stale-fence"), domain=domain(), grant=grant("domain.pause", 1), provider=stale_provider, idempotency=IdempotencyStore())
    _require(stale.error["code"] == "STALE_FENCE", "stale fence was not rejected")

    unsupported_provider = MockProvider()
    unsupported = dispatch(intent("domain.restore", "gate:unsupported"), domain=domain(), grant=grant("domain.restore", 1), provider=unsupported_provider, idempotency=IdempotencyStore())
    _require(unsupported.error["code"] == "CAPABILITY_UNSUPPORTED", "unsupported mutation did not fail closed")

    duplicate_provider = MockProvider()
    duplicate_store = IdempotencyStore()
    duplicate_intent = intent("domain.pause", "gate:duplicate")
    duplicate_grant = grant("domain.pause", 1)
    first = dispatch(duplicate_intent, domain=domain(), grant=duplicate_grant, provider=duplicate_provider, idempotency=duplicate_store)
    second = dispatch(duplicate_intent, domain=domain(), grant=duplicate_grant, provider=duplicate_provider, idempotency=duplicate_store)
    _require(first.receipt_id == second.receipt_id, "duplicate idempotency did not reuse terminal receipt")
    _require(duplicate_provider.apply_count == 1, "duplicate command caused multiple physical applies")

    failing_provider = MockProvider(raise_on_apply=True)
    failing_store = IdempotencyStore()
    failing_intent = intent("domain.pause", "gate:provider-failure")
    failed = dispatch(failing_intent, domain=domain(), grant=grant("domain.pause", 1), provider=failing_provider, idempotency=failing_store)
    retry = dispatch(failing_intent, domain=domain(), grant=grant("domain.pause", 1), provider=failing_provider, idempotency=failing_store)
    _require(failed.error["code"] == "PROVIDER_APPLY_FAILED", "provider exception was not terminal failure")
    _require(retry.receipt_id == failed.receipt_id and failing_provider.apply_count == 1, "failed retry re-applied mutation")

    mismatch_provider = MockProvider(force_verification_mismatch=True)
    mismatch = dispatch(intent("domain.pause", "gate:mismatch"), domain=domain(), grant=grant("domain.pause", 1), provider=mismatch_provider, idempotency=IdempotencyStore())
    _require(mismatch.error["code"] == "FAILED_VERIFICATION", "post-observation mismatch was reported as success")
    _require(mismatch.actuation_skew == {"verification_match": False}, "verification skew was not recorded")

    return {
        "authorized_status": authorized.status,
        "unauthorized_code": unauthorized.error["code"],
        "stale_fence_code": stale.error["code"],
        "unsupported_code": unsupported.error["code"],
        "idempotent_apply_count": duplicate_provider.apply_count,
        "provider_exception_terminal": True,
        "receipt_mismatch_code": mismatch.error["code"],
        "false_success_count": 0,
    }


def check_temporal_semantics(run_dir: Path, git_commit: str) -> dict[str, Any]:
    def make_runtime() -> SyntheticRuntime:
        runtime = SyntheticRuntime(seed=42)
        runtime.schedule_event(10, "add", key="counter", value=1)
        runtime.schedule_event(500, "add", key="counter", value=1)
        runtime.schedule_event(999, "set", key="phase", value="complete")
        return runtime

    tick = make_runtime()
    jumped = make_runtime()
    tick.run_until(1000, mode="tick")
    jumped.run_until(1000, mode="event_jump")
    _require(tick.state_hash() == jumped.state_hash(), "tick/event-jump semantic state diverged")
    _require(tick.metrics.tick_iterations == 1000, "tick reference did not execute expected iterations")
    _require(jumped.metrics.tick_iterations == 0, "event-jump performed tick iterations")
    _require(jumped.metrics.idle_ticks_skipped == 997, "event-jump did not account idle logical time")

    runtime = SyntheticRuntime(seed=7)
    provider = SyntheticRuntimeProvider(epoch=1)
    domain = DomainState(domain_id="gate:runtime", kind="SIMULATION", lifecycle=DomainLifecycle.ATTACHED)
    provider.register_runtime(domain.domain_id, runtime, owned_by_mvp=True)
    now = datetime.now(timezone.utc)
    control = CommandIntent(
        command_id="gate:temporal-rate",
        actor=ActorRef(actor_id="gate:governor", actor_type="governor"),
        target_domain_id=domain.domain_id,
        action="domain.set_temporal_rate",
        arguments={"rate": 2.5},
        requested_at=now,
        expires_at=now + timedelta(minutes=1),
        policy_source="RULE",
        required_capabilities=["domain.set_temporal_rate"],
        authority_ref="gate:runtime-grant",
        evidence_refs=[],
        idempotency_key="gate:runtime-rate",
    )
    authority = AuthorityGrant(
        grant_id="gate:runtime-grant",
        actor_id="gate:governor",
        target_domain_ids={domain.domain_id},
        actions={"domain.set_temporal_rate"},
        fence_epoch=1,
        issued_at=now - timedelta(seconds=1),
        expires_at=now + timedelta(minutes=1),
    )
    receipt = dispatch(control, domain=domain, grant=authority, provider=provider, idempotency=IdempotencyStore())
    _require(receipt.status == "CONFIRMED", "native logical-rate change did not confirm")
    _require(receipt.realized.get("requested_rate") == 2.5, "requested logical rate lost")
    _require(receipt.realized.get("realized_rate") == 2.5, "realized logical rate mismatch")
    _require(receipt.actuation_skew == {"verification_match": True}, "native logical rate not independently verified")
    capability = provider.capability_for("domain.set_temporal_rate")
    _require(capability.projection_semantics == "LOGICAL_RATE_NATIVE", "runtime temporal control is not marked native")

    return {
        "state_hash_equal": True,
        "tick_iterations": tick.metrics.tick_iterations,
        "event_jump_tick_iterations": jumped.metrics.tick_iterations,
        "idle_ticks_skipped": jumped.metrics.idle_ticks_skipped,
        "requested_rate": 2.5,
        "realized_rate": 2.5,
        "projection_semantics": capability.projection_semantics,
    }

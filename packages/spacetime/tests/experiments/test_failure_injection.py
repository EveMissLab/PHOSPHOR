from __future__ import annotations

import time
from datetime import datetime, timedelta, timezone

from phosphor_spacetime.control.dispatcher import dispatch
from phosphor_spacetime.control.intent import ActorRef, CommandIntent
from phosphor_spacetime.governance.ai_policy import AIPolicyAdapter
from phosphor_spacetime.governance.authority import AuthorityGrant, IdempotencyStore
from phosphor_spacetime.governance.policy import GovernanceSummary
from phosphor_spacetime.governance.rule_governor import RulePolicy
from phosphor_spacetime.ir.models import DomainLifecycle, DomainState
from phosphor_spacetime.observation.bus import ObservationEvent, ObserverBus
from phosphor_spacetime.providers.mock import MockProvider


NOW = datetime.now(timezone.utc)


def domain() -> DomainState:
    return DomainState(domain_id="domain:failure", kind="PROCESS", lifecycle=DomainLifecycle.ATTACHED)


def intent(*, action: str = "domain.pause", key: str = "idem:failure") -> CommandIntent:
    arguments = {"rate": 2.0} if action == "domain.set_temporal_rate" else {}
    return CommandIntent(
        command_id=f"cmd:{key}",
        actor=ActorRef(actor_id="governor:test", actor_type="governor"),
        target_domain_id="domain:failure",
        action=action,
        arguments=arguments,
        requested_at=NOW,
        expires_at=NOW + timedelta(minutes=5),
        policy_source="RULE",
        required_capabilities=[action],
        authority_ref="grant:test",
        evidence_refs=[],
        idempotency_key=key,
    )


def grant(*, fence_epoch: int = 1, action: str = "domain.pause") -> AuthorityGrant:
    return AuthorityGrant(
        grant_id="grant:test",
        actor_id="governor:test",
        target_domain_ids={"domain:failure"},
        actions={action},
        fence_epoch=fence_epoch,
        issued_at=NOW - timedelta(seconds=1),
        expires_at=NOW + timedelta(minutes=5),
    )


def summary(**overrides) -> GovernanceSummary:
    data = {
        "domain_id": "domain:failure",
        "role": "NORMAL",
        "temporal_debt": 8.0,
        "resource_pressure": 0.4,
        "causal_criticality": 0.9,
        "observation_health": "HEALTHY",
        "current_cpu_budget_fraction": 0.5,
        "current_temporal_rate": 1.0,
        "current_observation_profile": "NORMAL",
        "paused": False,
        "native_temporal_rate_supported": True,
        "resource_budget_supported": True,
        "observation_profile_supported": True,
        "pause_supported": True,
        "resume_supported": True,
        "last_policy_change_at": None,
        "evidence_refs": [],
    }
    data.update(overrides)
    return GovernanceSummary(**data)


def test_observer_subscriber_failure_is_contained_and_other_subscriber_receives_event():
    bus = ObserverBus()
    seen = []

    def broken(event):
        raise RuntimeError("observer projection failed")

    bus.subscribe(broken)
    bus.subscribe(seen.append)
    event = ObservationEvent(
        domain_id="domain:failure",
        source="failure-test",
        kind="synthetic",
        observed_at=NOW,
        payload={"ok": True},
    )

    failures = bus.publish(event)
    assert len(failures) == 1
    assert failures[0].error_type == "RuntimeError"
    assert seen == [event]


def test_stale_provider_fails_closed_without_apply():
    provider = MockProvider(health="STALE")
    receipt = dispatch(intent(), domain=domain(), grant=grant(), provider=provider, idempotency=IdempotencyStore())
    assert receipt.status == "FAILED"
    assert receipt.error["code"] == "PROVIDER_UNAVAILABLE"
    assert provider.apply_count == 0


def test_stale_fence_is_rejected_without_apply():
    provider = MockProvider(epoch=2)
    receipt = dispatch(intent(), domain=domain(), grant=grant(fence_epoch=1), provider=provider, idempotency=IdempotencyStore())
    assert receipt.status == "FAILED"
    assert receipt.error["code"] == "STALE_FENCE"
    assert provider.apply_count == 0


def test_duplicate_command_has_one_physical_apply_and_reuses_terminal_receipt():
    provider = MockProvider()
    store = IdempotencyStore()
    cmd = intent(key="idem:duplicate")
    first = dispatch(cmd, domain=domain(), grant=grant(), provider=provider, idempotency=store)
    second = dispatch(cmd, domain=domain(), grant=grant(), provider=provider, idempotency=store)
    assert first.receipt_id == second.receipt_id
    assert provider.apply_count == 1


def test_provider_exception_becomes_terminal_failure_and_retry_does_not_reapply():
    provider = MockProvider(raise_on_apply=True)
    store = IdempotencyStore()
    cmd = intent(key="idem:provider-exception")
    first = dispatch(cmd, domain=domain(), grant=grant(), provider=provider, idempotency=store)
    second = dispatch(cmd, domain=domain(), grant=grant(), provider=provider, idempotency=store)
    assert first.status == "FAILED"
    assert first.error["code"] == "PROVIDER_APPLY_FAILED"
    assert second.receipt_id == first.receipt_id
    assert provider.apply_count == 1


def test_receipt_observation_mismatch_is_not_reported_confirmed():
    provider = MockProvider(force_verification_mismatch=True)
    receipt = dispatch(intent(), domain=domain(), grant=grant(), provider=provider, idempotency=IdempotencyStore())
    assert receipt.status == "FAILED"
    assert receipt.error["code"] == "FAILED_VERIFICATION"
    assert receipt.actuation_skew["verification_match"] is False


def test_ai_timeout_is_contained_and_rule_fallback_survives():
    def slow(payload):
        time.sleep(0.1)
        return {"proposal": None}

    result = AIPolicyAdapter(slow, rule_policy=RulePolicy(), timeout_seconds=0.01).decide(summary(), now=NOW)
    assert result.ai_status == "TIMEOUT"
    assert result.used_fallback is True
    assert result.proposals
    assert result.proposals[0].policy_source == "RULE"


def test_ai_exception_is_contained_and_rule_fallback_survives():
    def explode(payload):
        raise RuntimeError("AI unavailable")

    result = AIPolicyAdapter(explode, rule_policy=RulePolicy()).decide(summary(), now=NOW)
    assert result.ai_status == "ERROR"
    assert result.used_fallback is True
    assert result.proposals
    assert result.proposals[0].policy_source == "RULE"


def test_stale_observation_blocks_ai_and_rule_mutation_in_same_cycle():
    calls = []

    def model(payload):
        calls.append(payload)
        return {"proposal": None}

    result = AIPolicyAdapter(model, rule_policy=RulePolicy()).decide(summary(observation_health="STALE"), now=NOW)
    assert calls == []
    assert result.ai_status == "BLOCKED"
    assert result.used_fallback is False
    assert result.proposals == []

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from phosphor_spacetime.control.intent import ActorRef, CommandIntent
from phosphor_spacetime.control.dispatcher import dispatch
from phosphor_spacetime.governance.authority import AuthorityGrant, IdempotencyStore
from phosphor_spacetime.ir.models import DomainLifecycle, DomainState
from phosphor_spacetime.providers.mock import MockProvider


def _intent(*, command_id: str = "cmd:1", key: str = "idem:1", action: str = "domain.pause", arguments: dict | None = None):
    now = datetime.now(timezone.utc)
    return CommandIntent(
        command_id=command_id,
        actor=ActorRef(actor_id="governor:test", actor_type="governor"),
        target_domain_id="domain:test",
        action=action,
        arguments=arguments or {},
        requested_at=now,
        expires_at=now + timedelta(minutes=1),
        policy_source="RULE",
        required_capabilities=[action],
        authority_ref="grant:test",
        evidence_refs=[],
        idempotency_key=key,
    )


def _grant(action: str = "domain.pause", fence_epoch: int = 1):
    now = datetime.now(timezone.utc)
    return AuthorityGrant(
        grant_id="grant:test",
        actor_id="governor:test",
        target_domain_ids={"domain:test"},
        actions={action},
        fence_epoch=fence_epoch,
        issued_at=now,
        expires_at=now + timedelta(minutes=1),
    )


def _domain():
    return DomainState(domain_id="domain:test", kind="PROCESS", lifecycle=DomainLifecycle.ATTACHED)


def test_mock_provider_dispatches_supported_pause_and_verifies_observed_state():
    provider = MockProvider(provider_id="mock:test", epoch=1)
    store = IdempotencyStore()
    receipt = dispatch(_intent(), domain=_domain(), grant=_grant(), provider=provider, idempotency=store)
    assert receipt.status == "CONFIRMED"
    assert receipt.requested == {"action": "domain.pause", "arguments": {}}
    assert receipt.realized["paused"] is True
    assert receipt.observed_after["paused"] is True
    assert receipt.actuation_skew["verification_match"] is True


def test_mock_provider_partial_temporal_rate_is_reported_partial_not_confirmed():
    provider = MockProvider(provider_id="mock:test", epoch=1, temporal_rate_mode="PARTIAL")
    store = IdempotencyStore()
    action = "domain.set_temporal_rate"
    receipt = dispatch(
        _intent(action=action, arguments={"rate": 3.0}),
        domain=_domain(),
        grant=_grant(action=action),
        provider=provider,
        idempotency=store,
    )
    assert receipt.status == "PARTIAL"
    assert receipt.realized["requested_rate"] == 3.0
    assert receipt.realized["realized_rate"] == 1.5


def test_duplicate_idempotency_key_returns_same_receipt_without_second_actuation():
    provider = MockProvider(provider_id="mock:test", epoch=1)
    store = IdempotencyStore()
    intent = _intent()
    first = dispatch(intent, domain=_domain(), grant=_grant(), provider=provider, idempotency=store)
    second = dispatch(intent, domain=_domain(), grant=_grant(), provider=provider, idempotency=store)
    assert second.receipt_id == first.receipt_id
    assert provider.apply_count == 1


def test_provider_success_with_mismatching_post_observation_is_not_false_success():
    provider = MockProvider(provider_id="mock:test", epoch=1, force_verification_mismatch=True)
    store = IdempotencyStore()
    receipt = dispatch(_intent(), domain=_domain(), grant=_grant(), provider=provider, idempotency=store)
    assert receipt.status == "FAILED"
    assert receipt.error["code"] == "FAILED_VERIFICATION"
    assert receipt.actuation_skew["verification_match"] is False


def test_stale_provider_health_rejects_mutation_before_apply():
    provider = MockProvider(provider_id="mock:test", epoch=1, health="STALE")
    store = IdempotencyStore()
    receipt = dispatch(_intent(), domain=_domain(), grant=_grant(), provider=provider, idempotency=store)
    assert receipt.status == "FAILED"
    assert receipt.error["code"] == "PROVIDER_UNAVAILABLE"
    assert provider.apply_count == 0


def test_provider_exception_becomes_terminal_failed_receipt_and_is_idempotent():
    provider = MockProvider(provider_id="mock:test", epoch=1, raise_on_apply=True)
    store = IdempotencyStore()
    intent = _intent(command_id="cmd:exception", key="idem:exception")
    first = dispatch(intent, domain=_domain(), grant=_grant(), provider=provider, idempotency=store)
    second = dispatch(intent, domain=_domain(), grant=_grant(), provider=provider, idempotency=store)
    assert first.status == "FAILED"
    assert first.error["code"] == "PROVIDER_APPLY_FAILED"
    assert second.receipt_id == first.receipt_id
    assert provider.apply_count == 1

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from phosphor_spacetime.control.intent import ActorRef, CommandIntent
from phosphor_spacetime.control.validator import CapabilitySpec, validate_intent
from phosphor_spacetime.governance.authority import AuthorityGrant, IdempotencyStore
from phosphor_spacetime.ir.models import DomainLifecycle, DomainState


def _intent(*, action: str = "domain.pause", expires_delta_s: int = 60) -> CommandIntent:
    now = datetime.now(timezone.utc)
    return CommandIntent(
        command_id="cmd:test",
        actor=ActorRef(actor_id="governor:test", actor_type="governor"),
        target_domain_id="domain:test",
        action=action,
        arguments={},
        requested_at=now,
        expires_at=now + timedelta(seconds=expires_delta_s),
        policy_source="RULE",
        required_capabilities=[action],
        authority_ref="grant:test",
        evidence_refs=[],
        idempotency_key="idem:test",
    )


def _domain() -> DomainState:
    return DomainState(
        domain_id="domain:test",
        kind="PROCESS",
        lifecycle=DomainLifecycle.ATTACHED,
    )


def _capability(*, support: str = "SUPPORTED", provider_epoch: int = 5, bounds: dict | None = None) -> CapabilitySpec:
    return CapabilitySpec(
        name="domain.pause",
        support=support,
        provider_epoch=provider_epoch,
        bounds=bounds,
    )


def _grant(*, actions: set[str] | None = None, fence_epoch: int = 5, expires_delta_s: int = 60) -> AuthorityGrant:
    now = datetime.now(timezone.utc)
    return AuthorityGrant(
        grant_id="grant:test",
        actor_id="governor:test",
        target_domain_ids={"domain:test"},
        actions=actions or {"domain.pause"},
        fence_epoch=fence_epoch,
        issued_at=now,
        expires_at=now + timedelta(seconds=expires_delta_s),
    )


def test_mutation_without_authority_is_rejected():
    result = validate_intent(_intent(), _domain(), _capability(), None)
    assert result.allowed is False
    assert result.reason == "AUTHORITY_DENIED"


def test_unsupported_capability_is_rejected():
    result = validate_intent(_intent(), _domain(), _capability(support="UNSUPPORTED"), _grant())
    assert result.allowed is False
    assert result.reason == "CAPABILITY_UNSUPPORTED"


def test_stale_authority_fence_is_rejected():
    result = validate_intent(_intent(), _domain(), _capability(provider_epoch=5), _grant(fence_epoch=4))
    assert result.allowed is False
    assert result.reason == "STALE_FENCE"


def test_expired_intent_is_rejected():
    result = validate_intent(_intent(expires_delta_s=-1), _domain(), _capability(), _grant())
    assert result.allowed is False
    assert result.reason == "INTENT_EXPIRED"


def test_out_of_bounds_temporal_rate_is_rejected():
    intent = _intent(action="domain.set_temporal_rate").model_copy(update={"arguments": {"rate": 12.0}, "required_capabilities": ["domain.set_temporal_rate"]})
    capability = CapabilitySpec(
        name="domain.set_temporal_rate",
        support="SUPPORTED",
        provider_epoch=5,
        bounds={"rate": {"min": 0.0, "max": 4.0}},
    )
    grant = _grant(actions={"domain.set_temporal_rate"})
    result = validate_intent(intent, _domain(), capability, grant)
    assert result.allowed is False
    assert result.reason == "ARGUMENT_OUT_OF_BOUNDS"


def test_matching_authority_and_capability_is_allowed():
    result = validate_intent(_intent(), _domain(), _capability(), _grant())
    assert result.allowed is True
    assert result.reason == "AUTHORIZED"


def test_idempotency_store_claims_key_once_and_returns_terminal_receipt():
    store = IdempotencyStore()
    assert store.claim("idem:test") is True
    assert store.claim("idem:test") is False
    store.complete("idem:test", receipt_id="receipt:1")
    assert store.receipt_for("idem:test") == "receipt:1"

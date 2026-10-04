from __future__ import annotations

from phosphor_spacetime.control.intent import CommandIntent
from phosphor_spacetime.control.receipts import ActuationReceipt
from phosphor_spacetime.control.validator import validate_intent
from phosphor_spacetime.governance.authority import AuthorityGrant, IdempotencyStore
from phosphor_spacetime.ir.models import DomainState
from phosphor_spacetime.providers.base import Provider

_MUTATING_ACTIONS = {
    "domain.pause",
    "domain.resume",
    "domain.set_temporal_rate",
    "domain.set_resource_budget",
    "domain.set_observation_profile",
    "domain.snapshot",
    "domain.restore",
}


def dispatch(
    intent: CommandIntent,
    *,
    domain: DomainState,
    grant: AuthorityGrant | None,
    provider: Provider,
    idempotency: IdempotencyStore,
) -> ActuationReceipt:
    prior = idempotency.record_for(intent.idempotency_key)
    if prior is not None:
        return prior

    requested = {"action": intent.action, "arguments": dict(intent.arguments)}

    if provider.health not in {"HEALTHY", "DEGRADED"}:
        receipt = ActuationReceipt.failed(
            command_id=intent.command_id,
            provider=provider.provider_ref,
            requested=requested,
            code="PROVIDER_UNAVAILABLE",
            detail=f"provider health is {provider.health}",
            fence_epoch=provider.provider_ref.epoch,
            idempotency_key=intent.idempotency_key,
        )
        idempotency.complete(intent.idempotency_key, receipt_id=receipt.receipt_id, receipt=receipt)
        return receipt

    capability = provider.capability_for(intent.action)
    result = validate_intent(intent, domain, capability, grant)
    if not result.allowed:
        receipt = ActuationReceipt.failed(
            command_id=intent.command_id,
            provider=provider.provider_ref,
            requested=requested,
            code=result.reason,
            detail="command rejected by validation/authority gate",
            fence_epoch=provider.provider_ref.epoch,
            idempotency_key=intent.idempotency_key,
        )
        idempotency.complete(intent.idempotency_key, receipt_id=receipt.receipt_id, receipt=receipt)
        return receipt

    if not idempotency.claim(intent.idempotency_key):
        prior = idempotency.record_for(intent.idempotency_key)
        if prior is not None:
            return prior
        receipt = ActuationReceipt.failed(
            command_id=intent.command_id,
            provider=provider.provider_ref,
            requested=requested,
            code="IDEMPOTENCY_IN_PROGRESS",
            detail="idempotency key is already claimed without a terminal receipt",
            fence_epoch=provider.provider_ref.epoch,
            idempotency_key=intent.idempotency_key,
        )
        return receipt

    try:
        receipt = provider.apply(intent)
    except Exception as exc:
        receipt = ActuationReceipt.failed(
            command_id=intent.command_id,
            provider=provider.provider_ref,
            requested=requested,
            code="PROVIDER_APPLY_FAILED",
            detail=f"provider apply raised {type(exc).__name__}: {exc}",
            fence_epoch=provider.provider_ref.epoch,
            idempotency_key=intent.idempotency_key,
        )
        idempotency.complete(intent.idempotency_key, receipt_id=receipt.receipt_id, receipt=receipt)
        return receipt

    verified, observed = provider.verify(receipt)
    receipt.observed_after = observed
    receipt.actuation_skew = {"verification_match": verified}
    if not verified:
        receipt.status = "FAILED"
        receipt.error = {
            "code": "FAILED_VERIFICATION",
            "detail": "provider realized state did not match independent post-observation",
        }
    idempotency.complete(intent.idempotency_key, receipt_id=receipt.receipt_id, receipt=receipt)
    return receipt

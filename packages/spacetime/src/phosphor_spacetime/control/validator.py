from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from phosphor_spacetime.control.intent import CommandIntent
from phosphor_spacetime.governance.authority import AuthorityGrant
from phosphor_spacetime.ir.models import DomainLifecycle, DomainState

SupportLevel = Literal["SUPPORTED", "PARTIAL", "UNSUPPORTED"]


class CapabilitySpec(BaseModel):
    model_config = ConfigDict(extra="allow")

    name: str = Field(min_length=1)
    support: SupportLevel
    provider_epoch: int = Field(ge=0)
    bounds: dict[str, Any] | None = None


class ValidationResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    allowed: bool
    reason: str


def _arguments_within_bounds(arguments: dict[str, Any], bounds: dict[str, Any] | None) -> bool:
    if not bounds:
        return True
    for key, rule in bounds.items():
        if key not in arguments:
            continue
        value = arguments[key]
        if not isinstance(rule, dict) or not isinstance(value, (int, float)):
            continue
        minimum = rule.get("min")
        maximum = rule.get("max")
        if minimum is not None and value < minimum:
            return False
        if maximum is not None and value > maximum:
            return False
    return True


def validate_intent(
    intent: CommandIntent,
    domain: DomainState,
    capability: CapabilitySpec | None,
    grant: AuthorityGrant | None,
    *,
    now: datetime | None = None,
) -> ValidationResult:
    """Validate a single provider-bound intent without executing it."""

    now = now or datetime.now(timezone.utc)

    if intent.expires_at is not None and now >= intent.expires_at:
        return ValidationResult(allowed=False, reason="INTENT_EXPIRED")
    if intent.target_domain_id != domain.domain_id:
        return ValidationResult(allowed=False, reason="TARGET_MISMATCH")
    if domain.lifecycle in {DomainLifecycle.DETACHED, DomainLifecycle.FAILED}:
        return ValidationResult(allowed=False, reason="DOMAIN_UNAVAILABLE")
    if capability is None or capability.name != intent.action:
        return ValidationResult(allowed=False, reason="CAPABILITY_MISSING")
    if capability.support == "UNSUPPORTED":
        return ValidationResult(allowed=False, reason="CAPABILITY_UNSUPPORTED")
    if intent.action not in intent.required_capabilities:
        return ValidationResult(allowed=False, reason="CAPABILITY_NOT_DECLARED")
    if not _arguments_within_bounds(intent.arguments, capability.bounds):
        return ValidationResult(allowed=False, reason="ARGUMENT_OUT_OF_BOUNDS")
    if grant is None or intent.authority_ref != grant.grant_id:
        return ValidationResult(allowed=False, reason="AUTHORITY_DENIED")
    if not grant.authorizes(
        actor_id=intent.actor.actor_id,
        target_domain_id=intent.target_domain_id,
        action=intent.action,
        at=now,
    ):
        return ValidationResult(allowed=False, reason="AUTHORITY_DENIED")
    if grant.fence_epoch != capability.provider_epoch:
        return ValidationResult(allowed=False, reason="STALE_FENCE")
    return ValidationResult(allowed=True, reason="AUTHORIZED")

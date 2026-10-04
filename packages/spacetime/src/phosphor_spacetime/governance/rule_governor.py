from __future__ import annotations

from datetime import datetime, timezone

from pydantic import BaseModel, ConfigDict, Field, model_validator

from phosphor_spacetime.governance.policy import GovernanceSummary, PolicyProposal


class RulePolicy(BaseModel):
    """Deterministic M7 thresholds and stability bounds.

    The low/high pairs define hysteresis bands.  ``*_step`` describes the
    requested adjustment size while ``*_max_delta`` is a hard per-decision
    safety bound.
    """

    model_config = ConfigDict(extra="forbid")

    debt_low: float = Field(default=1.0, ge=0.0)
    debt_high: float = Field(default=5.0, ge=0.0)
    pressure_low: float = Field(default=0.35, ge=0.0, le=1.0)
    pressure_high: float = Field(default=0.80, ge=0.0, le=1.0)
    criticality_low: float = Field(default=0.30, ge=0.0, le=1.0)
    criticality_high: float = Field(default=0.70, ge=0.0, le=1.0)

    cpu_budget_min: float = Field(default=0.10, ge=0.0, le=1.0)
    cpu_budget_max: float = Field(default=1.00, ge=0.0, le=1.0)
    cpu_budget_step: float = Field(default=0.10, gt=0.0)
    cpu_budget_max_delta: float = Field(default=0.10, gt=0.0)

    temporal_rate_floor: float = Field(default=0.25, ge=0.0)
    temporal_rate_ceiling: float = Field(default=4.0, ge=0.0)
    temporal_rate_step: float = Field(default=0.50, gt=0.0)
    temporal_rate_max_delta: float = Field(default=0.50, gt=0.0)

    cooldown_seconds: float = Field(default=5.0, ge=0.0)

    @model_validator(mode="after")
    def _validate_ranges(self) -> "RulePolicy":
        if self.debt_low >= self.debt_high:
            raise ValueError("debt_low must be lower than debt_high")
        if self.pressure_low >= self.pressure_high:
            raise ValueError("pressure_low must be lower than pressure_high")
        if self.criticality_low >= self.criticality_high:
            raise ValueError("criticality_low must be lower than criticality_high")
        if self.cpu_budget_min > self.cpu_budget_max:
            raise ValueError("cpu_budget_min must not exceed cpu_budget_max")
        if self.temporal_rate_floor > self.temporal_rate_ceiling:
            raise ValueError("temporal_rate_floor must not exceed temporal_rate_ceiling")
        return self


def _proposal(summary: GovernanceSummary, operation: str, value: float | str | bool, reason: str) -> PolicyProposal:
    return PolicyProposal(
        target_domain_id=summary.domain_id,
        operation=operation,
        value=value,
        reason=reason,
        policy_source="RULE",
        evidence_refs=list(summary.evidence_refs),
    )


def _cooldown_active(summary: GovernanceSummary, policy: RulePolicy, now: datetime) -> bool:
    if summary.last_policy_change_at is None or policy.cooldown_seconds <= 0:
        return False
    last = summary.last_policy_change_at
    if last.tzinfo is None:
        last = last.replace(tzinfo=timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return (now - last).total_seconds() < policy.cooldown_seconds


def _increase(value: float, *, step: float, max_delta: float, ceiling: float) -> float:
    delta = min(step, max_delta)
    return min(ceiling, value + delta)


def _decrease(value: float, *, step: float, max_delta: float, floor: float) -> float:
    delta = min(step, max_delta)
    return max(floor, value - delta)


def decide(
    summary: GovernanceSummary,
    policy: RulePolicy,
    *,
    now: datetime | None = None,
) -> list[PolicyProposal]:
    """Return at most one deterministic proposal for one governance cycle.

    M7 intentionally serializes control-surface changes.  This makes cooldown,
    attribution, and later B1/B2 comparisons unambiguous.  A future policy may
    batch orthogonal actions once the benchmark evidence justifies it.
    """

    now = now or datetime.now(timezone.utc)

    # Stale/error observation must never drive adaptive mutation.
    if summary.observation_health != "HEALTHY":
        return []
    if _cooldown_active(summary, policy, now):
        return []

    high_debt = summary.temporal_debt >= policy.debt_high
    low_debt = summary.temporal_debt <= policy.debt_low
    high_pressure = summary.resource_pressure >= policy.pressure_high
    quiet_pressure = summary.resource_pressure <= policy.pressure_low
    high_criticality = summary.causal_criticality >= policy.criticality_high
    low_criticality = summary.causal_criticality <= policy.criticality_low

    # A critical domain that accumulated debt while paused should first resume;
    # changing rate/budget while paused would hide the most immediate cause.
    if summary.paused:
        if high_debt and high_criticality and summary.resume_supported:
            return [_proposal(summary, "RESUME", True, "CRITICAL_DEBT_RESUME")]
        return []

    # Protect foreground/critical work by shrinking low-criticality background
    # budgets under pressure.  Pause only after the semantic CPU budget has
    # reached the configured floor.
    if summary.role == "BACKGROUND" and high_pressure and low_criticality:
        if summary.resource_budget_supported and summary.current_cpu_budget_fraction > policy.cpu_budget_min:
            target = _decrease(
                summary.current_cpu_budget_fraction,
                step=policy.cpu_budget_step,
                max_delta=policy.cpu_budget_max_delta,
                floor=policy.cpu_budget_min,
            )
            if target < summary.current_cpu_budget_fraction:
                return [_proposal(summary, "SET_CPU_BUDGET_FRACTION", target, "BACKGROUND_PRESSURE_RELIEF")]
        if summary.pause_supported:
            return [_proposal(summary, "PAUSE", True, "BACKGROUND_PRESSURE_PAUSE")]

    # Critical temporal debt prefers a semantic/native time control.  Only when
    # that capability is unavailable does the governor fall back to more CPU
    # service, preserving Time != Compute.
    if high_debt and high_criticality:
        if summary.native_temporal_rate_supported and summary.current_temporal_rate < policy.temporal_rate_ceiling:
            target = _increase(
                summary.current_temporal_rate,
                step=policy.temporal_rate_step,
                max_delta=policy.temporal_rate_max_delta,
                ceiling=policy.temporal_rate_ceiling,
            )
            if target > summary.current_temporal_rate:
                return [_proposal(summary, "SET_TEMPORAL_RATE", target, "HIGH_TEMPORAL_DEBT_CRITICAL_DOMAIN")]

        if summary.resource_budget_supported and summary.current_cpu_budget_fraction < policy.cpu_budget_max:
            target = _increase(
                summary.current_cpu_budget_fraction,
                step=policy.cpu_budget_step,
                max_delta=policy.cpu_budget_max_delta,
                ceiling=policy.cpu_budget_max,
            )
            if target > summary.current_cpu_budget_fraction:
                return [_proposal(summary, "SET_CPU_BUDGET_FRACTION", target, "HIGH_TEMPORAL_DEBT_RESOURCE_FALLBACK")]

        if (
            summary.observation_profile_supported
            and summary.current_observation_profile in {"MINIMAL", "NORMAL"}
        ):
            return [_proposal(summary, "SET_OBSERVATION_PROFILE", "FOCUSED", "CRITICAL_DOMAIN_NEEDS_MORE_EVIDENCE")]

    # The low threshold closes the hysteresis loop: only after debt falls below
    # debt_low do we unwind a previously raised native logical rate toward 1x.
    if low_debt and quiet_pressure and summary.native_temporal_rate_supported and summary.current_temporal_rate > 1.0:
        target = _decrease(
            summary.current_temporal_rate,
            step=policy.temporal_rate_step,
            max_delta=policy.temporal_rate_max_delta,
            floor=max(1.0, policy.temporal_rate_floor),
        )
        if target < summary.current_temporal_rate:
            return [_proposal(summary, "SET_TEMPORAL_RATE", target, "LOW_DEBT_NORMALIZE_TEMPORAL_RATE")]

    # Quiet, low-criticality background work can reduce observation cost after
    # the high-pressure/critical-debt branches have had first priority.
    if (
        summary.role == "BACKGROUND"
        and low_debt
        and quiet_pressure
        and low_criticality
        and summary.observation_profile_supported
        and summary.current_observation_profile != "MINIMAL"
    ):
        return [_proposal(summary, "SET_OBSERVATION_PROFILE", "MINIMAL", "QUIET_BACKGROUND_OBSERVATION_REDUCTION")]

    return []

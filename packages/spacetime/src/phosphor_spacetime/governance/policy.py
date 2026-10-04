from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from phosphor_spacetime.ir.models import EvidenceRef

DomainRole = Literal["INTERACTIVE", "NORMAL", "BACKGROUND"]
ObservationHealth = Literal["HEALTHY", "STALE", "ERROR"]
ObservationProfile = Literal["MINIMAL", "NORMAL", "FOCUSED", "FORENSIC", "CUSTOM"]
PolicyOperation = Literal[
    "SET_TEMPORAL_RATE",
    "SET_CPU_BUDGET_FRACTION",
    "SET_OBSERVATION_PROFILE",
    "PAUSE",
    "RESUME",
]
PolicySource = Literal["RULE", "AI", "HUMAN", "STATIC"]


class GovernanceSummary(BaseModel):
    """Compact, provider-neutral input consumed by governance policies.

    Values here are summaries, not raw telemetry.  In particular,
    ``current_cpu_budget_fraction`` is a semantic budget target in [0, 1],
    not a Linux ``cpu.weight`` or Windows Job Object field.
    """

    model_config = ConfigDict(extra="forbid")

    domain_id: str = Field(min_length=1)
    role: DomainRole = "NORMAL"
    temporal_debt: float = Field(default=0.0, ge=0.0)
    resource_pressure: float = Field(default=0.0, ge=0.0, le=1.0)
    causal_criticality: float = Field(default=0.0, ge=0.0, le=1.0)
    observation_health: ObservationHealth = "HEALTHY"

    current_cpu_budget_fraction: float = Field(default=0.5, ge=0.0, le=1.0)
    current_temporal_rate: float = Field(default=1.0, ge=0.0)
    current_observation_profile: ObservationProfile = "NORMAL"
    paused: bool = False

    native_temporal_rate_supported: bool = False
    resource_budget_supported: bool = False
    observation_profile_supported: bool = False
    pause_supported: bool = False
    resume_supported: bool = False

    last_policy_change_at: datetime | None = None
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)


class PolicyProposal(BaseModel):
    """A bounded governance proposal, never ambient execution authority."""

    model_config = ConfigDict(extra="forbid")

    target_domain_id: str = Field(min_length=1)
    operation: PolicyOperation
    value: float | str | bool
    reason: str = Field(min_length=1)
    policy_source: PolicySource
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

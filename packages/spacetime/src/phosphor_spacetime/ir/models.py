from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


class DomainLifecycle(str, Enum):
    DISCOVERED = "DISCOVERED"
    REGISTERED = "REGISTERED"
    ATTACHED = "ATTACHED"
    ACTIVE = "ACTIVE"
    PAUSED = "PAUSED"
    FROZEN = "FROZEN"
    DEGRADED = "DEGRADED"
    DETACHED = "DETACHED"
    FAILED = "FAILED"


class EvidenceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: str
    id: str
    kind: str
    level: Literal["observed", "inferred", "hypothesized", "verified", "unknown"] | None = None
    uri: str | None = None


class TemporalState(BaseModel):
    model_config = ConfigDict(extra="allow")

    time_class: Literal["ANCHORED", "ELASTIC", "EVENT_JUMP", "REPLAY", "SPECULATIVE", "FROZEN", "UNKNOWN"] = "UNKNOWN"
    reference_clock: str | None = None
    local_time: float | None = None
    requested_rate: float | None = Field(default=None, ge=0)
    realized_rate: float | None = Field(default=None, ge=0)
    drift: float | None = None
    temporal_debt: float | None = Field(default=None, ge=0)
    max_skew: float | None = Field(default=None, ge=0)
    event_jump_allowed: bool | None = None
    approximation_allowed: bool | None = None


class DomainState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    domain_id: str
    parent_domain_id: str | None = None
    kind: str
    lifecycle: DomainLifecycle = DomainLifecycle.REGISTERED
    temporal: TemporalState = Field(default_factory=TemporalState)
    resources: dict[str, Any] = Field(default_factory=dict)
    observation: dict[str, Any] = Field(default_factory=dict)
    causality: dict[str, Any] | None = None
    governance: dict[str, Any] | None = Field(default_factory=dict)
    capabilities: list[dict[str, Any]] = Field(default_factory=list)
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)


class SpacetimeSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["ssm-ir-v0.1"] = "ssm-ir-v0.1"
    snapshot_id: str
    captured_at: datetime
    machine: dict[str, Any] | None = None
    global_resources: dict[str, Any] | None = None
    governance: dict[str, Any] | None = None
    domains: list[DomainState]
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)

    @classmethod
    def new(cls, *, domains: list[DomainState] | None = None, snapshot_id: str | None = None) -> "SpacetimeSnapshot":
        return cls(snapshot_id=snapshot_id or f"ssm:{uuid4()}", captured_at=datetime.now(timezone.utc), domains=list(domains or []))

    def get_domain(self, domain_id: str) -> DomainState:
        for domain in self.domains:
            if domain.domain_id == domain_id:
                return domain
        raise KeyError(f"unknown domain: {domain_id}")

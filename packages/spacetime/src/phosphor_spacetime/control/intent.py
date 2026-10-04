from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from phosphor_spacetime.ir.models import EvidenceRef

ActorType = Literal["human", "ai", "governor", "system"]
CommandState = Literal[
    "DRAFT", "VALIDATED", "AUTHORIZED", "DISPATCHED", "EXECUTED",
    "REJECTED", "FAILED", "EXPIRED", "CANCELLED",
]
PolicySource = Literal["STATIC", "RULE", "AI", "HUMAN"]
ActionName = Literal[
    "domain.inspect",
    "domain.pause",
    "domain.resume",
    "domain.set_temporal_rate",
    "domain.set_resource_budget",
    "domain.set_observation_profile",
    "domain.snapshot",
    "domain.restore",
]


class ActorRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    actor_id: str = Field(min_length=1)
    actor_type: ActorType


class CommandIntent(BaseModel):
    """An untrusted request. Construction never grants provider authority."""

    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["ssm-control-v0.1"] = "ssm-control-v0.1"
    command_id: str = Field(min_length=1)
    state: CommandState = "DRAFT"
    actor: ActorRef
    target_domain_id: str = Field(min_length=1)
    action: ActionName
    arguments: dict[str, Any] = Field(default_factory=dict)
    requested_at: datetime
    expires_at: datetime | None = None
    policy_source: PolicySource
    required_capabilities: list[str] = Field(default_factory=list)
    authority_ref: str | None = None
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)
    idempotency_key: str = Field(min_length=1)

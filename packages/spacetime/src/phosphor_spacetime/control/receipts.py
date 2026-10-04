from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from phosphor_spacetime.ir.models import EvidenceRef

ReceiptStatus = Literal[
    "ACCEPTED", "APPLYING", "CONFIRMED", "PARTIAL", "FAILED",
    "ROLLED_BACK", "COMPENSATED", "EXPIRED",
]


class ProviderRef(BaseModel):
    model_config = ConfigDict(extra="allow")

    provider_id: str
    instance_id: str
    epoch: int = Field(ge=0)


class ActuationReceipt(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["ssm-actuation-receipt-v0.1"] = "ssm-actuation-receipt-v0.1"
    receipt_id: str
    command_id: str
    provider: ProviderRef
    status: ReceiptStatus
    started_at: datetime
    finished_at: datetime | None = None
    before: dict[str, Any] | None = None
    desired: dict[str, Any] | None = None
    requested: dict[str, Any]
    realized: dict[str, Any] | None = None
    observed_after: dict[str, Any] | None = None
    actuation_skew: dict[str, Any] | None = None
    fence_epoch: int | None = Field(default=None, ge=0)
    idempotency_key: str | None = None
    error: Any = None
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)

    @classmethod
    def failed(
        cls,
        *,
        command_id: str,
        provider: ProviderRef,
        requested: dict[str, Any],
        code: str,
        detail: str,
        fence_epoch: int | None = None,
        idempotency_key: str | None = None,
    ) -> "ActuationReceipt":
        now = datetime.now(timezone.utc)
        return cls(
            receipt_id=f"receipt:{uuid4()}",
            command_id=command_id,
            provider=provider,
            status="FAILED",
            started_at=now,
            finished_at=now,
            requested=requested,
            fence_epoch=fence_epoch,
            idempotency_key=idempotency_key,
            error={"code": code, "detail": detail},
            evidence_refs=[],
        )

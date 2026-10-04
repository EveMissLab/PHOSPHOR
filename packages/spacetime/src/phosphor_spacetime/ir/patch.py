from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .models import EvidenceRef


class IRPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")

    domain_id: str
    source: str
    timestamp: datetime
    epistemic_level: Literal["observed", "inferred", "hypothesized", "verified", "unknown"]
    fields: dict[str, Any]
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)

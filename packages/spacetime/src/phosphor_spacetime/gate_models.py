from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

GateId = Literal[
    "G0_CONTRACT",
    "G1_OBSERVATION_IR",
    "G2_SAFE_ACTUATION",
    "G3_TEMPORAL_SEMANTICS",
    "G4_CAUSAL_GOVERNANCE",
    "G5_AI_HIERARCHICAL",
    "G6_END_TO_END",
]


class GateCheckError(RuntimeError):
    pass


class GateResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    gate_id: GateId
    name: str
    passed: bool
    evidence: dict[str, Any] = Field(default_factory=dict)
    failures: list[str] = Field(default_factory=list)


class GateReport(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: Literal["ssm-gate-report-v0.1"] = "ssm-gate-report-v0.1"
    run_id: str
    git_commit: str
    started_at: datetime
    finished_at: datetime
    passed: bool
    passed_gate_count: int = Field(ge=0)
    failed_gate_count: int = Field(ge=0)
    performance_hypotheses_evaluated: bool = False
    gates: list[GateResult]
    report_path: str

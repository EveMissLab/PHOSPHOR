from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

Baseline = Literal["B0_NATIVE", "B1_FIXED", "B2_RULE", "B3_AI"]
WorkloadId = Literal[
    "A_ANCHORED",
    "B_ELASTIC_CPU",
    "C_EVENT_SPARSE",
    "D_CAUSAL_DAG",
    "E_MIXED",
]


class WorkloadOutcome(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metrics: dict[str, int | float] = Field(default_factory=dict)
    correctness_checks: dict[str, bool] = Field(default_factory=dict)
    state_hash: str | None = None
    details: dict[str, Any] = Field(default_factory=dict)

    @property
    def valid(self) -> bool:
        return bool(self.correctness_checks) and all(self.correctness_checks.values())


@dataclass(frozen=True)
class RunRecord:
    run_id: str
    run_dir: Path
    workload: str
    baseline: str
    valid: bool

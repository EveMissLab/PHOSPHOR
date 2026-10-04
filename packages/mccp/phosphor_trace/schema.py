"""Canonical trace/graph/explanation data model shared by every phosphor_* module.

phosphor_collector emits raw per-source events (viztracer / OpenTelemetry shaped).
phosphor_trace normalizes them into TraceEvent — the one event shape everything
downstream sees. phosphor_graph folds TraceEvents into Node/Edge (never one
edge per call — see EdgeDynamics.event_refs). phosphor_explain emits Explanation
objects whose claims must cite real event_ids; nothing may assert unobserved
behavior (Hallucination Control, whitepaper §24).
"""

from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class EvidenceLevel(str, Enum):
    OBSERVED = "observed"
    INFERRED = "inferred"
    HYPOTHESIZED = "hypothesized"
    VERIFIED = "verified"


class Evidence(BaseModel):
    level: EvidenceLevel
    confidence: float = Field(ge=0.0, le=1.0)


class SourceLocation(BaseModel):
    file: str
    line: int | None = None
    function: str | None = None


class RuntimeContext(BaseModel):
    pid: int
    tid: int


EventType = Literal[
    "function_call",
    "function_return",
    "network_request",
    "file_io",
    "db_query",
    "error",
    "memory_sample",
]


class TraceEvent(BaseModel):
    """One normalized event, regardless of whether it came from viztracer or OTel."""

    event_id: str
    trace_id: str
    timestamp: float
    type: EventType
    source: SourceLocation
    runtime: RuntimeContext
    duration_ms: float | None = None
    parent_event: str | None = None
    resource: dict[str, str] | None = None
    evidence: Evidence = Field(default_factory=lambda: Evidence(level=EvidenceLevel.OBSERVED, confidence=1.0))


NodeType = Literal["function", "file", "process", "thread", "host", "database"]


class Node(BaseModel):
    node_id: str
    node_type: NodeType
    label: str
    attributes: dict[str, str | int] = Field(default_factory=dict)


class EdgeDynamics(BaseModel):
    count: int
    total_duration_ms: float
    avg_latency_ms: float
    event_refs: list[str]


EdgeRelation = Literal["calls", "reads", "writes", "invokes", "depends_on"]


class Edge(BaseModel):
    edge_id: str
    source: str
    target: str
    relation: EdgeRelation
    dynamic: EdgeDynamics


class ComputationalGraph(BaseModel):
    trace_id: str
    nodes: list[Node]
    edges: list[Edge]


class ExplanationClaim(BaseModel):
    text: str
    evidence_level: EvidenceLevel
    evidence_refs: list[str] = Field(default_factory=list)


class Explanation(BaseModel):
    target_node_id: str
    local: ExplanationClaim
    function_role: ExplanationClaim | None = None
    runtime_effect: ExplanationClaim | None = None
    risk: ExplanationClaim | None = None

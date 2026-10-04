"""Unit tests for phosphor_explain.explain.

Fully offline: every test that exercises ``explain()`` injects a fake/stub
Anthropic client (see ``_FakeClient`` below) -- there is no live network
call and no real API key is required anywhere in this file.

The single most important test here is
``test_observed_claim_with_fabricated_ref_is_downgraded`` -- it proves that
Hallucination Control is enforced in code, not merely requested via prompt:
a canned model response that marks a claim "observed" while citing an
evidence_ref that was never actually gathered gets caught and downgraded
before it is returned to the caller.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from phosphor_collector.collect import collect
from phosphor_explain.explain import (
    _EVENT_BUDGET_TOTAL,
    _MIN_EVENTS_PER_EDGE_FLOOR,
    _build_prompt,
    explain,
    gather_evidence,
)
from phosphor_graph.build import build_graph
from phosphor_trace.normalize import normalize
from phosphor_trace.schema import (
    ComputationalGraph,
    Edge,
    EdgeDynamics,
    Evidence,
    EvidenceLevel,
    Explanation,
    Node,
    RuntimeContext,
    SourceLocation,
    TraceEvent,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
CPU_LOOP_SCRIPT = REPO_ROOT / "demo_targets" / "cpu_loop.py"

# ---------------------------------------------------------------------------
# Shared synthetic fixtures
# ---------------------------------------------------------------------------


def _evidence(level: EvidenceLevel = EvidenceLevel.OBSERVED) -> Evidence:
    return Evidence(level=level, confidence=1.0)


def _event(
    event_id: str,
    *,
    parent: str | None = None,
    ts: float = 1.0,
    event_type: str = "function_call",
    duration_ms: float = 2.5,
) -> TraceEvent:
    return TraceEvent(
        event_id=event_id,
        trace_id="trace-1",
        timestamp=ts,
        type=event_type,
        source=SourceLocation(file="app.py", line=10, function="do_work"),
        runtime=RuntimeContext(pid=100, tid=1),
        duration_ms=duration_ms,
        parent_event=parent,
        resource=None,
        evidence=_evidence(),
    )


def _node(node_id: str, label: str) -> Node:
    return Node(node_id=node_id, node_type="function", label=label, attributes={"file": "app.py"})


def _edge(edge_id: str, source: str, target: str, event_refs: list[str]) -> Edge:
    return Edge(
        edge_id=edge_id,
        source=source,
        target=target,
        relation="calls",
        dynamic=EdgeDynamics(
            count=len(event_refs),
            total_duration_ms=2.5 * len(event_refs),
            avg_latency_ms=2.5,
            event_refs=event_refs,
        ),
    )


def _build_graph_and_events() -> tuple[ComputationalGraph, list[TraceEvent], dict[str, str]]:
    """A small graph: A -> B (edge e_ab, backed by ev1/ev2), C -> D (edge
    e_cd, backed by ev3) -- A/B and C/D are disjoint components, so a
    gather_evidence(..., target_node_id=A) call must never see anything
    about C, D, e_cd, or ev3.
    """
    node_a = _node("node_a", "A")
    node_b = _node("node_b", "B")
    node_c = _node("node_c", "C")
    node_d = _node("node_d", "D")

    ev1 = _event("ev1")
    ev2 = _event("ev2")
    ev3 = _event("ev3")  # only referenced by the C->D edge

    edge_ab = _edge("edge_ab", node_a.node_id, node_b.node_id, ["ev1", "ev2"])
    edge_cd = _edge("edge_cd", node_c.node_id, node_d.node_id, ["ev3"])

    graph = ComputationalGraph(
        trace_id="trace-1",
        nodes=[node_a, node_b, node_c, node_d],
        edges=[edge_ab, edge_cd],
    )
    events = [ev1, ev2, ev3]
    ids = {"a": node_a.node_id, "b": node_b.node_id, "c": node_c.node_id, "d": node_d.node_id}
    return graph, events, ids


# ---------------------------------------------------------------------------
# gather_evidence -- scope-boundary tests
# ---------------------------------------------------------------------------


def test_gather_evidence_returns_only_directly_connected_edges_and_events():
    graph, events, ids = _build_graph_and_events()

    evidence = gather_evidence(graph, events, ids["a"])

    assert evidence["target_node"]["node_id"] == ids["a"]

    edge_ids = {e["edge_id"] for e in evidence["edges"]}
    assert edge_ids == {"edge_ab"}
    assert "edge_cd" not in edge_ids  # disjoint component: must not leak in

    event_ids = {e["event_id"] for e in evidence["events"]}
    assert event_ids == {"ev1", "ev2"}
    assert "ev3" not in event_ids  # only reachable via the disjoint edge_cd

    assert sorted(evidence["valid_event_ids"]) == ["ev1", "ev2"]


def test_gather_evidence_works_from_the_target_side_too():
    graph, events, ids = _build_graph_and_events()

    # node_b is the *target* of edge_ab (not the source) -- must still match.
    evidence = gather_evidence(graph, events, ids["b"])

    assert {e["edge_id"] for e in evidence["edges"]} == {"edge_ab"}
    assert {e["event_id"] for e in evidence["events"]} == {"ev1", "ev2"}


def test_gather_evidence_on_unconnected_node_returns_empty_edges_and_events():
    graph, events, ids = _build_graph_and_events()

    isolated = Node(node_id="node_isolated", node_type="function", label="Isolated", attributes={})
    graph = graph.model_copy(update={"nodes": [*graph.nodes, isolated]})

    evidence = gather_evidence(graph, events, "node_isolated")

    assert evidence["edges"] == []
    assert evidence["events"] == []
    assert evidence["valid_event_ids"] == []


def test_gather_evidence_unknown_node_id_raises():
    graph, events, _ids = _build_graph_and_events()

    with pytest.raises(ValueError):
        gather_evidence(graph, events, "node_does_not_exist")


def test_gather_evidence_caps_events_but_keeps_real_aggregate():
    """Discovered via a real explain() call against demo_targets/cpu_loop.py's
    fibonacci node: its real self-recursion edge has count=5166, and
    embedding all 5166 events' full JSON built a >1.1M token prompt against
    Anthropic's 200K limit. This is the regression test for the fix -- a
    synthetic edge with far more event_refs than the global budget must
    still produce a bounded gathered-events list (gate 5's hard ceiling),
    while never touching the edge's own real, complete EdgeDynamics
    aggregate.
    """
    node_a = _node("node_a", "A")
    node_b = _node("node_b", "B")

    many_refs = [f"ev{i}" for i in range(500)]
    # All identical (no error, no latency variance) -- no significance
    # signal to differentiate them, so this test exercises gate 5's ceiling
    # in isolation, not gate 2's scoring (that's covered by the tests below).
    events = [_event(ref, ts=float(i)) for i, ref in enumerate(many_refs)]
    edge = _edge("edge_ab", node_a.node_id, node_b.node_id, many_refs)
    graph = ComputationalGraph(trace_id="trace-1", nodes=[node_a, node_b], edges=[edge])

    evidence = gather_evidence(graph, events, node_a.node_id)

    # Bounded by the global budget, not 500.
    assert len(evidence["events"]) == _EVENT_BUDGET_TOTAL
    assert len(evidence["valid_event_ids"]) == _EVENT_BUDGET_TOTAL
    # Sampled ids are real refs, never invented.
    assert set(evidence["valid_event_ids"]) <= set(many_refs)

    # The edge's own EdgeDynamics in the evidence is untouched -- the real,
    # complete aggregate, not scaled down to match the sample.
    edge_evidence = evidence["edges"][0]
    assert edge_evidence["dynamic"]["count"] == 500
    assert edge_evidence["dynamic"]["event_refs"] == many_refs  # full real list, unsampled

    # The sampling itself is disclosed, not silent.
    info = evidence["edge_sample_info"]["edge_ab"]
    assert info == {"total_event_refs": 500, "sampled_event_refs": _EVENT_BUDGET_TOTAL}

    # Gate 4: whatever didn't win a slot is digested, not silently dropped.
    digest = evidence["edge_digests"]["edge_ab"]
    assert f"{500 - _EVENT_BUDGET_TOTAL} more real contributing event(s)" in digest


def test_gather_evidence_under_the_budget_samples_nothing_and_discloses_nothing():
    graph, events, ids = _build_graph_and_events()  # edge_ab has only 2 refs, well under budget

    evidence = gather_evidence(graph, events, ids["a"])

    info = evidence["edge_sample_info"]["edge_ab"]
    assert info == {"total_event_refs": 2, "sampled_event_refs": 2}
    assert evidence["edge_digests"] == {}  # nothing left over to digest


def test_gather_evidence_prioritizes_an_error_event_buried_among_routine_ones():
    """Gate 2: a single real error event, deliberately placed deep inside a
    large edge (past where a flat first-N cap would have reached), must
    still win a full-detail slot -- this is the whole reason significance
    scoring replaced the old flat per-edge cap.
    """
    node_a = _node("node_a", "A")
    node_b = _node("node_b", "B")

    routine_refs = [f"ev{i}" for i in range(200)]
    routine_events = [_event(ref, ts=float(i)) for i, ref in enumerate(routine_refs)]
    error_event = _event("ev_error", ts=150.5, event_type="error", duration_ms=2.5)

    all_refs = routine_refs[:150] + ["ev_error"] + routine_refs[150:]
    events = routine_events + [error_event]
    edge = _edge("edge_ab", node_a.node_id, node_b.node_id, all_refs)
    graph = ComputationalGraph(trace_id="trace-1", nodes=[node_a, node_b], edges=[edge])

    evidence = gather_evidence(graph, events, node_a.node_id)

    assert "ev_error" in evidence["valid_event_ids"]
    assert len(evidence["events"]) == _EVENT_BUDGET_TOTAL


def test_gather_evidence_prioritizes_a_latency_outlier_event():
    """Gate 2: an event whose duration_ms is a real statistical outlier
    against its own edge's mean/stdev must win a slot even when it is
    neither the first nor the most-recent occurrence and there are far more
    routine candidates than the budget allows.
    """
    node_a = _node("node_a", "A")
    node_b = _node("node_b", "B")

    routine_refs = [f"ev{i}" for i in range(200)]
    routine_events = [_event(ref, ts=float(i), duration_ms=2.5) for i, ref in enumerate(routine_refs)]
    outlier_event = _event("ev_outlier", ts=150.5, duration_ms=5000.0)

    all_refs = routine_refs[:150] + ["ev_outlier"] + routine_refs[150:]
    events = routine_events + [outlier_event]
    edge = _edge("edge_ab", node_a.node_id, node_b.node_id, all_refs)
    graph = ComputationalGraph(trace_id="trace-1", nodes=[node_a, node_b], edges=[edge])

    evidence = gather_evidence(graph, events, node_a.node_id)

    assert "ev_outlier" in evidence["valid_event_ids"]


def test_gather_evidence_floor_guarantees_a_boring_edge_is_not_starved():
    """Gate 3's anti-blind-spot floor: a "boring" edge (no errors, no
    latency variance -- nothing that scores well) connected to the same
    node as a genuinely eventful edge must still get its guaranteed minimum
    sample, not zero, even though pure significance ranking would have
    filled the whole budget from the eventful edge alone.
    """
    node_a = _node("node_a", "A")
    node_b = _node("node_b", "B")
    node_c = _node("node_c", "C")

    # Eventful edge: every single event is a real error -- would win the
    # entire budget on pure significance ranking with nothing left over.
    eventful_refs = [f"hot{i}" for i in range(200)]
    eventful_events = [
        _event(ref, ts=float(i), event_type="error") for i, ref in enumerate(eventful_refs)
    ]
    edge_hot = _edge("edge_hot", node_a.node_id, node_b.node_id, eventful_refs)

    # Boring edge: identical routine events, zero significance signal.
    boring_refs = [f"cold{i}" for i in range(50)]
    boring_events = [_event(ref, ts=float(i)) for i, ref in enumerate(boring_refs)]
    edge_cold = _edge("edge_cold", node_a.node_id, node_c.node_id, boring_refs)

    events = eventful_events + boring_events
    graph = ComputationalGraph(
        trace_id="trace-1", nodes=[node_a, node_b, node_c], edges=[edge_hot, edge_cold]
    )

    evidence = gather_evidence(graph, events, node_a.node_id)

    cold_shown = evidence["edge_sample_info"]["edge_cold"]["sampled_event_refs"]
    assert cold_shown >= _MIN_EVENTS_PER_EDGE_FLOOR, (
        "the boring edge must keep its guaranteed floor even though the hot edge's "
        "errors would win every budget slot on pure significance ranking"
    )
    assert len(evidence["events"]) == _EVENT_BUDGET_TOTAL


def test_gather_evidence_hard_ceiling_holds_under_many_edges():
    """Gate 5: a pathological node with far more connected edges than the
    budget could ever give a floor to must still produce a bounded evidence
    set -- never crash, never silently exceed _EVENT_BUDGET_TOTAL. Mirrors
    the "packet attack"/data-shock scenario the ceiling gate exists for.
    """
    node_a = _node("node_a", "A")
    other_nodes = [_node(f"node_{i}", f"N{i}") for i in range(100)]

    edges = []
    events = []
    for i, other in enumerate(other_nodes):
        refs = [f"e{i}_0", f"e{i}_1"]
        events.extend(_event(ref, ts=float(i)) for ref in refs)
        edges.append(_edge(f"edge_{i}", node_a.node_id, other.node_id, refs))

    graph = ComputationalGraph(trace_id="trace-1", nodes=[node_a, *other_nodes], edges=edges)

    evidence = gather_evidence(graph, events, node_a.node_id)

    assert len(evidence["events"]) <= _EVENT_BUDGET_TOTAL
    assert len(evidence["valid_event_ids"]) <= _EVENT_BUDGET_TOTAL
    # Edges the ceiling squeezed out entirely must still be honestly
    # reported as zero-shown, never silently absorbed.
    zero_shown = [
        eid for eid, info in evidence["edge_sample_info"].items() if info["sampled_event_refs"] == 0
    ]
    assert zero_shown, "with 100 edges x floor=2 >> budget, some edges must be squeezed to zero"
    for eid in zero_shown:
        assert eid in evidence["edge_digests"]


def test_build_prompt_discloses_sampling_when_an_edge_is_truncated():
    node_a = _node("node_a", "A")
    node_b = _node("node_b", "B")
    many_refs = [f"ev{i}" for i in range(500)]
    events = [_event(ref, ts=float(i)) for i, ref in enumerate(many_refs)]
    edge = _edge("edge_ab", node_a.node_id, node_b.node_id, many_refs)
    graph = ComputationalGraph(trace_id="trace-1", nodes=[node_a, node_b], edges=[edge])

    evidence = gather_evidence(graph, events, node_a.node_id)
    prompt = _build_prompt(evidence)

    assert f"showing {_EVENT_BUDGET_TOTAL} of 500 real contributing events" in prompt
    assert "does NOT make an edge's aggregate data" in prompt
    assert "Of the rest:" in prompt


def test_build_prompt_says_nothing_extra_when_no_edge_is_truncated():
    graph, events, ids = _build_graph_and_events()
    evidence = gather_evidence(graph, events, ids["a"])
    prompt = _build_prompt(evidence)

    assert "NOTE on the evidence below" not in prompt


def test_gather_evidence_skips_dangling_event_ref_without_fabricating():
    graph, events, ids = _build_graph_and_events()

    # Point the edge at an event_id that isn't in the supplied events list.
    dangling_edge = _edge("edge_dangling", ids["a"], ids["b"], ["ev1", "ev_missing"])
    graph = graph.model_copy(update={"edges": [dangling_edge]})

    evidence = gather_evidence(graph, events, ids["a"])

    event_ids = {e["event_id"] for e in evidence["events"]}
    assert event_ids == {"ev1"}  # ev_missing silently skipped, not invented
    assert evidence["valid_event_ids"] == ["ev1"]


# ---------------------------------------------------------------------------
# gather_evidence -- real pipeline (collect -> normalize -> build_graph)
# against demo_targets/cpu_loop.py, the same script whose fibonacci node
# (count=5166 self-recursion edge) surfaced the original 1.14M-token bug.
# ---------------------------------------------------------------------------


def test_gather_evidence_real_fibonacci_node_stays_bounded_and_discloses(tmp_path):
    trace_id = f"explain-cpu-loop-{uuid.uuid4().hex[:8]}"
    result = collect(
        script_path=str(CPU_LOOP_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=200000,
        timeout_s=60,
    )
    assert result["error"] is None, f"unexpected collector error: {result['error']}"

    events = normalize(result, trace_id)
    graph = build_graph(events, trace_id)

    fib_node = next(n for n in graph.nodes if n.node_type == "function" and n.label == "fibonacci")
    fib_self_edges = [e for e in graph.edges if e.source == fib_node.node_id and e.target == fib_node.node_id]
    assert len(fib_self_edges) == 1
    assert fib_self_edges[0].dynamic.count > 500, "this is the real edge the original overflow bug needs"

    evidence = gather_evidence(graph, events, fib_node.node_id)

    # Bounded regardless of the edge's real, thousands-large count.
    assert len(evidence["events"]) <= _EVENT_BUDGET_TOTAL
    assert len(evidence["valid_event_ids"]) <= _EVENT_BUDGET_TOTAL

    # The real, complete aggregate is untouched by the sampling.
    edge_evidence = next(e for e in evidence["edges"] if e["source"] == e["target"])
    assert edge_evidence["dynamic"]["count"] == fib_self_edges[0].dynamic.count

    # Truncation on this edge is disclosed with a real, non-empty digest.
    info = evidence["edge_sample_info"][fib_self_edges[0].edge_id]
    assert info["sampled_event_refs"] < info["total_event_refs"]
    assert fib_self_edges[0].edge_id in evidence["edge_digests"]

    prompt = _build_prompt(evidence)
    assert "NOTE on the evidence below" in prompt
    assert len(prompt) < 500_000, "prompt must stay well clear of the 200K-token failure this fixes"


# ---------------------------------------------------------------------------
# Fake Anthropic client
# ---------------------------------------------------------------------------


class _FakeMessages:
    def __init__(self, response):
        self._response = response
        self.calls: list[dict] = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        return self._response


class _FakeClient:
    def __init__(self, response):
        self.messages = _FakeMessages(response)


def _fake_tool_use_response(tool_input: dict) -> SimpleNamespace:
    """Mimic the shape of a real anthropic.types.Message with tool_choice
    forced -- a single tool_use content block whose .input is already a
    parsed dict (as the real SDK provides)."""
    block = SimpleNamespace(type="tool_use", name="record_explanation", input=tool_input)
    return SimpleNamespace(content=[block], stop_reason="tool_use", model="claude-sonnet-4-5")


# ---------------------------------------------------------------------------
# explain() -- happy path, offline
# ---------------------------------------------------------------------------


def test_explain_returns_explanation_built_from_canned_response():
    graph, events, ids = _build_graph_and_events()

    canned = {
        "target_node_id": ids["a"],
        "local": {
            "text": "A called B twice, averaging 2.5ms per call.",
            "evidence_level": "observed",
            "evidence_refs": ["ev1", "ev2"],
        },
    }
    fake_client = _FakeClient(_fake_tool_use_response(canned))

    result = explain(graph, events, ids["a"], client=fake_client)

    assert isinstance(result, Explanation)
    assert result.target_node_id == ids["a"]
    assert result.local.evidence_level == EvidenceLevel.OBSERVED
    assert result.local.evidence_refs == ["ev1", "ev2"]
    assert result.function_role is None

    # exactly one call was made, with the forced tool_choice
    assert len(fake_client.messages.calls) == 1
    call = fake_client.messages.calls[0]
    assert call["tool_choice"] == {"type": "tool", "name": "record_explanation"}
    assert call["tools"][0]["name"] == "record_explanation"


def test_explain_accepts_a_zero_arg_client_factory():
    graph, events, ids = _build_graph_and_events()
    canned = {
        "target_node_id": ids["a"],
        "local": {"text": "no-op", "evidence_level": "hypothesized", "evidence_refs": []},
    }
    fake_client = _FakeClient(_fake_tool_use_response(canned))

    result = explain(graph, events, ids["a"], client=lambda: fake_client)

    assert result.local.evidence_level == EvidenceLevel.HYPOTHESIZED
    assert len(fake_client.messages.calls) == 1


def test_explain_raises_when_no_tool_use_block_present():
    graph, events, ids = _build_graph_and_events()
    text_only_response = SimpleNamespace(
        content=[SimpleNamespace(type="text", text="I refuse to use the tool.")],
        stop_reason="end_turn",
        model="claude-sonnet-4-5",
    )
    fake_client = _FakeClient(text_only_response)

    with pytest.raises(ValueError):
        explain(graph, events, ids["a"], client=fake_client)


# ---------------------------------------------------------------------------
# THE key test: Hallucination Control is enforced in code
# ---------------------------------------------------------------------------


def test_observed_claim_with_fabricated_ref_is_downgraded():
    """The model claims 'observed' evidence but cites an evidence_ref that was
    never part of what gather_evidence() actually collected for this node
    (a completely fabricated event id). explain()'s post-validation step
    must catch this and downgrade the claim to HYPOTHESIZED rather than
    silently returning an unverifiable OBSERVED claim.
    """
    graph, events, ids = _build_graph_and_events()

    canned = {
        "target_node_id": ids["a"],
        "local": {
            "text": "A called B exactly 500 times with 0.1ms latency.",
            "evidence_level": "observed",
            # "ev1" is real evidence for node_a; "ev_fabricated_9999" is not --
            # it was never gathered for this node (doesn't even exist in the trace).
            "evidence_refs": ["ev1", "ev_fabricated_9999"],
        },
    }
    fake_client = _FakeClient(_fake_tool_use_response(canned))

    result = explain(graph, events, ids["a"], client=fake_client)

    # The unverifiable OBSERVED claim must NOT pass through as-is.
    assert result.local.evidence_level == EvidenceLevel.HYPOTHESIZED
    # The offending refs are preserved on the (now-downgraded) claim for
    # inspection -- downgrading changes the evidence_level, not the payload.
    assert result.local.evidence_refs == ["ev1", "ev_fabricated_9999"]


def test_observed_claim_with_only_valid_refs_is_left_observed():
    """Sanity check / control for the test above: a claim that legitimately
    cites only gathered evidence must NOT be downgraded."""
    graph, events, ids = _build_graph_and_events()

    canned = {
        "target_node_id": ids["a"],
        "local": {
            "text": "A called B twice.",
            "evidence_level": "observed",
            "evidence_refs": ["ev1", "ev2"],
        },
    }
    fake_client = _FakeClient(_fake_tool_use_response(canned))

    result = explain(graph, events, ids["a"], client=fake_client)

    assert result.local.evidence_level == EvidenceLevel.OBSERVED


def test_non_observed_claim_with_fabricated_ref_is_not_touched():
    """Only OBSERVED claims are checked against the gathered evidence --
    a HYPOTHESIZED claim is allowed to speculate beyond it (that's what
    the level means), so post-validation must leave it alone."""
    graph, events, ids = _build_graph_and_events()

    canned = {
        "target_node_id": ids["a"],
        "local": {
            "text": "A might be related to some other undiscovered path.",
            "evidence_level": "hypothesized",
            "evidence_refs": ["ev_not_real"],
        },
    }
    fake_client = _FakeClient(_fake_tool_use_response(canned))

    result = explain(graph, events, ids["a"], client=fake_client)

    assert result.local.evidence_level == EvidenceLevel.HYPOTHESIZED
    assert result.local.evidence_refs == ["ev_not_real"]


def test_observed_claim_with_fabricated_ref_in_optional_field_is_downgraded():
    """The fabricated-ref check must apply to every claim field (local,
    function_role, runtime_effect, risk), not just `local`."""
    graph, events, ids = _build_graph_and_events()

    canned = {
        "target_node_id": ids["a"],
        "local": {"text": "A called B twice.", "evidence_level": "observed", "evidence_refs": ["ev1"]},
        "risk": {
            "text": "This path is risky.",
            "evidence_level": "observed",
            "evidence_refs": ["totally_made_up"],
        },
    }
    fake_client = _FakeClient(_fake_tool_use_response(canned))

    result = explain(graph, events, ids["a"], client=fake_client)

    assert result.local.evidence_level == EvidenceLevel.OBSERVED  # untouched, valid
    assert result.risk is not None
    assert result.risk.evidence_level == EvidenceLevel.HYPOTHESIZED  # caught and downgraded

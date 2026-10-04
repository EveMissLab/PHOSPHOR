"""Unit tests for phosphor_projector.project.

All graphs here are constructed directly as ComputationalGraph/Node/Edge
literals (no collector/normalize/build_graph involved) so each test can
freely control node types, "pid" attributes, and edge relations -- these are
pure functions of a ComputationalGraph, so there is no reason to route
through the trace pipeline to exercise them.

The complexity_lens tests below are split the same way the task asked:
synthetic-graph tests for precise control over top-K/ranking/omission math,
plus one end-to-end test that runs the real collect() -> normalize() ->
build_graph() pipeline against demo_targets/cpu_loop.py and independently
verifies the reported top-cost edges/nodes against that real graph (mirrors
tests/test_graph.py's own end-to-end pattern, e.g.
test_end_to_end_real_trace_bounds_node_count_despite_many_calls).
"""

from __future__ import annotations

import uuid
from pathlib import Path

import pytest

from phosphor_collector.collect import collect
from phosphor_graph.build import build_graph
from phosphor_projector.project import (
    BugReport,
    ComplexityReport,
    _traffic_count_threshold,
    bug_lens,
    complexity_lens,
    project,
    project_macro,
    project_meso,
)
from phosphor_trace.normalize import normalize
from phosphor_trace.schema import (
    ComputationalGraph,
    Edge,
    EdgeDynamics,
    Evidence,
    EvidenceLevel,
    Node,
    RuntimeContext,
    SourceLocation,
    TraceEvent,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEMO_TARGETS = REPO_ROOT / "demo_targets"
CPU_LOOP_SCRIPT = DEMO_TARGETS / "cpu_loop.py"
IO_BOUND_SCRIPT = DEMO_TARGETS / "io_bound.py"
ERROR_CASE_SCRIPT = DEMO_TARGETS / "error_case.py"


def _dynamic(count=1, total_ms=10.0, refs=None) -> EdgeDynamics:
    refs = refs if refs is not None else [f"evt_{i}" for i in range(count)]
    return EdgeDynamics(
        count=count,
        total_duration_ms=total_ms,
        avg_latency_ms=total_ms / count if count else 0.0,
        event_refs=refs,
    )


def _process(node_id, pid) -> Node:
    return Node(node_id=node_id, node_type="process", label=f"pid {pid}", attributes={"pid": pid})


def _host(node_id, label) -> Node:
    return Node(node_id=node_id, node_type="host", label=label, attributes={})


def _function(node_id, label, *, file="app.py", pid=None) -> Node:
    attrs: dict[str, str | int] = {"file": file}
    if pid is not None:
        attrs["pid"] = pid
    return Node(node_id=node_id, node_type="function", label=label, attributes=attrs)


def _edge(edge_id, source, target, relation, dynamic) -> Edge:
    return Edge(edge_id=edge_id, source=source, target=target, relation=relation, dynamic=dynamic)


# ---------------------------------------------------------------------------
# bug_lens helpers -- construct real TraceEvent objects (same helper shape as
# tests/test_graph.py's own _fn_event/_net_event/_db_event) and route them
# through the real build_graph() so the ComputationalGraph handed to
# bug_lens() has real, build_graph-derived node_ids -- never a hand-faked
# node_id that build_graph itself would never have produced.
# ---------------------------------------------------------------------------


def _synth_evidence() -> Evidence:
    return Evidence(level=EvidenceLevel.OBSERVED, confidence=1.0)


def _synth_fn_event(event_id, trace_id, ts, file, function, pid=42, tid=1, dur_ms=1.0, parent=None):
    return TraceEvent(
        event_id=event_id,
        trace_id=trace_id,
        timestamp=ts,
        type="function_call",
        source=SourceLocation(file=file, line=1, function=function),
        runtime=RuntimeContext(pid=pid, tid=tid),
        duration_ms=dur_ms,
        parent_event=parent,
        evidence=_synth_evidence(),
    )


def _synth_net_event(event_id, trace_id, ts, resource, pid=42, tid=1, dur_ms=1.0, parent=None):
    return TraceEvent(
        event_id=event_id,
        trace_id=trace_id,
        timestamp=ts,
        type="network_request",
        source=SourceLocation(file="<network>", line=None, function="GET"),
        runtime=RuntimeContext(pid=pid, tid=tid),
        duration_ms=dur_ms,
        parent_event=parent,
        resource=resource,
        evidence=_synth_evidence(),
    )


def _synth_error_event(event_id, trace_id, ts, resource, source_file="<database>", pid=42, tid=1, parent=None):
    return TraceEvent(
        event_id=event_id,
        trace_id=trace_id,
        timestamp=ts,
        type="error",
        source=SourceLocation(file=source_file, line=None, function="phosphor.uncaught_exception"),
        runtime=RuntimeContext(pid=pid, tid=tid),
        duration_ms=None,
        parent_event=parent,
        resource=resource,
        evidence=_synth_evidence(),
    )


# ---------------------------------------------------------------------------
# project_macro: multi-process collapse
# ---------------------------------------------------------------------------


def _two_process_graph() -> ComputationalGraph:
    """2 processes, 2 functions each (pid-tagged), 1 host both processes hit."""
    proc_a = _process("proc_a", pid=100)
    proc_b = _process("proc_b", pid=200)
    host = _host("host_x", "example.com")

    fn_a1 = _function("fn_a1", "handler_a1", pid=100)
    fn_a2 = _function("fn_a2", "worker_a2", pid=100)
    fn_b1 = _function("fn_b1", "handler_b1", pid=200)
    fn_b2 = _function("fn_b2", "worker_b2", pid=200)

    edges = [
        # intra-process call in A -> should become a self-loop, dropped as an edge
        _edge("e1", "fn_a1", "fn_a2", "calls", _dynamic(count=7, total_ms=14.0)),
        # intra-process call in B -> self-loop, dropped
        _edge("e2", "fn_b1", "fn_b2", "calls", _dynamic(count=3, total_ms=9.0)),
        # both processes' functions call out to the same host -> should aggregate
        # into 2 distinct process->host edges (A->host, B->host)
        _edge("e3", "fn_a2", "host_x", "invokes", _dynamic(count=5, total_ms=50.0)),
        _edge("e4", "fn_b2", "host_x", "invokes", _dynamic(count=2, total_ms=20.0)),
    ]

    return ComputationalGraph(
        trace_id="two-proc",
        nodes=[proc_a, proc_b, host, fn_a1, fn_a2, fn_b1, fn_b2],
        edges=edges,
    )


def test_project_macro_collapses_multiprocess_graph_to_process_nodes_only():
    graph = _two_process_graph()
    macro = project_macro(graph)

    assert isinstance(macro, ComputationalGraph)
    assert macro.trace_id == graph.trace_id

    non_host_nodes = [n for n in macro.nodes if n.node_type != "host"]
    assert len(non_host_nodes) <= 2, "must collapse to at most one node per process"
    assert {n.node_id for n in non_host_nodes} == {"proc_a", "proc_b"}
    assert all(n.node_type == "process" for n in non_host_nodes)

    # no function-type nodes survive macro projection
    assert all(n.node_type != "function" for n in macro.nodes)

    # host node passes through unchanged, same node_id
    host_nodes = [n for n in macro.nodes if n.node_type == "host"]
    assert len(host_nodes) == 1
    assert host_nodes[0].node_id == "host_x"


def test_project_macro_rolls_up_function_count_and_total_call_count():
    graph = _two_process_graph()
    macro = project_macro(graph)

    proc_a = next(n for n in macro.nodes if n.node_id == "proc_a")
    proc_b = next(n for n in macro.nodes if n.node_id == "proc_b")

    assert proc_a.attributes["function_count"] == 2
    assert proc_b.attributes["function_count"] == 2

    # total_call_count = sum of dynamic.count over every edge sourced from
    # this process's collapsed functions, whether it became a self-loop
    # (e1: 7) or stayed a real edge (e3: 5) -> 12 for A; (e2: 3) + (e4: 2) -> 5 for B
    assert proc_a.attributes["total_call_count"] == 12
    assert proc_b.attributes["total_call_count"] == 5

    # original process attributes (e.g. pid) are preserved, not clobbered
    assert proc_a.attributes["pid"] == 100
    assert proc_b.attributes["pid"] == 200


def test_project_macro_drops_intra_process_edges_and_aggregates_cross_process_edges():
    graph = _two_process_graph()
    macro = project_macro(graph)

    # intra-process self-loops must NOT appear as edges
    assert all(e.source != e.target for e in macro.edges)

    invokes_edges = [e for e in macro.edges if e.relation == "invokes"]
    assert len(invokes_edges) == 2
    by_source = {e.source: e for e in invokes_edges}
    assert by_source["proc_a"].target == "host_x"
    assert by_source["proc_a"].dynamic.count == 5
    assert by_source["proc_a"].dynamic.total_duration_ms == 50.0
    assert by_source["proc_a"].dynamic.avg_latency_ms == 10.0
    assert set(by_source["proc_a"].dynamic.event_refs) == set(
        [f"evt_{i}" for i in range(5)]
    )

    assert by_source["proc_b"].target == "host_x"
    assert by_source["proc_b"].dynamic.count == 2

    # no "calls" edges survive -- both were intra-process self-loops
    assert [e for e in macro.edges if e.relation == "calls"] == []


def test_project_macro_aggregates_multiple_edges_into_same_process_host_pair():
    """Two different functions in the same process hitting the same host must
    fold into ONE aggregated process->host edge, not two."""
    proc = _process("proc_1", pid=100)
    host = _host("host_y", "svc.local")
    fn1 = _function("fn1", "a", pid=100)
    fn2 = _function("fn2", "b", pid=100)

    edges = [
        _edge("e1", "fn1", "host_y", "invokes", _dynamic(count=3, total_ms=30.0, refs=["r1", "r2", "r3"])),
        _edge("e2", "fn2", "host_y", "invokes", _dynamic(count=4, total_ms=8.0, refs=["r4", "r5", "r6", "r7"])),
    ]
    graph = ComputationalGraph(trace_id="fold", nodes=[proc, host, fn1, fn2], edges=edges)

    macro = project_macro(graph)
    invokes_edges = [e for e in macro.edges if e.relation == "invokes"]
    assert len(invokes_edges) == 1
    edge = invokes_edges[0]
    assert edge.dynamic.count == 7
    assert edge.dynamic.total_duration_ms == 38.0
    assert edge.dynamic.avg_latency_ms == pytest.approx(38.0 / 7)
    assert set(edge.dynamic.event_refs) == {"r1", "r2", "r3", "r4", "r5", "r6", "r7"}


# ---------------------------------------------------------------------------
# project_macro: single-process fallback (the common real build_graph shape,
# where function nodes carry no "pid" attribute at all)
# ---------------------------------------------------------------------------


def test_project_macro_single_process_fallback_when_no_pid_attributes_present():
    proc = _process("proc_1", pid=100)
    fn1 = _function("fn1", "main")  # no pid attribute, like real build_graph output
    fn2 = _function("fn2", "worker")
    graph = ComputationalGraph(
        trace_id="single-proc",
        nodes=[proc, fn1, fn2],
        edges=[_edge("e1", "fn1", "fn2", "calls", _dynamic(count=100, total_ms=200.0))],
    )

    macro = project_macro(graph)
    assert len(macro.nodes) == 1
    proc_node = macro.nodes[0]
    assert proc_node.node_id == "proc_1"
    assert proc_node.attributes["function_count"] == 2
    assert proc_node.attributes["total_call_count"] == 100
    assert macro.edges == []  # the only edge was an intra-process self-loop


def test_project_macro_ambiguous_ownership_drops_node_without_crashing():
    """No pid attribute AND more than one process node -> genuinely
    unresolvable; must drop gracefully, not guess, not crash."""
    proc_a = _process("proc_a", pid=100)
    proc_b = _process("proc_b", pid=200)
    orphan_fn = _function("fn_orphan", "mystery")  # no pid, 2 candidate processes
    graph = ComputationalGraph(trace_id="ambiguous", nodes=[proc_a, proc_b, orphan_fn], edges=[])

    macro = project_macro(graph)
    assert {n.node_id for n in macro.nodes} == {"proc_a", "proc_b"}
    proc_a_out = next(n for n in macro.nodes if n.node_id == "proc_a")
    proc_b_out = next(n for n in macro.nodes if n.node_id == "proc_b")
    assert proc_a_out.attributes["function_count"] == 0
    assert proc_b_out.attributes["function_count"] == 0


def test_project_macro_on_empty_graph_returns_empty_graph():
    graph = ComputationalGraph(trace_id="empty", nodes=[], edges=[])
    macro = project_macro(graph)
    assert macro.nodes == []
    assert macro.edges == []
    assert macro.trace_id == "empty"


# ---------------------------------------------------------------------------
# project_meso: identity projection (base resolution for v0.1)
# ---------------------------------------------------------------------------


def test_project_meso_preserves_original_function_node_count_and_edges():
    graph = _two_process_graph()
    original_function_count = len([n for n in graph.nodes if n.node_type == "function"])
    assert original_function_count == 4  # sanity on the fixture itself

    meso = project_meso(graph)
    meso_function_count = len([n for n in meso.nodes if n.node_type == "function"])
    assert meso_function_count == original_function_count
    assert len(meso.nodes) == len(graph.nodes)
    assert len(meso.edges) == len(graph.edges)
    assert meso.trace_id == graph.trace_id

    # same node_ids/edge_ids preserved, values equal, but it's a fresh copy
    assert {n.node_id for n in meso.nodes} == {n.node_id for n in graph.nodes}
    assert {e.edge_id for e in meso.edges} == {e.edge_id for e in graph.edges}


def test_project_meso_returns_a_deep_copy_not_the_same_object():
    graph = _two_process_graph()
    meso = project_meso(graph)
    assert meso is not graph
    assert meso.nodes is not graph.nodes
    # mutating the copy's node list must not affect the original graph
    meso.nodes.clear()
    assert len(graph.nodes) == 7  # original untouched


# ---------------------------------------------------------------------------
# project(): dispatch + micro not-yet-implemented
# ---------------------------------------------------------------------------


def test_project_dispatches_to_macro_and_meso():
    graph = _two_process_graph()

    macro_direct = project_macro(graph)
    macro_via_dispatch = project(graph, "macro")
    assert {n.node_id for n in macro_via_dispatch.nodes} == {n.node_id for n in macro_direct.nodes}

    meso_via_dispatch = project(graph, "meso")
    assert len(meso_via_dispatch.nodes) == len(graph.nodes)
    assert {n.node_type for n in meso_via_dispatch.nodes} == {n.node_type for n in graph.nodes}


def test_project_micro_raises_not_implemented_rather_than_silently_succeeding():
    graph = _two_process_graph()
    with pytest.raises(NotImplementedError):
        project(graph, "micro")  # type: ignore[arg-type]


def test_project_unknown_scale_raises_value_error():
    graph = _two_process_graph()
    with pytest.raises(ValueError):
        project(graph, "nonsense")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# complexity_lens: synthetic graph -- precise control over ranking/omission
# ---------------------------------------------------------------------------


def _complexity_graph() -> ComputationalGraph:
    """3 functions, 1 host, 4 edges of deliberately distinct total_duration_ms
    so top-K ordering/omission and per-node direction splits are unambiguous.

    Edges (by total_duration_ms, descending): e_bc=300 (B->C calls), e_ab=100
    (A->B calls), e_ah=50 (A->host invokes), e_bh=10 (B->host invokes).
    """
    fn_a = _function("fn_a", "handler_a")
    fn_b = _function("fn_b", "worker_b")
    fn_c = _function("fn_c", "leaf_c")
    host = _host("host_x", "example.com")

    e_ab = _edge("e_ab", "fn_a", "fn_b", "calls", _dynamic(count=10, total_ms=100.0))
    e_bc = _edge("e_bc", "fn_b", "fn_c", "calls", _dynamic(count=3, total_ms=300.0))
    e_ah = _edge("e_ah", "fn_a", "host_x", "invokes", _dynamic(count=5, total_ms=50.0))
    e_bh = _edge("e_bh", "fn_b", "host_x", "invokes", _dynamic(count=2, total_ms=10.0))

    return ComputationalGraph(
        trace_id="complexity-synth",
        nodes=[fn_a, fn_b, fn_c, host],
        edges=[e_ab, e_bc, e_ah, e_bh],
    )


def test_complexity_lens_returns_complexity_report():
    graph = _complexity_graph()
    report = complexity_lens(graph)
    assert isinstance(report, ComplexityReport)
    assert report.trace_id == graph.trace_id


def test_complexity_lens_node_costs_split_outgoing_incoming_and_total():
    graph = _complexity_graph()
    report = complexity_lens(graph)
    by_id = {nc.node_id: nc for nc in report.node_costs}

    # fn_a: source of e_ab (100) and e_ah (50) -> outgoing 150, no incoming
    assert by_id["fn_a"].outgoing_duration_ms == 150.0
    assert by_id["fn_a"].incoming_duration_ms == 0.0
    assert by_id["fn_a"].total_duration_ms == 150.0
    assert by_id["fn_a"].edge_count == 2

    # fn_b: target of e_ab (100, incoming) AND source of e_bc (300) + e_bh (10)
    assert by_id["fn_b"].incoming_duration_ms == 100.0
    assert by_id["fn_b"].outgoing_duration_ms == 310.0
    assert by_id["fn_b"].total_duration_ms == 410.0
    assert by_id["fn_b"].edge_count == 3

    # fn_c: target only, of e_bc (300)
    assert by_id["fn_c"].incoming_duration_ms == 300.0
    assert by_id["fn_c"].outgoing_duration_ms == 0.0
    assert by_id["fn_c"].edge_count == 1

    # host_x: target of e_ah (50) and e_bh (10)
    assert by_id["host_x"].incoming_duration_ms == 60.0
    assert by_id["host_x"].edge_count == 2

    # node_costs covers every node, never truncated
    assert {nc.node_id for nc in report.node_costs} == {"fn_a", "fn_b", "fn_c", "host_x"}
    # sorted descending by total_duration_ms
    totals = [nc.total_duration_ms for nc in report.node_costs]
    assert totals == sorted(totals, reverse=True)
    assert report.node_costs[0].node_id == "fn_b"  # 410, the highest total


def test_complexity_lens_top_k_ranking_exact_order():
    graph = _complexity_graph()
    report = complexity_lens(graph, top_k=10)  # k >= edge count -> nothing omitted
    assert [ec.edge_id for ec in report.top_edges] == ["e_bc", "e_ab", "e_ah", "e_bh"]
    assert [ec.total_duration_ms for ec in report.top_edges] == [300.0, 100.0, 50.0, 10.0]
    assert report.omitted_edge_count == 0
    assert report.omitted_total_duration_ms == 0.0
    assert report.total_edge_count == 4
    assert report.total_duration_ms == 460.0


def test_complexity_lens_top_k_smaller_than_edge_count_reports_omission_honestly():
    graph = _complexity_graph()
    report = complexity_lens(graph, top_k=2)

    assert [ec.edge_id for ec in report.top_edges] == ["e_bc", "e_ab"]
    assert report.top_k == 2
    # the 2 lowest-cost edges (e_ah=50, e_bh=10) are omitted, never silently
    # dropped -- their count and aggregate duration are reported explicitly
    assert report.omitted_edge_count == 2
    assert report.omitted_total_duration_ms == 60.0
    # top_edges + omitted accounts for every edge and every ms of duration
    assert len(report.top_edges) + report.omitted_edge_count == report.total_edge_count
    assert (
        sum(ec.total_duration_ms for ec in report.top_edges) + report.omitted_total_duration_ms
        == report.total_duration_ms
    )


def test_complexity_lens_top_k_zero_omits_everything_individually_but_not_the_total():
    graph = _complexity_graph()
    report = complexity_lens(graph, top_k=0)
    assert report.top_edges == []
    assert report.omitted_edge_count == 4
    assert report.omitted_total_duration_ms == 460.0


def test_complexity_lens_negative_top_k_raises_value_error():
    graph = _complexity_graph()
    with pytest.raises(ValueError):
        complexity_lens(graph, top_k=-1)


def test_complexity_lens_relation_breakdown_shows_where_cost_concentrates():
    graph = _complexity_graph()
    report = complexity_lens(graph)
    by_relation = {rc.relation: rc for rc in report.relation_breakdown}

    assert by_relation["calls"].edge_count == 2  # e_ab, e_bc
    assert by_relation["calls"].call_count == 13  # 10 + 3
    assert by_relation["calls"].total_duration_ms == 400.0  # 100 + 300
    assert by_relation["calls"].avg_latency_ms == pytest.approx(400.0 / 13)

    assert by_relation["invokes"].edge_count == 2  # e_ah, e_bh
    assert by_relation["invokes"].call_count == 7  # 5 + 2
    assert by_relation["invokes"].total_duration_ms == 60.0  # 50 + 10

    # sorted descending by total_duration_ms -- "calls" (400) concentrates
    # more cost than "invokes" (60) in this fixture
    assert [rc.relation for rc in report.relation_breakdown] == ["calls", "invokes"]


def test_complexity_lens_on_empty_graph_returns_empty_report_not_a_crash():
    graph = ComputationalGraph(trace_id="empty", nodes=[], edges=[])
    report = complexity_lens(graph)
    assert report.node_costs == []
    assert report.top_edges == []
    assert report.relation_breakdown == []
    assert report.omitted_edge_count == 0
    assert report.omitted_total_duration_ms == 0.0
    assert report.total_edge_count == 0
    assert report.total_duration_ms == 0.0


def test_complexity_lens_self_loop_edge_counted_once_but_both_directions():
    """A self-loop (source == target) must count as ONE edge touching that
    node, contributing to both outgoing_duration_ms and incoming_duration_ms
    (real recursive-function edges, e.g. fibonacci->fibonacci, are exactly
    this shape -- see the real-pipeline test below)."""
    fn = _function("fn_self", "recurse")
    edge = _edge("e_self", "fn_self", "fn_self", "calls", _dynamic(count=1000, total_ms=500.0))
    graph = ComputationalGraph(trace_id="self-loop", nodes=[fn], edges=[edge])

    report = complexity_lens(graph)
    nc = report.node_costs[0]
    assert nc.node_id == "fn_self"
    assert nc.outgoing_duration_ms == 500.0
    assert nc.incoming_duration_ms == 500.0
    assert nc.total_duration_ms == 1000.0
    assert nc.edge_count == 1  # not 2 -- one distinct edge, counted once

    assert len(report.top_edges) == 1
    assert report.top_edges[0].count == 1000


# ---------------------------------------------------------------------------
# complexity_lens: real pipeline (collect -> normalize -> build_graph) against
# demo_targets/cpu_loop.py -- fibonacci's self-recursion is the real, high-
# call-volume edge this project's own Phase 0 verification already relies on.
# ---------------------------------------------------------------------------


def test_complexity_lens_real_cpu_loop_trace_surfaces_fibonacci_recursion_cost(tmp_path):
    trace_id = f"complexity-cpu-loop-{uuid.uuid4().hex[:8]}"
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
    assert isinstance(graph, ComputationalGraph)
    assert len(graph.edges) > 0, "cpu_loop.py must produce real calls edges to test against"

    report = complexity_lens(graph, top_k=5)
    assert isinstance(report, ComplexityReport)
    assert report.trace_id == trace_id
    assert report.total_edge_count == len(graph.edges)

    # Independent verification against the real graph, not the report itself:
    # recompute the actual highest-total_duration_ms edge directly from
    # graph.edges and confirm the report's top edge matches it exactly.
    expected_top_edge = max(graph.edges, key=lambda e: e.dynamic.total_duration_ms)
    assert report.top_edges[0].edge_id == expected_top_edge.edge_id
    assert report.top_edges[0].total_duration_ms == expected_top_edge.dynamic.total_duration_ms
    assert report.top_edges == sorted(
        report.top_edges, key=lambda ec: ec.total_duration_ms, reverse=True
    )

    # fibonacci(17) makes several thousand recursive self-calls (see
    # demo_targets/cpu_loop.py's own docstring) -- that self-loop edge must
    # be present with a real, large count, and must be one of the highest
    # by dynamic.count in the whole graph (independently verified, not just
    # asserted against the report).
    fib_node = next(n for n in graph.nodes if n.node_type == "function" and n.label == "fibonacci")
    fib_self_edges = [
        e for e in graph.edges if e.source == fib_node.node_id and e.target == fib_node.node_id
    ]
    assert len(fib_self_edges) == 1, "fibonacci's recursive self-call must fold into exactly one edge"
    fib_self_edge = fib_self_edges[0]
    assert fib_self_edge.dynamic.count > 500  # fibonacci(17) alone makes thousands of calls
    assert fib_self_edge.dynamic.count == max(e.dynamic.count for e in graph.edges), (
        "fibonacci's self-recursion should be the single most-called edge in the graph"
    )

    # That same edge's aggregated cost must show up correctly in the report's
    # per-node view for the fibonacci node: it is simultaneously the
    # "caller" (outgoing) and "callee" (incoming) side of its own self-loop.
    fib_node_cost = next(nc for nc in report.node_costs if nc.node_id == fib_node.node_id)
    assert fib_node_cost.outgoing_duration_ms >= fib_self_edge.dynamic.total_duration_ms
    assert fib_node_cost.incoming_duration_ms >= fib_self_edge.dynamic.total_duration_ms

    # Sanity on the "no silent caps" contract against the real graph: top_k=5
    # with more than 5 real edges must report a nonzero, honest omission.
    if len(graph.edges) > 5:
        assert report.omitted_edge_count == len(graph.edges) - 5
        assert report.omitted_total_duration_ms >= 0.0

    # relation_breakdown must account for every edge in the real graph
    assert sum(rc.edge_count for rc in report.relation_breakdown) == len(graph.edges)
    assert sum(rc.total_duration_ms for rc in report.relation_breakdown) == pytest.approx(
        report.total_duration_ms
    )


# ---------------------------------------------------------------------------
# bug_lens: synthetic graph -- a planted db_query error, a planted whole-
# script uncaught-exception error with no resolvable caller, and a planted
# traffic-explosion edge (50 network calls from the same function, vs. only
# 1 ordinary call elsewhere -- exactly 2 edges total, so this exercises the
# "too few edges for real statistics" absolute-floor branch of
# _traffic_count_threshold, see that function's docstring).
# ---------------------------------------------------------------------------


def _bug_lens_synthetic_graph_and_events():
    trace_id = "synthetic-bugs"

    main = _synth_fn_event("evt_main", trace_id, ts=0.0, file="app.py", function="main", dur_ms=1000.0)
    callee_b = _synth_fn_event(
        "evt_callee", trace_id, ts=10.0, file="app.py", function="callee_b", dur_ms=1.0, parent="evt_main"
    )
    net_events = [
        _synth_net_event(
            f"evt_net_{i:03d}",
            trace_id,
            ts=20.0 + i,
            resource={"http.method": "GET", "http.url": "http://svc.local/items"},
            dur_ms=0.5,
            parent="evt_main",
        )
        for i in range(50)
    ]
    db_error = _synth_error_event(
        "evt_db_error",
        trace_id,
        ts=900.0,
        resource={
            "db.system": "sqlite",
            "db.name": "/tmp/demo.sqlite3",
            "db.statement": "SELECT price FROM items",
            "db.operation": "execute",
            "exception.type": "OperationalError",
            "exception.message": "no such column: price",
            "otel.status_code": "ERROR",
        },
        source_file="<database>",
        parent="evt_main",
    )
    uncaught_error = _synth_error_event(
        "evt_uncaught",
        trace_id,
        ts=999.0,
        resource={
            "exception.type": "ZeroDivisionError",
            "exception.message": "division by zero",
            "exception.stacktrace": "Traceback (most recent call last): ...",
            "otel.status_code": "ERROR",
        },
        source_file="<error>",
        parent=None,  # whole-script termination: no resolvable calling frame, see docstring
    )

    events = [main, callee_b, *net_events, db_error, uncaught_error]
    graph = build_graph(events, trace_id)
    return trace_id, graph, events, main, net_events


def test_bug_lens_returns_bug_report():
    trace_id, graph, events, _main, _net_events = _bug_lens_synthetic_graph_and_events()
    report = bug_lens(graph, events)
    assert isinstance(report, BugReport)
    assert report.trace_id == trace_id


def test_bug_lens_surfaces_both_planted_errors_with_real_detail():
    _trace_id, graph, events, main_event, _net_events = _bug_lens_synthetic_graph_and_events()
    report = bug_lens(graph, events)

    assert len(report.errors) == 2
    # chronological order (timestamp ascending), not input order
    assert [e.event_id for e in report.errors] == ["evt_db_error", "evt_uncaught"]

    db_finding = report.errors[0]
    assert db_finding.source_file == "<database>"
    assert db_finding.exception_type == "OperationalError"
    assert "no such column" in db_finding.exception_message
    assert db_finding.evidence_refs == ["evt_db_error"]

    main_node = next(n for n in graph.nodes if n.node_type == "function" and n.label == "main")
    # The db_query failure happened while "main" was the still-open calling
    # frame -- correctly resolved via the shared nearest_function_ancestor
    # walk, and the returned node_id is a REAL node_id already in the graph.
    assert db_finding.caller_node_id == main_node.node_id
    assert db_finding.caller_label == "main"

    uncaught_finding = report.errors[1]
    assert uncaught_finding.source_file == "<error>"
    assert uncaught_finding.exception_type == "ZeroDivisionError"
    assert uncaught_finding.exception_message in {
        "division by zero", "integer division or modulo by zero",
    }
    # No parent_event at all (as for a real whole-script termination span,
    # see ErrorFinding's docstring) -- honestly unresolved, not guessed.
    assert uncaught_finding.caller_node_id is None
    assert uncaught_finding.caller_label is None


def test_bug_lens_flags_the_planted_high_traffic_edge_and_only_that_edge():
    _trace_id, graph, events, main_event, net_events = _bug_lens_synthetic_graph_and_events()
    report = bug_lens(graph, events)

    # Exactly 2 edges in this graph: main->callee_b ("calls", count=1) and
    # main->host ("invokes", count=50). bug_lens computes the traffic
    # threshold independently PER RELATION (see its own docstring's
    # "why per-relation" note) -- each relation here has exactly 1 edge,
    # below _TRAFFIC_MIN_EDGES_FOR_STATS(3), so both groups hit the absolute
    # floor branch: threshold == _TRAFFIC_ABSOLUTE_COUNT_FLOOR (10), and
    # mean_count/stdev_count describe that single-edge group, not the whole
    # graph.
    assert len(graph.edges) == 2
    assert len(report.traffic_hotspots) == 1

    hotspot = report.traffic_hotspots[0]
    assert hotspot.relation == "invokes"
    assert hotspot.count == 50
    assert hotspot.threshold == 10.0
    assert hotspot.stdev_count == 0.0  # floor branch: no real stdev computed
    assert hotspot.mean_count == pytest.approx(50.0)  # mean of this relation group's single edge

    main_node = next(n for n in graph.nodes if n.node_type == "function" and n.label == "main")
    host_node = next(n for n in graph.nodes if n.node_type == "host")
    assert hotspot.source_node_id == main_node.node_id
    assert hotspot.target_node_id == host_node.node_id

    # every cited event_ref is real and traceable, and covers exactly the
    # 50 planted network events -- never fabricated, never truncated.
    assert set(hotspot.event_refs) == {e.event_id for e in net_events}

    # the ordinary count=1 "calls" edge must NOT be flagged
    flagged_relations = {h.relation for h in report.traffic_hotspots}
    assert "calls" not in flagged_relations


def test_bug_lens_on_graph_with_no_errors_and_no_hotspots_returns_empty_lists():
    trace_id = "synthetic-clean"
    main = _synth_fn_event("evt_main", trace_id, ts=0.0, file="app.py", function="main", dur_ms=10.0)
    worker = _synth_fn_event(
        "evt_worker", trace_id, ts=1.0, file="app.py", function="worker", dur_ms=1.0, parent="evt_main"
    )
    events = [main, worker]
    graph = build_graph(events, trace_id)

    report = bug_lens(graph, events)
    assert report.errors == []
    assert report.traffic_hotspots == []


def test_bug_lens_on_empty_graph_does_not_crash():
    graph = ComputationalGraph(trace_id="empty", nodes=[], edges=[])
    report = bug_lens(graph, [])
    assert report.trace_id == "empty"
    assert report.errors == []
    assert report.traffic_hotspots == []


# ---------------------------------------------------------------------------
# bug_lens: real pipeline (collect -> normalize -> build_graph) against real
# demo targets from earlier Phase 2 milestones -- demo_targets/error_case.py
# (a real recovered db_query failure + a real uncaught exception) and
# demo_targets/io_bound.py (the real N+1 HTTP pattern from Phase 0).
# ---------------------------------------------------------------------------


def test_bug_lens_real_error_case_trace_finds_the_real_planted_errors(tmp_path):
    trace_id = f"bug-lens-error-case-{uuid.uuid4().hex[:8]}"
    result = collect(
        script_path=str(ERROR_CASE_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=30,
    )
    # error_case.py deliberately crashes -- collect() still reports this via
    # its unchanged exit-code contract; normalize() still recovers the trace.
    assert result["error"] is not None
    assert "subprocess exited with code" in result["error"]

    events = normalize(result, trace_id)
    graph = build_graph(events, trace_id)

    report = bug_lens(graph, events)
    assert isinstance(report, BugReport)
    assert report.trace_id == trace_id

    # The real trace has exactly 2 real type="error" events -- same real
    # count tests/test_normalize.py's own error_case tests independently
    # confirm from the raw TraceEvent list.
    assert len(report.errors) == 2

    db_findings = [f for f in report.errors if f.source_file == "<database>"]
    assert len(db_findings) == 1
    db_finding = db_findings[0]
    assert db_finding.exception_type == "OperationalError"
    assert "no such column" in db_finding.exception_message
    # every evidence_ref must be a real, traceable event_id from this trace
    real_event_ids = {e.event_id for e in events}
    assert set(db_finding.evidence_refs).issubset(real_event_ids)

    uncaught_findings = [f for f in report.errors if f.source_file == "<error>"]
    assert len(uncaught_findings) == 1
    uncaught_finding = uncaught_findings[0]
    assert uncaught_finding.exception_type == "ZeroDivisionError"
    assert uncaught_finding.exception_message in {
        "division by zero", "integer division or modulo by zero",
    }

    # error_case.py's recovered db failure happens from inside run_bad_query,
    # which is still an open call frame at that instant -- real captured
    # data resolves this to a real caller, unlike the whole-script crash.
    if db_finding.caller_node_id is not None:
        assert db_finding.caller_label == "run_bad_query"
        assert any(n.node_id == db_finding.caller_node_id for n in graph.nodes)


def test_bug_lens_real_io_bound_trace_flags_the_real_n_plus_one_edge(tmp_path):
    """Real evidence, discovered while building this test, drove a real
    design decision (see ``bug_lens``'s own docstring, "why per-relation"):
    on this real trace, ``"calls"`` edges are dominated by thousands of
    fixed Python import-machinery calls that swamp any single global
    mean/stdev, while the genuine N+1 HTTP pattern (one ``fetch_user()``
    round trip per user, see ``demo_targets/io_bound.py``'s own docstring)
    only ever shows up on a small number of ``"invokes"`` edges targeting
    the local test server's host node -- so this test verifies the
    traffic-explosion signal specifically within the real ``"invokes"``
    edges, computed independently from the real graph (not just re-checking
    the report against itself), the same style
    ``test_complexity_lens_real_cpu_loop_trace_surfaces_fibonacci_recursion_cost``
    already uses above.
    """
    trace_id = f"bug-lens-io-bound-{uuid.uuid4().hex[:8]}"
    result = collect(
        script_path=str(IO_BOUND_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=50000,
        timeout_s=60,
    )
    assert result["error"] is None, f"unexpected collector error: {result['error']}"

    events = normalize(result, trace_id)
    graph = build_graph(events, trace_id)

    report = bug_lens(graph, events)
    assert isinstance(report, BugReport)
    # io_bound.py has no failures at all -- no fabricated errors.
    assert report.errors == []

    # Independently verify the real N+1 signal exists in the graph at all,
    # before checking whether bug_lens flagged it: io_bound.py makes exactly
    # 1 (list) + USER_COUNT (per-user) = 21 real HTTP round trips (see that
    # script's own docstring/USER_COUNT), which must show up as "invokes"
    # edges into the one real host node summing to exactly 21 -- however
    # many distinct edges the real interval-nesting ancestor resolution
    # happens to split that traffic across (a separate, already-documented
    # granularity limit of the shared ancestor walk -- not this test's
    # concern; see phosphor_graph/build.py's _is_instrumentation_noise for
    # that limit's own real-data justification).
    host_nodes = [n for n in graph.nodes if n.node_type == "host"]
    assert len(host_nodes) == 1, "io_bound.py's own local server is the only host every request targets"
    host_node = host_nodes[0]
    invokes_edges = [e for e in graph.edges if e.relation == "invokes" and e.target == host_node.node_id]
    assert invokes_edges, "expected real 'invokes' edges into the local test server's host node"
    assert sum(e.dynamic.count for e in invokes_edges) == 21, (
        f"expected the real captured trace to contain exactly 21 total HTTP "
        f"round trips (1 list + 20 per-user), got "
        f"{sum(e.dynamic.count for e in invokes_edges)} -- demo script or "
        f"collector behavior may have changed"
    )

    # Independently recompute the exact per-relation threshold bug_lens
    # itself would compute for this "invokes" population, directly from the
    # real graph -- then require it to be non-vacuous (at least one real
    # edge actually clears it) before comparing against the report.
    expected_threshold, _mean, _stdev = _traffic_count_threshold(
        [e.dynamic.count for e in invokes_edges]
    )
    expected_hotspot_ids = {e.edge_id for e in invokes_edges if e.dynamic.count > expected_threshold}
    assert expected_hotspot_ids, (
        "expected at least one real 'invokes' edge on genuine io_bound.py "
        "data to clear the traffic-explosion threshold"
    )

    report_invokes_hotspot_ids = {h.edge_id for h in report.traffic_hotspots if h.relation == "invokes"}
    assert report_invokes_hotspot_ids == expected_hotspot_ids, (
        f"bug_lens's reported 'invokes' hotspots {report_invokes_hotspot_ids} "
        f"did not match the independently-recomputed real hotspots "
        f"{expected_hotspot_ids}"
    )

    # every hotspot's threshold must be self-consistent with the documented
    # rule: count strictly exceeds threshold, and threshold is >= the
    # absolute floor (never a negative or nonsensical value); every cited
    # event_ref is real and traceable, never fabricated.
    for h in report.traffic_hotspots:
        assert h.count > h.threshold
        assert h.threshold >= 0.0
        assert set(h.event_refs).issubset({e.event_id for e in events})

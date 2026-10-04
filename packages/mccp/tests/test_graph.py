"""Unit + end-to-end tests for phosphor_graph.build.

The synthetic tests construct TraceEvent lists directly (no collector/
normalize involved) so they can freely set parent_event -- something the
real phosphor_trace.normalize does NOT do for function_call events today
(see phosphor_graph/build.py's module docstring). The end-to-end test runs
the real phosphor_collector.collect() + phosphor_trace.normalize() pipeline
against demo_targets/loop_calls.py and feeds the real result into
build_graph(), to prove node-count boundedness on real captured data.
"""

from __future__ import annotations

import uuid
from pathlib import Path

from phosphor_collector.collect import collect
from phosphor_graph.build import build_graph, get_last_build_stats
from phosphor_trace.normalize import normalize
from phosphor_trace.schema import (
    ComputationalGraph,
    Evidence,
    EvidenceLevel,
    RuntimeContext,
    SourceLocation,
    TraceEvent,
)

REPO_ROOT = Path(__file__).resolve().parent.parent
DEMO_TARGETS = REPO_ROOT / "demo_targets"
LOOP_SCRIPT = DEMO_TARGETS / "loop_calls.py"
DB_SCRIPT = DEMO_TARGETS / "db_bound.py"
IO_BOUND_SCRIPT = DEMO_TARGETS / "io_bound.py"


def _evidence() -> Evidence:
    return Evidence(level=EvidenceLevel.OBSERVED, confidence=1.0)


def _fn_event(event_id, trace_id, ts, file, function, line, pid=100, tid=1, dur_ms=0.5, parent=None):
    return TraceEvent(
        event_id=event_id,
        trace_id=trace_id,
        timestamp=ts,
        type="function_call",
        source=SourceLocation(file=file, line=line, function=function),
        runtime=RuntimeContext(pid=pid, tid=tid),
        duration_ms=dur_ms,
        parent_event=parent,
        evidence=_evidence(),
    )


def _net_event(event_id, trace_id, ts, resource, pid=100, tid=1, dur_ms=2.0, parent=None, name="GET"):
    return TraceEvent(
        event_id=event_id,
        trace_id=trace_id,
        timestamp=ts,
        type="network_request",
        source=SourceLocation(file="<network>", line=None, function=name),
        runtime=RuntimeContext(pid=pid, tid=tid),
        duration_ms=dur_ms,
        parent_event=parent,
        resource=resource,
        evidence=_evidence(),
    )


def _db_event(event_id, trace_id, ts, resource, pid=100, tid=1, dur_ms=1.0, parent=None, name="sqlite3.execute"):
    return TraceEvent(
        event_id=event_id,
        trace_id=trace_id,
        timestamp=ts,
        type="db_query",
        source=SourceLocation(file="<database>", line=None, function=name),
        runtime=RuntimeContext(pid=pid, tid=tid),
        duration_ms=dur_ms,
        parent_event=parent,
        resource=resource,
        evidence=_evidence(),
    )


def _mem_event(event_id, trace_id, ts, rss_bytes, vms_bytes, pid=100, tid=1):
    return TraceEvent(
        event_id=event_id,
        trace_id=trace_id,
        timestamp=ts,
        type="memory_sample",
        source=SourceLocation(file="<memory>", line=None, function="memory.sample"),
        runtime=RuntimeContext(pid=pid, tid=tid),
        resource={"memory.rss_bytes": str(rss_bytes), "memory.vms_bytes": str(vms_bytes)},
        evidence=_evidence(),
    )


# ---------------------------------------------------------------------------
# Core explosion-prevention: 100 calls to the same function -> 1 node, 1 edge
# ---------------------------------------------------------------------------


def test_repeated_calls_fold_into_one_node_and_one_edge():
    trace_id = "synthetic-loop"

    caller = _fn_event(
        "evt_caller", trace_id, ts=0.0, file="app.py", function="main", line=10, dur_ms=1000.0
    )

    callee_events = [
        _fn_event(
            f"evt_call_{i:04d}",
            trace_id,
            ts=1.0 + i,
            file="app.py",
            function="worker",
            line=42,
            dur_ms=2.0,
            parent="evt_caller",
        )
        for i in range(100)
    ]

    events = [caller, *callee_events]
    graph = build_graph(events, trace_id)

    assert isinstance(graph, ComputationalGraph)
    assert graph.trace_id == trace_id

    function_nodes = [n for n in graph.nodes if n.node_type == "function"]
    # exactly one node for "main" (the caller) and one for "worker" (the
    # callee) -- NOT 100 nodes for the 100 calls to worker.
    assert len(function_nodes) == 2
    labels = {n.label for n in function_nodes}
    assert labels == {"main", "worker"}

    worker_node = next(n for n in function_nodes if n.label == "worker")
    main_node = next(n for n in function_nodes if n.label == "main")
    assert worker_node.attributes["file"] == "app.py"

    calls_edges = [e for e in graph.edges if e.relation == "calls"]
    assert len(calls_edges) == 1, "100 calls to the same function must fold into exactly ONE edge"

    edge = calls_edges[0]
    assert edge.source == main_node.node_id
    assert edge.target == worker_node.node_id
    assert edge.dynamic.count == 100
    assert len(edge.dynamic.event_refs) == 100
    # every ref must be a real, traceable event_id from the input, never synthesized
    assert set(edge.dynamic.event_refs) == {e.event_id for e in callee_events}
    assert edge.dynamic.total_duration_ms == 200.0  # 100 * 2.0ms
    assert edge.dynamic.avg_latency_ms == 2.0


def test_node_and_edge_ids_are_deterministic_across_runs():
    trace_id_a = "det-a"
    trace_id_b = "det-b"

    def make_events(trace_id):
        caller = _fn_event("evt_caller", trace_id, 0.0, "app.py", "main", 10, dur_ms=5.0)
        callees = [
            _fn_event(f"evt_{i}", trace_id, 1.0 + i, "app.py", "worker", 42, dur_ms=1.0, parent="evt_caller")
            for i in range(5)
        ]
        return [caller, *callees]

    graph_a = build_graph(make_events(trace_id_a), trace_id_a)
    graph_b = build_graph(make_events(trace_id_b), trace_id_b)

    # Same (file, function) keys in both graphs -> identical node_ids, even
    # though trace_id and event_ids differ between the two builds.
    nodes_a = {n.label: n.node_id for n in graph_a.nodes if n.node_type == "function"}
    nodes_b = {n.label: n.node_id for n in graph_b.nodes if n.node_type == "function"}
    assert nodes_a == nodes_b

    edges_a = {(e.source, e.target, e.relation): e.edge_id for e in graph_a.edges}
    edges_b = {(e.source, e.target, e.relation): e.edge_id for e in graph_b.edges}
    assert edges_a == edges_b


def test_process_node_deduplicated_by_pid():
    trace_id = "proc-dedup"
    events = [
        _fn_event(f"evt_{i}", trace_id, float(i), "app.py", "f", 1, pid=999, tid=i) for i in range(10)
    ]
    graph = build_graph(events, trace_id)
    process_nodes = [n for n in graph.nodes if n.node_type == "process"]
    assert len(process_nodes) == 1
    assert process_nodes[0].attributes["pid"] == 999


# ---------------------------------------------------------------------------
# "invokes" edges (function -> host), also aggregated
# ---------------------------------------------------------------------------


def test_repeated_network_calls_fold_into_one_invokes_edge():
    trace_id = "synthetic-net"

    caller = _fn_event("evt_caller", trace_id, 0.0, "client.py", "fetch_all", 5, dur_ms=500.0)

    net_events = [
        _net_event(
            f"evt_net_{i:03d}",
            trace_id,
            ts=1.0 + i,
            resource={"http.method": "GET", "http.url": "http://example.com:8080/items", "http.status_code": "200"},
            dur_ms=10.0,
            parent="evt_caller",
        )
        for i in range(25)
    ]

    graph = build_graph([caller, *net_events], trace_id)

    host_nodes = [n for n in graph.nodes if n.node_type == "host"]
    assert len(host_nodes) == 1
    assert host_nodes[0].label == "example.com:8080"

    invokes_edges = [e for e in graph.edges if e.relation == "invokes"]
    assert len(invokes_edges) == 1
    edge = invokes_edges[0]
    assert edge.dynamic.count == 25
    assert len(edge.dynamic.event_refs) == 25
    assert edge.dynamic.total_duration_ms == 250.0
    assert edge.dynamic.avg_latency_ms == 10.0


def test_repeated_db_queries_fold_into_one_invokes_edge_to_one_database_node():
    trace_id = "synthetic-db"

    caller = _fn_event("evt_caller", trace_id, 0.0, "app.py", "fetch_all_rows", 5, dur_ms=500.0)

    db_events = [
        _db_event(
            f"evt_db_{i:03d}",
            trace_id,
            ts=1.0 + i,
            resource={
                "db.system": "sqlite",
                "db.name": "/tmp/demo.sqlite3",
                "db.statement": "SELECT id FROM users WHERE id = ?",
                "db.operation": "execute",
            },
            dur_ms=0.5,
            parent="evt_caller",
        )
        for i in range(30)
    ]

    graph = build_graph([caller, *db_events], trace_id)

    database_nodes = [n for n in graph.nodes if n.node_type == "database"]
    assert len(database_nodes) == 1, "30 queries against the same db must fold into exactly ONE database node"
    assert database_nodes[0].label == "/tmp/demo.sqlite3"

    invokes_edges = [e for e in graph.edges if e.relation == "invokes"]
    assert len(invokes_edges) == 1, "30 db_query events must fold into exactly ONE 'invokes' edge, not one per query"
    edge = invokes_edges[0]
    assert edge.target == database_nodes[0].node_id
    assert edge.dynamic.count == 30
    assert len(edge.dynamic.event_refs) == 30
    assert set(edge.dynamic.event_refs) == {e.event_id for e in db_events}
    assert edge.dynamic.total_duration_ms == 15.0  # 30 * 0.5ms
    assert edge.dynamic.avg_latency_ms == 0.5

    stats = get_last_build_stats()
    assert stats.db_query_events == 30
    assert stats.db_invokes_edge_events == 30
    assert stats.db_invokes_unresolved_events == 0


def test_two_distinct_db_paths_produce_two_database_nodes():
    trace_id = "synthetic-db-two-paths"
    caller = _fn_event("evt_caller", trace_id, 0.0, "app.py", "run_both", 5, dur_ms=500.0)
    ev_a = _db_event(
        "evt_a", trace_id, 1.0,
        resource={"db.system": "sqlite", "db.name": "/tmp/a.sqlite3", "db.statement": "SELECT 1", "db.operation": "execute"},
        parent="evt_caller",
    )
    ev_b = _db_event(
        "evt_b", trace_id, 2.0,
        resource={"db.system": "sqlite", "db.name": "/tmp/b.sqlite3", "db.statement": "SELECT 1", "db.operation": "execute"},
        parent="evt_caller",
    )

    graph = build_graph([caller, ev_a, ev_b], trace_id)

    database_nodes = [n for n in graph.nodes if n.node_type == "database"]
    assert len(database_nodes) == 2
    assert {n.label for n in database_nodes} == {"/tmp/a.sqlite3", "/tmp/b.sqlite3"}

    invokes_edges = [e for e in graph.edges if e.relation == "invokes"]
    assert len(invokes_edges) == 2
    for e in invokes_edges:
        assert e.dynamic.count == 1


def test_network_event_with_missing_duration_contributes_zero_but_still_counts():
    trace_id = "net-no-duration"
    caller = _fn_event("evt_caller", trace_id, 0.0, "client.py", "fetch", 5)
    net_event = _net_event(
        "evt_net_0",
        trace_id,
        ts=1.0,
        resource={"http.url": "http://svc.local/"},
        dur_ms=None,
        parent="evt_caller",
    )
    graph = build_graph([caller, net_event], trace_id)
    invokes_edges = [e for e in graph.edges if e.relation == "invokes"]
    assert len(invokes_edges) == 1
    assert invokes_edges[0].dynamic.count == 1
    assert invokes_edges[0].dynamic.total_duration_ms == 0.0
    assert invokes_edges[0].dynamic.avg_latency_ms == 0.0


# ---------------------------------------------------------------------------
# Graceful handling of missing/ambiguous parent_event linkage
# ---------------------------------------------------------------------------


def test_events_with_no_parent_produce_no_edge_but_still_a_node_and_are_counted():
    trace_id = "no-parent"
    orphan = _fn_event("evt_orphan", trace_id, 0.0, "app.py", "standalone", 1, parent=None)

    graph = build_graph([orphan], trace_id)

    function_nodes = [n for n in graph.nodes if n.node_type == "function"]
    assert len(function_nodes) == 1
    assert graph.edges == []

    stats = get_last_build_stats()
    assert stats is not None
    assert stats.calls_unresolved_events == 1
    assert stats.calls_edge_events == 0


def test_dangling_parent_reference_does_not_crash_and_is_counted_unresolved():
    trace_id = "dangling-parent"
    # parent_event points at an id that was never captured in this trace --
    # must be skipped gracefully, never fabricated into a fake caller node.
    orphan = _fn_event("evt_child", trace_id, 0.0, "app.py", "child", 1, parent="evt_never_seen")

    graph = build_graph([orphan], trace_id)

    function_nodes = [n for n in graph.nodes if n.node_type == "function"]
    assert len(function_nodes) == 1
    assert graph.edges == []

    stats = get_last_build_stats()
    assert stats.calls_unresolved_events == 1


def test_multi_hop_ancestor_chain_resolves_through_intermediate_events():
    trace_id = "multi-hop"
    # grandparent (function_call) -> intermediate network_request (parent to
    # itself irrelevant here) -> child function_call whose nearest
    # function_call ancestor must be the grandparent, walked through the hop.
    grandparent = _fn_event("evt_gp", trace_id, 0.0, "app.py", "outer", 1)
    intermediate = _net_event(
        "evt_mid", trace_id, 1.0, resource={"http.url": "http://x/"}, parent="evt_gp"
    )
    child = _fn_event("evt_child", trace_id, 2.0, "app.py", "inner", 2, parent="evt_mid")

    graph = build_graph([grandparent, intermediate, child], trace_id)

    calls_edges = [e for e in graph.edges if e.relation == "calls"]
    assert len(calls_edges) == 1
    outer_node = next(n for n in graph.nodes if n.node_type == "function" and n.label == "outer")
    inner_node = next(n for n in graph.nodes if n.node_type == "function" and n.label == "inner")
    assert calls_edges[0].source == outer_node.node_id
    assert calls_edges[0].target == inner_node.node_id


def test_cyclic_parent_event_does_not_infinite_loop_and_resolves_unresolved():
    trace_id = "cyclic"
    # Malformed data: a <-> b parent_event cycle where NEITHER event is a
    # function_call (so the walk can never terminate by hitting one) --
    # must be detected and terminate rather than looping forever, and must
    # count as unresolved, never fabricate a parent.
    resource = {"http.url": "http://x/"}
    net_a = _net_event("evt_net_a", trace_id, 0.0, resource=resource, parent="evt_net_b")
    net_b = _net_event("evt_net_b", trace_id, 1.0, resource=resource, parent="evt_net_a")

    graph = build_graph([net_a, net_b], trace_id)  # must return, not hang

    assert graph.edges == []
    stats = get_last_build_stats()
    assert stats.invokes_unresolved_events == 2


# ---------------------------------------------------------------------------
# memory_sample events: process-node attributes, never a new node/edge type
# ---------------------------------------------------------------------------


def test_memory_sample_events_aggregate_peak_and_mean_rss_per_pid():
    trace_id = "synthetic-memory"
    fn = _fn_event("evt_fn", trace_id, 0.0, "app.py", "main", 10, pid=42, tid=1)
    rss_values = [10_000_000, 30_000_000, 20_000_000]
    mem_events = [
        _mem_event(f"evt_mem_{i}", trace_id, ts=1.0 + i, rss_bytes=rss, vms_bytes=rss * 2, pid=42, tid=1)
        for i, rss in enumerate(rss_values)
    ]

    graph = build_graph([fn, *mem_events], trace_id)

    process_nodes = [n for n in graph.nodes if n.node_type == "process"]
    assert len(process_nodes) == 1
    node = process_nodes[0]
    assert node.attributes["pid"] == 42

    expected_peak_mb = round(max(rss_values) / (1024 * 1024), 2)
    expected_mean_mb = round((sum(rss_values) / len(rss_values)) / (1024 * 1024), 2)
    # str-coerced -- Node.attributes (the canonical schema) is typed
    # dict[str, str | int], no float member (see phosphor_graph.build's
    # module docstring).
    assert node.attributes["peak_rss_mb"] == str(expected_peak_mb)
    assert node.attributes["mean_rss_mb"] == str(expected_mean_mb)

    # memory_sample events must never create a new node type, nor any edge
    # (there is no causal "which function caused this" link to draw).
    assert {n.node_type for n in graph.nodes} == {"function", "process"}
    assert graph.edges == []

    stats = get_last_build_stats()
    assert stats is not None
    assert stats.memory_sample_events == 3
    assert stats.total_events == 4


def test_process_with_zero_memory_samples_has_no_rss_attributes():
    trace_id = "synthetic-no-memory"
    fn = _fn_event("evt_fn", trace_id, 0.0, "app.py", "main", 10, pid=7, tid=1)

    graph = build_graph([fn], trace_id)

    process_nodes = [n for n in graph.nodes if n.node_type == "process"]
    assert len(process_nodes) == 1
    node = process_nodes[0]
    # A pid that never produced a real memory sample gets no
    # peak_rss_mb/mean_rss_mb attributes at all -- never a fabricated 0/null
    # for a measurement that was never actually taken.
    assert "peak_rss_mb" not in node.attributes
    assert "mean_rss_mb" not in node.attributes

    stats = get_last_build_stats()
    assert stats.memory_sample_events == 0


# ---------------------------------------------------------------------------
# End-to-end: real collect() + normalize() -> build_graph() on real data
# ---------------------------------------------------------------------------


def test_end_to_end_real_trace_bounds_node_count_despite_many_calls(tmp_path):
    trace_id = f"e2e-loop-{uuid.uuid4().hex[:8]}"

    result = collect(
        script_path=str(LOOP_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=50000,
        timeout_s=60,
    )
    assert result["error"] is None, f"unexpected collector error: {result['error']}"

    events = normalize(result, trace_id)
    function_call_events = [e for e in events if e.type == "function_call"]

    # loop_calls.py calls square() 500 times in a loop -> hundreds of raw
    # function_call events (one per call), not counting builtins/import
    # machinery also captured by viztracer.
    assert len(function_call_events) >= 500, (
        f"expected the real trace to contain >=500 function_call events from "
        f"the loop, got {len(function_call_events)} -- demo script or "
        f"collector behavior may have changed"
    )

    graph = build_graph(events, trace_id)
    assert isinstance(graph, ComputationalGraph)
    assert graph.trace_id == trace_id

    function_nodes = [n for n in graph.nodes if n.node_type == "function"]
    labels = {n.label for n in function_nodes}
    assert "square" in labels
    assert "main" in labels

    # THE explosion-prevention proof: node count stays small and bounded --
    # one node per distinct (file, function) actually used, including the
    # (fixed, not-per-call) set of import-machinery/builtin callables
    # invoked during interpreter startup -- even though the underlying
    # event count scales with N_CALLS (500 calls to square() alone). The
    # generous absolute cap plus the ratio check both independently confirm
    # boundedness without hardcoding a fragile exact number that would
    # break on interpreter-version import-machinery changes.
    assert len(function_nodes) < 300, (
        f"expected a small, bounded number of function nodes, got "
        f"{len(function_nodes)} for {len(function_call_events)} raw call events "
        f"-- graph explosion is NOT being prevented"
    )
    assert len(function_nodes) < len(function_call_events) * 0.5

    # square() itself must have folded to exactly one node no matter how
    # many of the >=500 calls contributed to it.
    square_nodes = [n for n in function_nodes if n.label == "square"]
    assert len(square_nodes) == 1

    stats = get_last_build_stats()
    assert stats is not None
    assert stats.total_events == len(events)
    assert stats.node_count == len(graph.nodes)
    assert stats.edge_count == len(graph.edges)

    # phosphor_trace.normalize now populates parent_event via interval-nesting
    # call-stack reconstruction (see its module docstring), so the vast
    # majority of function_call events resolve to a real "calls" edge -- only
    # the outermost frame(s) (e.g. the top-level runpy invocation, which has
    # no captured caller of its own) are legitimately unresolved, not every
    # single event as before that fix.
    assert stats.calls_edge_events > 0, "expected real 'calls' edges on real captured data"
    assert stats.calls_unresolved_events < 10, (
        f"expected only the outermost frame(s) to be unresolved, got "
        f"{stats.calls_unresolved_events} unresolved out of {len(function_call_events)} events"
    )

    # THE edge-explosion-prevention proof: edge count also stays small and
    # bounded (one edge per distinct (caller, callee) pair, aggregated),
    # even though 500+ individual square() calls contributed to it.
    assert len(graph.edges) < 300, (
        f"expected a small, bounded number of edges, got {len(graph.edges)} "
        f"for {len(function_call_events)} raw call events -- edge explosion "
        f"is NOT being prevented"
    )

    # main() calls square() 500 times directly in a loop -- this must fold
    # into exactly one "calls" edge with count >= 500, not 500 separate edges.
    main_node = next(n for n in function_nodes if n.label == "main")
    square_node = square_nodes[0]
    main_to_square = [
        e for e in graph.edges
        if e.source == main_node.node_id and e.target == square_node.node_id and e.relation == "calls"
    ]
    assert len(main_to_square) == 1, (
        f"expected exactly one aggregated main->square 'calls' edge, found {len(main_to_square)}"
    )
    edge = main_to_square[0]
    assert edge.dynamic.count >= 500
    assert len(edge.dynamic.event_refs) == edge.dynamic.count
    # every cited event_ref must be a real, traceable event_id -- never fabricated.
    event_ids = {e.event_id for e in events}
    assert all(ref in event_ids for ref in edge.dynamic.event_refs)


def test_end_to_end_db_bound_real_trace_folds_n_plus_one_select_loop_into_one_edge(tmp_path):
    trace_id = f"e2e-db-{uuid.uuid4().hex[:8]}"

    result = collect(
        script_path=str(DB_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=50000,
        timeout_s=60,
    )
    assert result["error"] is None, f"unexpected collector error: {result['error']}"

    events = normalize(result, trace_id)
    db_query_events = [e for e in events if e.type == "db_query"]
    # 1 CREATE + 1 executemany INSERT + 1 COUNT + 20 per-user SELECTs
    # (db_bound.py's USER_COUNT) = 23 real sqlite3 queries.
    assert len(db_query_events) == 23, (
        f"expected 23 real db_query events, got {len(db_query_events)} -- "
        f"demo script or collector behavior may have changed"
    )
    for e in db_query_events:
        assert e.evidence.level == EvidenceLevel.OBSERVED

    graph = build_graph(events, trace_id)
    assert isinstance(graph, ComputationalGraph)

    # exactly ONE database node -- every query in db_bound.py targets the
    # same single temp sqlite3 file (static node identity, never per-call).
    database_nodes = [n for n in graph.nodes if n.node_type == "database"]
    assert len(database_nodes) == 1, (
        f"expected exactly 1 database node for the one temp db file used by "
        f"db_bound.py, got {len(database_nodes)}"
    )
    db_node = database_nodes[0]
    assert db_node.label.endswith(".sqlite3")

    function_nodes = [n for n in graph.nodes if n.node_type == "function"]
    fetch_user_node = next((n for n in function_nodes if n.label == "fetch_user"), None)
    assert fetch_user_node is not None, (
        "expected a real 'fetch_user' function node -- if this is missing, "
        "the invokes-edge ancestor walk is not resolving past OTel-SDK/"
        "instrumentation-internal frames to the real calling function (see "
        "phosphor_graph.build._is_instrumentation_noise)"
    )

    invokes_edges = [e for e in graph.edges if e.relation == "invokes" and e.target == db_node.node_id]
    # THE explosion-prevention proof for db edges: create_schema (1 call),
    # insert_users (1 executemany call), fetch_user_count (1 call), and the
    # fetch_user N+1 SELECT loop (20 calls) are 4 distinct callers -> at
    # most 4 aggregated edges into the database node, never one edge per
    # query (which would be 23).
    assert 1 <= len(invokes_edges) <= 4, (
        f"expected a small, bounded number of aggregated invokes edges into "
        f"the database node (<=4 distinct real callers), got "
        f"{len(invokes_edges)} -- got one-edge-per-query or unexpected "
        f"fragmentation instead of real aggregation"
    )

    # THE N+1-aggregation proof: the fetch_user() loop's 20 real SELECT
    # calls must fold into exactly ONE aggregated "invokes" edge with
    # count == 20 (the real loop iteration count), not 20 separate edges.
    fetch_user_to_db = [e for e in invokes_edges if e.source == fetch_user_node.node_id]
    assert len(fetch_user_to_db) == 1, (
        f"expected exactly one aggregated fetch_user->database 'invokes' "
        f"edge, found {len(fetch_user_to_db)}"
    )
    edge = fetch_user_to_db[0]
    assert edge.dynamic.count == 20, (
        f"expected the N+1 SELECT loop's real iteration count (20), got "
        f"{edge.dynamic.count}"
    )
    assert len(edge.dynamic.event_refs) == 20

    # every cited event_ref must be a real, traceable event_id -- never fabricated.
    event_ids = {e.event_id for e in events}
    assert all(ref in event_ids for ref in edge.dynamic.event_refs)
    # and every ref must actually point at a real db_query event (not, say,
    # a function_call event that happened to share the id namespace).
    db_query_ids = {e.event_id for e in db_query_events}
    assert set(edge.dynamic.event_refs).issubset(db_query_ids)

    stats = get_last_build_stats()
    assert stats is not None
    assert stats.db_query_events == 23
    assert stats.db_invokes_edge_events == 23
    assert stats.db_invokes_unresolved_events == 0


def test_end_to_end_io_bound_real_trace_surfaces_real_peak_and_mean_rss_on_process_node(tmp_path):
    """io_bound.py's 21 real HTTP round trips give the ~50ms-period
    background memory sampler several real ticks (see
    tests/test_collector.py::test_collect_produces_real_nonzero_memory_samples
    and tests/test_normalize.py::
    test_normalize_io_bound_produces_observed_memory_sample_events, both of
    which already confirm real, nonzero samples on this exact demo script).
    This test confirms build_graph() folds those real samples into real
    peak_rss_mb/mean_rss_mb attributes on the traced process's node.
    """
    trace_id = f"e2e-mem-{uuid.uuid4().hex[:8]}"

    result = collect(
        script_path=str(IO_BOUND_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=30,
    )
    assert result["error"] is None, f"unexpected collector error: {result['error']}"

    events = normalize(result, trace_id)
    memory_events = [e for e in events if e.type == "memory_sample"]
    assert len(memory_events) >= 2, (
        f"expected several real memory_sample events from io_bound.py's 21 "
        f"real HTTP round trips, got {len(memory_events)}"
    )

    graph = build_graph(events, trace_id)

    process_nodes = [n for n in graph.nodes if n.node_type == "process"]
    assert len(process_nodes) == 1, (
        "io_bound.py runs single-process -- expected exactly one process node"
    )
    process_node = process_nodes[0]

    assert "peak_rss_mb" in process_node.attributes
    assert "mean_rss_mb" in process_node.attributes
    peak_rss_mb = float(process_node.attributes["peak_rss_mb"])
    mean_rss_mb = float(process_node.attributes["mean_rss_mb"])
    assert peak_rss_mb > 0.0
    assert mean_rss_mb > 0.0
    assert peak_rss_mb >= mean_rss_mb

    # Cross-check against the real rss_bytes values on the normalized
    # memory_sample events themselves -- proves build_graph aggregated the
    # real observed samples, not some fabricated/placeholder number.
    rss_values = [int(e.resource["memory.rss_bytes"]) for e in memory_events]
    expected_peak_mb = round(max(rss_values) / (1024 * 1024), 2)
    expected_mean_mb = round((sum(rss_values) / len(rss_values)) / (1024 * 1024), 2)
    assert peak_rss_mb == expected_peak_mb
    assert mean_rss_mb == expected_mean_mb

    # memory_sample events must never produce a new node type or any edge of
    # their own (see phosphor_graph.build's module docstring).
    assert {n.node_type for n in graph.nodes} <= {"function", "host", "process", "database"}

    stats = get_last_build_stats()
    assert stats is not None
    assert stats.memory_sample_events == len(memory_events)
    assert stats.total_events == len(events)

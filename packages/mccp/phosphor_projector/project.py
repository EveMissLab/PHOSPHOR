"""phosphor_projector.project -- pure scale projections over a
``ComputationalGraph`` (see ``phosphor_trace.schema`` for the canonical
``Node`` / ``Edge`` / ``EdgeDynamics`` / ``ComputationalGraph`` model,
imported here, never redefined).

The whitepaper's Multiscale Computational Comprehension model defines three
scales: macro (process/host), meso (function), and micro (source line / AST
/ bytecode). Per the MVP scope (repository README, "Phase 0 / MVP v0.1"
section: "one macro/meso graph"), only macro and meso are implemented in
v0.1 -- micro is explicitly out of scope, and ``project(graph, "micro")``
raises rather than silently returning something wrong (see ``project``
below).

Every function in this module is a pure function of its ``ComputationalGraph``
argument: no I/O, no mutation of the input, no global/module-level state
(unlike ``phosphor_graph.build``'s ``GraphBuildStats``, this module keeps no
"last call" state -- everything worth reporting about a projection is
already captured by the returned graph itself, so there is nothing to stash
out-of-band). ``project_meso`` and ``project_macro`` both return a *fresh*
``ComputationalGraph`` (deep-copied where nodes pass through unchanged) so a
caller mutating the result can never corrupt the graph that was passed in.

meso == base resolution for v0.1
---------------------------------
``phosphor_graph.build.build_graph`` already produces its output at
function/host/process granularity -- i.e. exactly "meso" scale as defined by
the whitepaper. There is currently no coarser-than-function,
finer-than-macro representation to build *down* to, and no source-line/AST/
bytecode ("micro") representation to build further *down* from either. So
for this MVP, ``project_meso`` is the identity projection (a defensive deep
copy, not a real aggregation) -- meso is simply "the graph as already
built." ``project_macro`` is the one real aggregation this module performs,
rolling meso resolution *up* to macro.

macro = process/host nodes only, everything else rolled up
-------------------------------------------------------------
``project_macro`` keeps only ``"process"`` and ``"host"`` type nodes, with
their original ``node_id`` preserved unchanged (so a process/host node_id
found via ``project_meso``/``build_graph`` output still resolves to the
"same" node at macro scale -- extending, across scales, the node_id lookup-
stability contract ``phosphor_graph.build``'s module docstring establishes
for downstream ``phosphor_explain``/UI agents). Every other node type
(function, file, thread, database) is dropped; its outgoing-edge activity is
rolled into its owning process node's ``attributes`` as:

- ``function_count``    -- how many such nodes collapsed into this process.
- ``total_call_count``  -- sum of ``EdgeDynamics.count`` over every edge
  whose source was one of this process's collapsed nodes. Covers both edges
  that remain visible at macro scale (e.g. a cross-process call, or a
  function's ``invokes`` edge to an external host) *and* edges that become
  an intra-process self-loop and are therefore dropped as an edge -- their
  volume is not lost, just re-expressed as a node attribute instead of an
  edge, per "drop individual function nodes, roll their activity into their
  owning process node's attributes."

Concretely: an edge whose two endpoints collapse to the *same* process/host
node becomes a self-loop and is NOT emitted (folded into
``total_call_count`` instead, as above). An edge whose endpoints collapse to
two *different* process/host nodes becomes a new, freshly aggregated
``Edge`` between them -- aggregated per ``(source, target, relation)``
triple exactly the way ``phosphor_graph.build`` aggregates per-call edges:
``count`` sums, ``total_duration_ms`` sums, ``avg_latency_ms`` is
recomputed, and ``event_refs`` are concatenated and never truncated (same
reasoning as ``phosphor_graph.build``'s module docstring: ``EdgeDynamics``,
the canonical schema, has no field to mark a list as truncated, so the only
honest option is to not truncate it).

Ownership resolution: the ``"pid"`` attribute convention (a documented gap)
-----------------------------------------------------------------------------
The canonical schema has no edge relation meaning "runs in process" / "owned
by process" -- ``EdgeRelation`` is only ``"calls" | "reads" | "writes" |
"invokes" | "depends_on"``, and ``phosphor_graph.build.build_graph`` never
draws any of those between a function node and a process node (as of this
writing, ``build_graph`` never emits an edge touching a process node at
all -- process nodes exist purely so every event contributes at least one
node). So this module makes the following documented, non-schema-breaking
choice: a non-process/host node is considered "owned" by the process node
whose ``attributes["pid"]`` matches that node's own ``attributes["pid"]``
(compared as ``str``, to tolerate int/str mismatches), if the node carries a
``"pid"`` attribute at all. A node whose ``"pid"`` is set but does not match
any process node in the graph is treated as genuinely unresolved -- it is
NOT silently reassigned to some other process, even if only one exists,
because an explicit-but-unmatched claim should never be overridden by a
guess. Only when a node carries **no** ``"pid"`` attribute at all (true of
every function node ``phosphor_graph.build`` produces today) does this
module fall back to the sole process node, and only when the graph contains
**exactly one** -- overwhelmingly the common case for this MVP's "one
script at a time" scope (see README), where there is no real ambiguity to
resolve. In every other unresolvable case the node (and any edge touching
it) is dropped from the macro projection and a warning is logged -- never
guessed. If/when ``phosphor_graph.build`` starts tagging function nodes with
their owning ``pid`` (a natural, small enhancement), multi-process macro
projection becomes fully accurate with no changes needed here.

Complexity Lens (whitepaper Sec.17): ``complexity_lens``
-----------------------------------------------------------
``complexity_lens(graph, top_k=10)`` answers "not just a number, but WHICH
edge produced this cost" (whitepaper Sec.17) by aggregating purely over data
``phosphor_graph.build`` already put on the graph -- no new tracing, no
estimation. It returns a ``ComplexityReport``, a module-local dataclass
(deliberately NOT added to ``phosphor_trace.schema`` -- this is a derived/
computed view over a ``ComputationalGraph``, not a core type every module
needs to share, exactly the same precedent as ``phosphor_graph.build``'s own
``GraphBuildStats`` being module-local reporting rather than a schema
addition). See ``ComplexityReport``'s own docstring, and ``complexity_lens``'s,
for the full per-node/per-edge/per-relation aggregation contract and the
"no silent caps" discipline it follows for its top-K edge summary.

Bug Lens (whitepaper Sec.15.2): ``bug_lens``
-------------------------------------------------
``bug_lens(graph, events)`` surfaces error/anomaly signal already present in
a captured trace -- it does not re-trace or re-run anything, and it does not
invent a signal the current data model cannot honestly back. Unlike every
other function in this module, it needs BOTH the ``ComputationalGraph`` (for
edge/node structure) and the raw ``events`` list, because per-event error
detail (``resource["exception.type"]``/``["exception.message"]``) lives only
on the original ``TraceEvent`` -- ``phosphor_graph.build.build_graph``
deliberately does not fold ``type="error"`` events into any node/edge (see
that module's own test coverage), so the graph alone cannot answer "what
actually failed and why." Returns a ``BugReport``, another module-local
dataclass for the same reason ``ComplexityReport``/``GraphBuildStats`` are:
derived reporting over already-captured data, not a core type.

Whitepaper Sec.15.2 lists several bug-signature categories (error, retry,
timeout, wait, lock, traffic explosion). This MVP's current data model --
``TraceEvent``/``Node``/``Edge`` as defined in ``phosphor_trace/schema.py`` --
only actually distinguishes two of them from real captured evidence:

- **error** -- every ``type="error"`` event, with its real
  ``exception.type``/``exception.message`` resource detail, linked to the
  nearest resolvable calling function via
  ``phosphor_graph.build.nearest_function_ancestor`` (the SAME shared
  ancestor-walk implementation ``build_graph`` itself uses for
  ``db_query``/``network_request`` "invokes" edges -- not a second,
  independently-written walk that could silently diverge from it, see that
  function's own docstring for why it is public).
- **traffic explosion** -- an edge whose ``EdgeDynamics.count`` is flagged as
  unusually high relative to other edges of the *same* ``EdgeRelation``
  (``"calls"`` compared only to ``"calls"``, ``"invokes"`` only to
  ``"invokes"``, etc. -- see ``bug_lens``'s own docstring for the real-data
  reason this is scoped per-relation rather than over the whole graph at
  once), per an explicit, documented statistical rule (see
  ``_traffic_count_threshold``'s docstring for the exact threshold). This is
  a HEURISTIC, labeled as such: a high call count is consistent with an
  N+1-style pattern, not proof of one -- legitimately busy code produces the
  same shape of signal.

**Explicitly out of scope for now** -- retry, timeout, wait, and lock. Not
because they are unimportant, but because nothing in the current data model
actually distinguishes them from an ordinary repeated call or an ordinarily
slow one, and faking a signal for a category this project cannot honestly
back would violate the Hallucination Control discipline the whole codebase
follows (whitepaper Sec.24; see ``phosphor_trace/schema.py``'s module
docstring):

- *retry*: a function called N times in a loop and a function retried N
  times after N failures produce the exact same shape of aggregated edge
  (``EdgeDynamics.count == N``) -- there is no field anywhere in
  ``TraceEvent``/``Edge`` marking "this call was a retry of that other call."
  Distinguishing them would require either an explicit retry-library marker
  captured at collection time (not implemented) or correlating consecutive
  ``type="error"`` events against subsequent same-target calls by
  timing/target proximity -- a real *inference*, not an *observation*, and
  therefore out of scope for this evidence-only lens.
- *timeout*: nothing in ``EventType``/``resource`` marks a captured failure
  as specifically a timeout versus any other exception; a timeout would just
  appear as an ordinary ``type="error"`` event with whatever
  ``exception.type`` the underlying library raised (e.g. ``requests``'
  ``ConnectTimeout``) -- already surfaced honestly under the **error**
  category above, not double-counted under a fabricated "timeout" category.
- *wait* / *lock*: there is no event type, resource attribute, or timing
  convention anywhere in the current pipeline that records blocking/waiting
  time as distinct from ordinary ``duration_ms`` -- a slow call and a
  lock-blocked call are indistinguishable in the data as captured today.
"""

from __future__ import annotations

import hashlib
import logging
import statistics
from dataclasses import dataclass, field
from typing import Literal

from phosphor_graph.build import nearest_function_ancestor
from phosphor_trace.schema import ComputationalGraph, Edge, EdgeDynamics, Node, TraceEvent

logger = logging.getLogger(__name__)

_RECORD_SEP = "\x1e"
_MACRO_NODE_TYPES = frozenset({"process", "host"})


def _stable_edge_id(*parts: str) -> str:
    """Deterministic edge id for a newly aggregated macro-scale edge.

    Same key-part convention as ``phosphor_graph.build``'s private
    ``_stable_id`` (record-separator-joined SHA-256 prefix), reimplemented
    locally rather than imported: these ids are computed from different key
    parts (collapsed process/host node_ids, not raw file/function/host
    strings), there is no shared state to reuse, and this module should not
    reach into another module's private (underscore-prefixed) helpers.
    """
    key = _RECORD_SEP.join(parts)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    return f"edge_{digest}"


@dataclass
class _EdgeAccumulator:
    count: int = 0
    total_duration_ms: float = 0.0
    event_refs: list[str] = field(default_factory=list)


def _resolve_owners(graph: ComputationalGraph) -> dict[str, str]:
    """Map every resolvable node_id in ``graph`` to the node_id it collapses
    into at macro scale.

    Process/host nodes map to themselves. Every other node maps to its
    owning process node's id if resolvable via the "pid attribute"
    convention described in the module docstring; nodes with no resolvable
    owner are simply absent from the returned map (dropped, not guessed --
    a warning is logged for each).
    """
    process_nodes = [n for n in graph.nodes if n.node_type == "process"]
    host_nodes = [n for n in graph.nodes if n.node_type == "host"]

    pid_to_process_id = {
        str(p.attributes["pid"]): p.node_id for p in process_nodes if "pid" in p.attributes
    }
    sole_process_id = process_nodes[0].node_id if len(process_nodes) == 1 else None

    owners: dict[str, str] = {}
    for n in process_nodes:
        owners[n.node_id] = n.node_id
    for n in host_nodes:
        owners[n.node_id] = n.node_id

    for n in graph.nodes:
        if n.node_type in _MACRO_NODE_TYPES:
            continue

        pid_attr = n.attributes.get("pid")
        if pid_attr is not None:
            # Explicit claim: match it, or leave genuinely unresolved --
            # never silently reassigned to a different process as a guess.
            owner_id = pid_to_process_id.get(str(pid_attr))
        else:
            # No claim at all: only safe to assume when there is exactly
            # one process node in the whole graph (no real ambiguity).
            owner_id = sole_process_id

        if owner_id is not None:
            owners[n.node_id] = owner_id
        else:
            logger.warning(
                "project_macro: node_id=%r (type=%r, label=%r) has no "
                "resolvable owning process (pid attribute=%r, %d process "
                "node(s) in graph) -- dropped from macro projection, not "
                "guessed.",
                n.node_id,
                n.node_type,
                n.label,
                pid_attr,
                len(process_nodes),
            )
    return owners


def project_macro(graph: ComputationalGraph) -> ComputationalGraph:
    """Collapse ``graph`` to process/host-level nodes and aggregate edges.

    Pure function: does not mutate ``graph`` or any of its nodes/edges.
    See the module docstring for the full aggregation contract (self-loop
    folding into ``function_count``/``total_call_count`` node attributes,
    and the "pid attribute" ownership-resolution convention).
    """
    owners = _resolve_owners(graph)

    process_nodes = {n.node_id: n for n in graph.nodes if n.node_type == "process"}
    host_nodes = {n.node_id: n for n in graph.nodes if n.node_type == "host"}

    function_count: dict[str, int] = dict.fromkeys(process_nodes, 0)
    total_call_count: dict[str, int] = dict.fromkeys(process_nodes, 0)
    for n in graph.nodes:
        if n.node_type in _MACRO_NODE_TYPES:
            continue
        owner_id = owners.get(n.node_id)
        if owner_id in function_count:
            function_count[owner_id] += 1

    edge_acc: dict[tuple[str, str, str], _EdgeAccumulator] = {}
    for e in graph.edges:
        source_owner = owners.get(e.source)
        target_owner = owners.get(e.target)
        if source_owner is None or target_owner is None:
            continue  # an endpoint was unattributable -- edge dropped, not guessed

        if source_owner in total_call_count:
            total_call_count[source_owner] += e.dynamic.count

        if source_owner == target_owner:
            continue  # intra-process/host self-loop: folded into node attrs above, not emitted

        key = (source_owner, target_owner, e.relation)
        acc = edge_acc.setdefault(key, _EdgeAccumulator())
        acc.count += e.dynamic.count
        acc.total_duration_ms += e.dynamic.total_duration_ms
        acc.event_refs.extend(e.dynamic.event_refs)

    new_process_nodes: list[Node] = [
        p.model_copy(
            update={
                "attributes": {
                    **p.attributes,
                    "function_count": function_count[node_id],
                    "total_call_count": total_call_count[node_id],
                }
            }
        )
        for node_id, p in process_nodes.items()
    ]
    new_host_nodes: list[Node] = [h.model_copy(deep=True) for h in host_nodes.values()]

    new_edges: list[Edge] = [
        Edge(
            edge_id=_stable_edge_id(source_id, target_id, relation),
            source=source_id,
            target=target_id,
            relation=relation,  # type: ignore[arg-type]  # relation is copied verbatim from a valid Edge
            dynamic=EdgeDynamics(
                count=acc.count,
                total_duration_ms=acc.total_duration_ms,
                avg_latency_ms=(acc.total_duration_ms / acc.count) if acc.count else 0.0,
                event_refs=list(acc.event_refs),
            ),
        )
        for (source_id, target_id, relation), acc in edge_acc.items()
    ]

    return ComputationalGraph(
        trace_id=graph.trace_id,
        nodes=[*new_process_nodes, *new_host_nodes],
        edges=new_edges,
    )


def project_meso(graph: ComputationalGraph) -> ComputationalGraph:
    """Function-level nodes/edges as-is -- the base resolution for v0.1.

    See the module docstring's "meso == base resolution" section: there is
    no meso-specific aggregation to perform in this MVP, since
    ``phosphor_graph.build.build_graph`` already builds at meso (function)
    granularity. Returns a defensive deep copy so a caller mutating the
    result can never mutate the graph that was passed in.
    """
    return graph.model_copy(deep=True)


def project(graph: ComputationalGraph, scale: Literal["macro", "meso"]) -> ComputationalGraph:
    """Dispatch to the requested scale projection.

    ``scale="micro"`` (source line / AST / bytecode level) is explicitly out
    of scope for this MVP (repository README's "Phase 0 / MVP v0.1" scope
    note; see also this module's docstring) and raises
    ``NotImplementedError`` rather than silently falling back to some other
    scale or returning an unprojected graph. Any other unrecognized value
    raises ``ValueError`` -- Python does not enforce the ``Literal`` type
    hint at runtime, so a real runtime check is needed to avoid silently
    doing the wrong thing for a bad ``scale`` argument.
    """
    if scale == "macro":
        return project_macro(graph)
    if scale == "meso":
        return project_meso(graph)
    if scale == "micro":
        raise NotImplementedError(
            "micro-scale projection (source line / AST / bytecode level) is "
            "explicitly out of scope for PHOSPHOR MCCP's Phase 0 / MVP v0.1 "
            "(see README); only 'macro' and 'meso' are implemented."
        )
    raise ValueError(f"unknown projection scale {scale!r}; expected 'macro' or 'meso'")


# ---------------------------------------------------------------------------
# Complexity Lens (whitepaper Sec.17)
# ---------------------------------------------------------------------------
#
# Everything below is pure aggregation over a ComputationalGraph's existing
# Node/Edge/EdgeDynamics data -- no new tracing, no estimation, no fields
# invented that aren't already computed by phosphor_graph.build. See the
# module docstring's "Complexity Lens" section for the top-level framing.


@dataclass
class NodeCost:
    """Time cost attributable to one node, derived only from the
    ``total_duration_ms`` of edges already touching it in the graph.

    ``outgoing_duration_ms`` / ``incoming_duration_ms`` split the total by
    edge direction because of what ``Edge.dynamic.total_duration_ms`` on a
    ``"calls"``/``"invokes"`` edge actually measures:
    ``phosphor_graph.build``'s ``accumulate_edge`` adds each contributing
    event's own ``duration_ms`` -- and that event is always the *target*
    side of the edge (the callee's ``function_call`` event, or the
    network/db event itself), never the caller's. So:

    - ``incoming_duration_ms`` -- summed ``total_duration_ms`` over edges
      where this node is the ``target`` -- is "time observed executing (or
      waiting on) this node, via calls that landed on it".
    - ``outgoing_duration_ms`` -- summed ``total_duration_ms`` over edges
      where this node is the ``source`` -- is "time observed inside the
      things this node called out to".

    ``total_duration_ms`` is their sum. A node that is both frequently
    called AND itself calls out will have its callees' time counted under
    ``outgoing_duration_ms`` and its own execution time (as seen by callers)
    counted under ``incoming_duration_ms`` -- these are two different real
    quantities, not a double-count of the same duration, and intentionally
    both surfaced rather than collapsed into one ambiguous number. Because
    of this, summing ``total_duration_ms`` across every ``NodeCost`` in a
    report does NOT equal the graph's overall total edge duration (a given
    edge's duration is counted once under its source's outgoing total and
    once under its target's incoming total) -- this is a node-centric view,
    not a partition of a fixed budget, and is documented here rather than
    silently surprising a caller who tries to cross-check the two.

    ``edge_count`` is the number of *distinct* edges touching this node as
    source and/or target (a self-loop edge, source==target, counts once).
    """

    node_id: str
    node_type: str
    label: str
    outgoing_duration_ms: float
    incoming_duration_ms: float
    total_duration_ms: float
    edge_count: int


@dataclass
class EdgeCost:
    """One edge's cost, flattened out of ``Edge``/``EdgeDynamics`` for
    ``ComplexityReport.top_edges`` -- carries ``edge_id``/``source``/
    ``target``/``relation`` so a caller can identify *which* edge this is
    (whitepaper Sec.17's "WHICH edge produced this cost") without having to
    re-look it up in the original graph.
    """

    edge_id: str
    source: str
    target: str
    relation: str
    total_duration_ms: float
    count: int
    avg_latency_ms: float


@dataclass
class RelationCost:
    """Aggregate cost across every edge of one ``EdgeRelation`` value (e.g.
    all ``"calls"`` edges vs. all ``"invokes"`` edges), showing where cost
    concentrates by relation type -- the breakdown requested independently
    of the per-node and per-edge views above.
    """

    relation: str
    edge_count: int
    call_count: int
    total_duration_ms: float
    avg_latency_ms: float


@dataclass
class ComplexityReport:
    """Output of ``complexity_lens`` -- see that function's docstring for
    the full aggregation contract. Module-local, not part of
    ``phosphor_trace.schema`` (see this module's docstring, "Complexity
    Lens" section, for why -- same precedent as
    ``phosphor_graph.build.GraphBuildStats``).

    ``node_costs`` covers every node in the graph (never truncated -- there
    is no requested cap on this list, only on ``top_edges`` below).
    ``top_edges`` is capped at ``top_k`` entries, descending by
    ``total_duration_ms``; per this project's "no silent caps" discipline
    (see ``phosphor_graph.build``'s own ``EdgeDynamics.event_refs`` comment
    for the precedent this follows), the cap itself is fine -- a top-K
    summary is the whole point -- but what got left out must never be
    silently dropped: ``omitted_edge_count`` and
    ``omitted_total_duration_ms`` say explicitly how many edges, and how
    much total duration, didn't make the top-K cut.
    """

    trace_id: str
    node_costs: list[NodeCost]
    top_edges: list[EdgeCost]
    top_k: int
    omitted_edge_count: int
    omitted_total_duration_ms: float
    relation_breakdown: list[RelationCost]
    total_edge_count: int
    total_duration_ms: float


@dataclass
class _NodeCostAccumulator:
    outgoing_duration_ms: float = 0.0
    incoming_duration_ms: float = 0.0
    edge_ids: set[str] = field(default_factory=set)


@dataclass
class _RelationCostAccumulator:
    edge_count: int = 0
    call_count: int = 0
    total_duration_ms: float = 0.0


def complexity_lens(graph: ComputationalGraph, top_k: int = 10) -> ComplexityReport:
    """Aggregate ``graph``'s existing edge dynamics into a ``ComplexityReport``
    -- whitepaper Sec.17's "not just a number, but WHICH edge produced this
    cost".

    Pure function: does not mutate ``graph`` or any of its nodes/edges, and
    performs no new tracing/estimation -- every number reported here is a
    sum, average, sort, or count over ``EdgeDynamics.total_duration_ms`` /
    ``.count`` / ``.avg_latency_ms`` values that ``phosphor_graph.build``
    (and, at macro scale, ``project_macro`` above) already computed from
    real observed events.

    ``top_k`` controls how many of the graph's most expensive edges (by
    ``total_duration_ms``, descending) are returned in full in
    ``ComplexityReport.top_edges``; the remainder are summarized, never
    silently dropped, via ``omitted_edge_count`` / ``omitted_total_duration_ms``
    (see ``ComplexityReport``'s docstring). Must be non-negative; ``0`` is a
    valid (if unusual) request for "no individual edges, summary/breakdown
    only" and returns every edge accounted for under ``omitted_*`` instead.

    Raises ``ValueError`` if ``top_k`` is negative -- there is no sensible
    "negative top-K" and silently clamping to 0 would hide a caller bug.
    """
    if top_k < 0:
        raise ValueError(f"top_k must be >= 0, got {top_k!r}")

    node_acc: dict[str, _NodeCostAccumulator] = {}
    relation_acc: dict[str, _RelationCostAccumulator] = {}

    for e in graph.edges:
        dur = e.dynamic.total_duration_ms

        src_acc = node_acc.setdefault(e.source, _NodeCostAccumulator())
        src_acc.outgoing_duration_ms += dur
        src_acc.edge_ids.add(e.edge_id)

        tgt_acc = node_acc.setdefault(e.target, _NodeCostAccumulator())
        tgt_acc.incoming_duration_ms += dur
        tgt_acc.edge_ids.add(e.edge_id)

        rel_acc = relation_acc.setdefault(e.relation, _RelationCostAccumulator())
        rel_acc.edge_count += 1
        rel_acc.call_count += e.dynamic.count
        rel_acc.total_duration_ms += dur

    node_costs: list[NodeCost] = []
    for n in graph.nodes:
        acc = node_acc.get(n.node_id)
        outgoing = acc.outgoing_duration_ms if acc else 0.0
        incoming = acc.incoming_duration_ms if acc else 0.0
        node_costs.append(
            NodeCost(
                node_id=n.node_id,
                node_type=n.node_type,
                label=n.label,
                outgoing_duration_ms=outgoing,
                incoming_duration_ms=incoming,
                total_duration_ms=outgoing + incoming,
                edge_count=len(acc.edge_ids) if acc else 0,
            )
        )
    node_costs.sort(key=lambda nc: nc.total_duration_ms, reverse=True)

    sorted_edges = sorted(graph.edges, key=lambda e: e.dynamic.total_duration_ms, reverse=True)
    top_edges = [
        EdgeCost(
            edge_id=e.edge_id,
            source=e.source,
            target=e.target,
            relation=e.relation,
            total_duration_ms=e.dynamic.total_duration_ms,
            count=e.dynamic.count,
            avg_latency_ms=e.dynamic.avg_latency_ms,
        )
        for e in sorted_edges[:top_k]
    ]
    omitted_edges = sorted_edges[top_k:]

    relation_breakdown = [
        RelationCost(
            relation=relation,
            edge_count=acc.edge_count,
            call_count=acc.call_count,
            total_duration_ms=acc.total_duration_ms,
            avg_latency_ms=(acc.total_duration_ms / acc.call_count) if acc.call_count else 0.0,
        )
        for relation, acc in relation_acc.items()
    ]
    relation_breakdown.sort(key=lambda rc: rc.total_duration_ms, reverse=True)

    return ComplexityReport(
        trace_id=graph.trace_id,
        node_costs=node_costs,
        top_edges=top_edges,
        top_k=top_k,
        omitted_edge_count=len(omitted_edges),
        omitted_total_duration_ms=sum(e.dynamic.total_duration_ms for e in omitted_edges),
        relation_breakdown=relation_breakdown,
        total_edge_count=len(graph.edges),
        total_duration_ms=sum(e.dynamic.total_duration_ms for e in graph.edges),
    )


# ---------------------------------------------------------------------------
# Bug Lens (whitepaper Sec.15.2)
# ---------------------------------------------------------------------------
#
# See the module docstring's "Bug Lens" section for the top-level framing,
# including exactly which whitepaper-listed bug categories this function can
# and cannot honestly support with the current data model.

_TRAFFIC_STDEV_MULTIPLIER = 2.0
_TRAFFIC_MIN_EDGES_FOR_STATS = 3
_TRAFFIC_ABSOLUTE_COUNT_FLOOR = 10

# Mirrors phosphor_graph.build's private _UNKNOWN_FUNCTION sentinel as a
# literal, not an import: cheap to duplicate (a single constant string, not
# stateful logic like nearest_function_ancestor), so this module keeps its
# existing convention (see _stable_edge_id's docstring above) of not
# reaching into another module's private helpers for something this small.
# Used only so an ancestor event with no captured function name (function
# is None -- theoretical for real function_call events, since
# phosphor_trace.normalize's _parse_viztracer_name always returns a real
# name string, never None, but SourceLocation.function is typed Optional)
# looks up under the exact same node label build_graph itself would have
# used, rather than failing to match a real node by a None-vs-sentinel
# mismatch.
_UNKNOWN_FUNCTION = "<unknown-function>"


@dataclass
class ErrorFinding:
    """One captured ``type="error"`` ``TraceEvent``, linked to the graph.

    ``exception_type``/``exception_message`` come straight from the event's
    ``resource`` dict (``phosphor_trace.normalize`` always populates these
    for a real error -- see that module's docstring); ``None`` only if the
    event genuinely carries no such attribute (defensive, not expected on
    real captured data from this project's own collector).

    ``caller_node_id``/``caller_label`` identify the function node that, via
    the shared ``phosphor_graph.build.nearest_function_ancestor`` walk
    (``skip_noise=True`` -- the same semantics ``build_graph`` itself uses to
    resolve the caller of a ``db_query``/``network_request`` "invokes" edge,
    reused here rather than re-implemented), most immediately called into
    the failure. This is commonly ``None`` for a whole-script
    uncaught-exception event (``source_file == "<error>"``): by the time
    ``_otel_bootstrap.py`` emits that span, the function_call frame that
    raised the exception has typically already closed (its viztracer ``"X"``
    event covers exactly "entry to however it exited"), so interval-nesting
    reconstruction (``phosphor_trace.normalize._reconstruct_call_stacks``)
    often has no still-open frame left to attach the error span to. A failed
    ``db_query``/``network_request`` error, by contrast, is emitted from
    inside the still-executing call that failed, so it resolves to a real
    caller far more often -- a real, observed asymmetry, not a bug in this
    lens.
    """

    event_id: str
    timestamp: float
    source_file: str  # "<error>" | "<database>" | "<network>" -- see normalize.py
    exception_type: str | None
    exception_message: str | None
    caller_node_id: str | None
    caller_label: str | None
    evidence_refs: list[str]


@dataclass
class TrafficHotspot:
    """One edge whose ``EdgeDynamics.count`` is flagged as unusually high
    relative to the rest of ``graph.edges`` -- see ``bug_lens``'s docstring
    for the exact threshold rule this was measured against. A HEURISTIC,
    labeled as such: a high call count from one node to another is
    consistent with an N+1-style traffic-explosion pattern, not proof of
    one -- legitimately busy, correctly-designed code can produce the same
    shape of signal, so this is a lead for a human/agent to investigate, not
    a verdict.
    """

    edge_id: str
    source_node_id: str
    target_node_id: str
    relation: str
    count: int
    mean_count: float
    stdev_count: float
    threshold: float
    event_refs: list[str]


@dataclass
class BugReport:
    """Output of ``bug_lens`` -- see that function's docstring for the full
    detection contract, and the module docstring's "Bug Lens" section for
    which whitepaper-listed categories this can and cannot honestly support.
    Module-local, not part of ``phosphor_trace.schema`` -- same precedent as
    ``ComplexityReport``/``GraphBuildStats`` (derived reporting, not a core
    shared type).

    ``errors`` covers every ``type="error"`` event found (never truncated).
    ``traffic_hotspots`` covers every edge that cleared the statistical
    threshold (also never truncated -- unlike ``ComplexityReport.top_edges``,
    there is no "top-K" request here to honor a cap against).
    """

    trace_id: str
    errors: list[ErrorFinding] = field(default_factory=list)
    traffic_hotspots: list[TrafficHotspot] = field(default_factory=list)


def _traffic_count_threshold(counts: list[int]) -> tuple[float, float, float]:
    """Return ``(threshold, mean, stdev)`` for flagging "unusually high" edge
    counts among ``counts`` -- one ``EdgeDynamics.count`` per edge in
    whatever population ``bug_lens`` passes in (see that function's
    docstring: it calls this once per distinct ``EdgeRelation``, never once
    over the whole graph -- see the "why per-relation" note there for the
    real-data reason).

    Exact rule (stated plainly, since this is a heuristic, not a certainty):
    population mean and population standard deviation are computed over
    every edge's ``count`` in ``counts``. If there are at least
    ``_TRAFFIC_MIN_EDGES_FOR_STATS`` (3) edges AND the resulting stdev is
    nonzero (i.e. there is real variation to measure), the threshold is
    ``mean + _TRAFFIC_STDEV_MULTIPLIER (2.0) * stdev`` -- "more than 2
    standard deviations above the mean edge count". Otherwise (too few edges
    for the statistic to mean anything, e.g. a 1- or 2-edge population, or
    every edge sharing the exact same count so stdev is 0 and no edge could
    ever exceed a mean-only threshold), the rule falls back to an absolute
    floor, ``_TRAFFIC_ABSOLUTE_COUNT_FLOOR`` (10): any edge with ``count >
    10`` is flagged regardless of how it compares to its (statistically
    meaningless, in this branch) peers. Both constants are deliberately
    conservative, module-level constants rather than tunable parameters --
    there is no principled "correct" value here, just a documented,
    inspectable choice.
    """
    mean = statistics.fmean(counts)
    if len(counts) >= _TRAFFIC_MIN_EDGES_FOR_STATS:
        stdev = statistics.pstdev(counts)
        if stdev > 0:
            return mean + _TRAFFIC_STDEV_MULTIPLIER * stdev, mean, stdev
    return float(_TRAFFIC_ABSOLUTE_COUNT_FLOOR), mean, 0.0


def bug_lens(graph: ComputationalGraph, events: list[TraceEvent]) -> BugReport:
    """Surface error and traffic-explosion signal already present in a
    captured trace -- see the module docstring's "Bug Lens" section for
    which whitepaper Sec.15.2 categories this does and does not cover, and
    why.

    Requires both ``graph`` (for edge/node structure -- traffic-hotspot
    detection operates purely over ``graph.edges``) and the raw ``events``
    list (``type="error"`` events and their ``resource`` detail are not
    represented on the graph at all -- ``phosphor_graph.build.build_graph``
    deliberately does not fold them into any node/edge). Pure function: does
    not mutate either argument.

    Error detection: every event with ``event.type == "error"`` becomes one
    ``ErrorFinding``, sorted by ``timestamp`` ascending (chronological order
    of real occurrence). Each is linked to its nearest resolvable calling
    function via ``phosphor_graph.build.nearest_function_ancestor`` -- the
    exact same shared, memoized ancestor-walk implementation ``build_graph``
    itself uses for ``db_query``/``network_request`` "invokes" edges (see
    that function's docstring for why it is public rather than duplicated
    here), called with ``skip_noise=True`` for the same reason: an
    instrumentation-internal frame (OTel SDK internals, this project's own
    ``_otel_bootstrap.py`` wrapper functions) is never a meaningful "caller"
    of a failure. The resolved ancestor's ``(file, function)`` is then looked
    up against the graph's own function nodes (matching
    ``phosphor_graph.build``'s ``(source.file, source.function)`` node-
    identity key) so the returned ``caller_node_id`` is guaranteed to be a
    real ``node_id`` already present in ``graph`` if it is not ``None``.

    Traffic-explosion detection: computed purely from ``graph.edges`` (empty
    graph -> empty ``traffic_hotspots``, never a crash on the degenerate
    case). ``graph.edges`` is first split by ``relation`` (``"calls"`` vs.
    ``"invokes"`` vs. any other ``EdgeRelation`` present), and
    ``_traffic_count_threshold`` is applied **independently within each
    relation group**, not once over the whole graph -- a deliberate,
    real-evidence-driven scoping decision, not the naive "one global
    threshold" reading of "the graph's typical edge count": on a real
    captured trace of ``demo_targets/io_bound.py`` (verified while building
    this function), ``"calls"`` edges are overwhelmingly dominated by fixed,
    expected Python interpreter import-machinery overhead (thousands of
    calls along edges with nothing to do with the traced script's own
    logic -- the same population ``phosphor_graph.build``'s own
    explosion-prevention tests already document as large but bounded), while
    the genuinely interesting ``"invokes"`` edges (the real N+1
    network/db-call pattern the whitepaper's example is actually about) are
    only ever a handful. Computing one shared mean/stdev across both
    populations let the import-machinery noise's own huge scale swallow the
    real signal entirely (empirically confirmed: with a single global
    threshold, the real fetch-per-user "invokes" edge never cleared it, no
    matter how much of an outlier it was among its own kind). Splitting by
    relation compares each edge only against edges of the same kind, which
    is both the statistically honest thing to do (different relations are
    not the same population) and the one that actually surfaces the
    whitepaper's traffic-explosion signal on real data. Note this means an
    unusually-high-count ``"calls"`` edge CAN still be reported -- that is
    real, observed data, not suppressed -- but it will commonly reflect
    ordinary import-machinery cost rather than an application-level bug; a
    caller specifically hunting for external-call (N+1 query/HTTP) explosion
    should filter ``traffic_hotspots`` to ``relation == "invokes"``. Within
    each group, every edge whose ``count`` strictly exceeds that group's
    computed threshold is reported; the combined list across all groups is
    sorted by ``count`` descending (most extreme first).
    """
    index: dict[str, TraceEvent] = {e.event_id: e for e in events}
    ancestor_memo: dict[str, TraceEvent | None] = {}
    function_lookup: dict[tuple[str, str], Node] = {
        (str(n.attributes.get("file", "")), n.label): n for n in graph.nodes if n.node_type == "function"
    }

    errors: list[ErrorFinding] = []
    for event in events:
        if event.type != "error":
            continue
        resource = event.resource or {}

        ancestor = nearest_function_ancestor(event, index, ancestor_memo, skip_noise=True)
        caller_node = None
        if ancestor is not None:
            ancestor_func = ancestor.source.function or _UNKNOWN_FUNCTION
            caller_node = function_lookup.get((ancestor.source.file, ancestor_func))

        errors.append(
            ErrorFinding(
                event_id=event.event_id,
                timestamp=event.timestamp,
                source_file=event.source.file,
                exception_type=resource.get("exception.type"),
                exception_message=resource.get("exception.message"),
                caller_node_id=caller_node.node_id if caller_node is not None else None,
                caller_label=caller_node.label if caller_node is not None else None,
                evidence_refs=[event.event_id],
            )
        )
    errors.sort(key=lambda f: f.timestamp)

    traffic_hotspots: list[TrafficHotspot] = []
    edges_by_relation: dict[str, list[Edge]] = {}
    for e in graph.edges:
        edges_by_relation.setdefault(e.relation, []).append(e)

    for relation_edges in edges_by_relation.values():
        counts = [e.dynamic.count for e in relation_edges]
        threshold, mean, stdev = _traffic_count_threshold(counts)
        for e in relation_edges:
            if e.dynamic.count > threshold:
                traffic_hotspots.append(
                    TrafficHotspot(
                        edge_id=e.edge_id,
                        source_node_id=e.source,
                        target_node_id=e.target,
                        relation=e.relation,
                        count=e.dynamic.count,
                        mean_count=mean,
                        stdev_count=stdev,
                        threshold=threshold,
                        event_refs=list(e.dynamic.event_refs),
                    )
                )
    traffic_hotspots.sort(key=lambda h: h.count, reverse=True)

    return BugReport(trace_id=graph.trace_id, errors=errors, traffic_hotspots=traffic_hotspots)

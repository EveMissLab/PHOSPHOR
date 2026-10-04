"""phosphor_graph.build -- fold a flat ``TraceEvent`` list into a
``ComputationalGraph`` (see ``phosphor_trace.schema`` for the canonical
``Node`` / ``Edge`` / ``EdgeDynamics`` / ``ComputationalGraph`` model,
imported here, never redefined).

The whole point of this module: a function called 10,000 times in a loop
must produce exactly ONE ``Node`` and exactly ONE ``Edge`` (with
``EdgeDynamics.count == 10000``), never one node/edge per call. Node
identity is **static** -- keyed by durable properties of the underlying
code/infrastructure, never by call instance:

- function node  -> keyed by ``(source.file, source.function)``
- host node      -> keyed by the network request's resolved host string
- process node   -> keyed by ``runtime.pid``
- database node  -> keyed by the db_query event's resolved db path string
  (``resource["db.name"]`` -- see ``_extract_db_path``)

Node/edge id derivation (stable across runs of the same script -- this is
the contract downstream ``phosphor_projector`` / ``phosphor_explain``
agents rely on for graph lookup/traversal)
--------------------------------------------------------------------------
``node_id`` and ``edge_id`` are ``"{prefix}_{16 hex chars}"``, where the hex
suffix is ``sha256("\\x1e".join(key_parts)).hexdigest()[:16]`` (the
``\\x1e`` "record separator" byte joins the parts so that, e.g., a file
named ``"a\\x1eb"`` can't collide with function ``"b"`` -- no ordinary
source path or function name contains it):

- function node: ``prefix="fn"``,   key parts = ``(file, function)``
- host node:     ``prefix="host"``, key parts = ``(host,)``
- process node:  ``prefix="proc"``, key parts = ``(str(pid),)``
- database node: ``prefix="db"``,   key parts = ``(db_path,)``
- edge:          ``prefix="edge"``, key parts = ``(source_node_id, target_node_id, relation)``

Given the same underlying (file, function) / host / pid / edge triple, the
id is byte-for-byte identical on every run -- this is a plain deterministic
hash, not randomness, not a database autoincrement.

Edge aggregation
-----------------
Exactly one ``Edge`` is produced per distinct ``(source_node_id,
target_node_id, relation)`` triple, no matter how many contributing events
there are. Each contributing event increments ``EdgeDynamics.count``,
its ``duration_ms`` (treated as ``0.0`` if the event carries none -- e.g. an
OTel span whose start/end was never recorded, see
``phosphor_trace.normalize``) is added to ``total_duration_ms``, and
``avg_latency_ms`` is recomputed as ``total_duration_ms / count``. Every
contributing event's ``event_id`` is appended to ``event_refs``.

``event_refs`` is never capped/truncated. ``EdgeDynamics`` (the canonical
schema, not redefined here) has no field to record "this list was
truncated" -- adding one would mean redefining the canonical schema, which
this module must not do. Given that constraint, the only way to honor "if
you cap it you must say so, never silently drop references" is to not cap
it at all. If a future caller needs a bound for memory reasons, that
requires a schema change upstream (a ``truncated: bool`` field on
``EdgeDynamics``), not a silent cap here.

Caller/callee and function/host/database linkage: parent_event only
-----------------------------------------------------------------------
Edges are derived *exclusively* from real ``parent_event`` pointers --
never from timestamp/duration containment heuristics, and never invented.
This matters because ``Edge`` (the canonical schema) carries no evidence
field of its own the way ``TraceEvent`` does: there is no way to mark an
edge as "inferred" rather than "observed", so this module only ever builds
edges from linkage that was actually recorded, in keeping with the
project's Hallucination Control stance (whitepaper Sec.24, see
``phosphor_trace/schema.py``'s module docstring).

For a given event, "caller" is the *nearest ancestor* found by walking
``parent_event`` pointers (through however many hops, including through
other network_request events) until either a ``function_call`` event is
reached (-> resolved) or the chain runs out / hits a dangling
(out-of-trace) reference / hits a cycle (-> unresolved). Unresolved events
are skipped for edge-building -- never given a fake parent -- and counted
in ``GraphBuildStats`` (see ``get_last_build_stats()``), which is also
logged.

``phosphor_trace.normalize`` now populates ``parent_event`` for every event
type (see that module's ``_reconstruct_call_stacks``: OTel-reported
``parent_span_id`` chaining where available, otherwise interval nesting from
real ``timestamp``/``duration_ms`` values, scoped to one (pid, tid) and never
guessed across threads) -- this module required no changes to start
producing real ``"calls"``/``"invokes"`` edges once that linkage exists; it
was already walking ``parent_event`` correctly, it simply had nothing to
walk before. Node explosion-prevention was, and remains, proven independent
of this (see ``tests/test_graph.py``).

``memory_sample`` events: process-node attributes, not a new node/edge type
--------------------------------------------------------------------------------
``phosphor_trace.normalize`` emits one ``type="memory_sample"`` event per
real ``psutil`` reading the background sampler thread took (see that
module's ``_normalize_memory_samples``), each carrying real
``resource["memory.rss_bytes"]``/``["memory.vms_bytes"]`` values and NO
``parent_event`` (a memory sample is a background, asynchronous measurement,
never "called by" anything on the traced script's stack -- see that
function's docstring). This module deliberately does NOT create a node or
edge for these events: there is no "which function caused this measurement"
causal link the way there genuinely is for a ``db_query``/``network_request``
event's resolvable calling function, so forcing memory samples into the
node/edge model would misrepresent an unlinked background measurement as a
causal graph fact -- exactly the same Hallucination Control reasoning
(whitepaper Sec.24) already governing every other edge in this module (see
"Caller/callee and function/host/database linkage" above).

Instead, real sampled ``rss_bytes`` values are aggregated per
``runtime.pid`` and surfaced as ``peak_rss_mb``/``mean_rss_mb`` attributes on
that pid's own ``process_node`` -- the same node/attributes dict every other
event already contributes to via ``process_node(event.runtime.pid)``, and
that ``phosphor_projector.project_macro`` already carries through unchanged
(it copies/extends ``p.attributes`` without needing to know these two keys
exist). Both values are computed only from real observed byte counts,
converted from bytes to MB (``/ (1024 * 1024)``), rounded to 2 decimal
places -- an arbitrary-but-documented display precision, not a claim of
that level of measurement accuracy -- and stored ``str``-coerced (``Node.
attributes``, the canonical schema, is typed ``dict[str, str | int]``; there
is no float member, and this module must not redefine that schema). If a
traced process produced zero real
memory samples (e.g. it finished before the sampler thread was ever
scheduled -- an accepted, valid outcome, see
``_otel_bootstrap.py``'s ``_sample_memory_loop``), its process node simply
carries no ``peak_rss_mb``/``mean_rss_mb`` attributes at all: a measurement
that was never taken is never faked as ``0`` or ``null``. A new
``GraphBuildStats.memory_sample_events`` counter reports the real count of
these events out-of-band, following the exact same precedent as
``db_query_events``/``network_request_events``.
"""

from __future__ import annotations

import hashlib
import logging
from collections import defaultdict
from dataclasses import dataclass, field
from urllib.parse import urlparse

from phosphor_trace.schema import (
    ComputationalGraph,
    Edge,
    EdgeDynamics,
    Node,
)

try:  # only imported for type checking; avoids a hard runtime dependency cycle
    from phosphor_trace.schema import TraceEvent
except ImportError:  # pragma: no cover
    TraceEvent = object  # type: ignore[assignment,misc]

logger = logging.getLogger(__name__)

_UNKNOWN_FUNCTION = "<unknown-function>"
_UNKNOWN_HOST = "<unknown-host>"
_UNKNOWN_DB = "<unknown-database>"
_RECORD_SEP = "\x1e"

# Real byte->MB conversion for memory_sample aggregation (see module
# docstring's "memory_sample events" section). A plain unit conversion, not
# a tunable/heuristic constant like the traffic-hotspot thresholds
# elsewhere in this project.
_BYTES_PER_MB = 1024 * 1024
_RSS_MB_ROUNDING_DIGITS = 2


def _stable_id(prefix: str, *parts: str) -> str:
    """Deterministic node/edge id: same (prefix, parts) -> same id, always."""
    key = _RECORD_SEP.join(parts)
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:16]
    return f"{prefix}_{digest}"


def _extract_host(event: TraceEvent) -> str:
    """Best-effort host string for a network_request event's target.

    Tries, in order: modern OTel semconv (``server.address``[``:server.port``]
    / ``net.peer.name``[``:net.peer.port``]), the older ``http.host``, then
    parsing ``http.url``/``url.full`` -- this is what
    ``phosphor_trace.normalize``'s requests-instrumentation path actually
    emits today (confirmed against a live local-server capture: attributes
    ``http.method``/``http.url``/``http.status_code``/``user_agent.original``,
    no ``net.peer.*``/``server.*`` keys). Falls back to the span's own name
    (e.g. ``"GET"``) and finally to a sentinel -- never raises.
    """
    resource = event.resource or {}

    host = resource.get("server.address") or resource.get("net.peer.name") or resource.get("http.host")
    if host:
        port = resource.get("server.port") or resource.get("net.peer.port")
        return f"{host}:{port}" if port else host

    url = resource.get("http.url") or resource.get("url.full")
    if url:
        parsed = urlparse(url)
        if parsed.hostname:
            return f"{parsed.hostname}:{parsed.port}" if parsed.port else parsed.hostname

    return event.source.function or _UNKNOWN_HOST


def _extract_db_path(event: TraceEvent) -> str:
    """Best-effort db identity string for a db_query event's target.

    ``phosphor_trace.normalize`` carries the db file path through under
    ``resource["db.name"]`` -- the same attribute name
    ``_otel_bootstrap.py``'s ``_instrument_sqlite3`` sets on every span it
    emits (confirmed against a real captured trace of
    ``demo_targets/db_bound.py``: every db_query event's resource dict has a
    real ``db.name`` key holding the temp db file's absolute path). Falls
    back to a sentinel -- never raises -- for the theoretical case of a
    db_query event whose resource is missing or lacks that key.
    """
    resource = event.resource or {}
    return resource.get("db.name") or _UNKNOWN_DB


@dataclass
class _EdgeAccumulator:
    count: int = 0
    total_duration_ms: float = 0.0
    event_refs: list[str] = field(default_factory=list)


@dataclass
class GraphBuildStats:
    """Reporting for the last ``build_graph`` call (see ``get_last_build_stats``).

    Exists because ``ComputationalGraph``/``Edge``/``EdgeDynamics`` (the
    canonical schema) have no field to carry this kind of build-time
    metadata, and this module must not redefine that schema -- so unresolved
    counts are reported out-of-band instead of silently dropped.
    """

    total_events: int = 0
    function_call_events: int = 0
    network_request_events: int = 0
    db_query_events: int = 0
    memory_sample_events: int = 0
    other_event_types: int = 0
    calls_edge_events: int = 0
    calls_unresolved_events: int = 0
    invokes_edge_events: int = 0
    invokes_unresolved_events: int = 0
    db_invokes_edge_events: int = 0
    db_invokes_unresolved_events: int = 0
    node_count: int = 0
    edge_count: int = 0


_last_build_stats: GraphBuildStats | None = None


def get_last_build_stats() -> GraphBuildStats | None:
    """Stats from the most recent ``build_graph`` call in this process (or None)."""
    return _last_build_stats


_BUILTIN_SOURCE_FILE = "<builtin>"


def _is_instrumentation_noise(event: TraceEvent) -> bool:
    """True for a ``function_call`` event that can never be a meaningful
    "caller" of a ``network_request``/``db_query`` event -- only ever
    tracing-library bookkeeping around creating the very telemetry event
    being linked, never a real business-logic frame from the traced script.

    Diagnosed from real captured data, not guessed: on a real trace of
    ``demo_targets/io_bound.py``, every single ``network_request`` event's
    interval-nesting ancestor chain runs, 100% of the time, through a fixed
    tower of OTel-SDK-internal frames before ever reaching the demo script's
    own calling function -- e.g. ``time.time_ns`` -> ``Span.start`` ->
    ``Tracer.start_span`` -> ``Tracer.start_as_current_span`` ->
    ``builtins.next`` -> ``_AgnosticContextManager.__enter__``. This is
    structural, not incidental: a span's own timestamp is produced by a
    ``time.time_ns()`` call that viztracer ALSO traces as its own
    ``function_call`` event, so that call's ``[start, end]`` interval always
    contains (or nearly contains) the very instant used to place the
    network_request/db_query event -- making the SDK's own internals look
    like the "nearest" ancestor by pure interval geometry, never a
    meaningful caller. The same tower appears for this project's own
    ``db_query`` spans (``_otel_bootstrap.py``'s ``_instrument_sqlite3``
    uses the identical ``tracer.start_as_current_span`` API), confirmed
    against a real trace of ``demo_targets/db_bound.py``.

    Three structural markers catch every case observed so far: any frame
    whose ``source.file`` contains ``"opentelemetry"`` (the SDK's own
    installed package path -- never the traced target script, which never
    lives under a ``site-packages/opentelemetry/`` path); any ``"<builtin>"``
    frame (bare C-implemented calls -- ``time.time_ns``, ``builtins.next`` --
    structurally incapable of themselves invoking an instrumented network/db
    call in any of this project's demo scripts); and any frame whose
    ``source.file`` is ``_otel_bootstrap.py`` itself -- this project's own
    ``_instrument_sqlite3`` span-emitting wrapper functions (``_traced_call``,
    ``_TracedCursor.execute``/``executemany``, ``_TracedConnection.execute``/
    ``executemany``) are real Python functions that DO get their own
    function_call events, and would otherwise resolve as "the caller" of
    every db_query event instead of walking one step further to the traced
    script's actual calling function (confirmed on a real
    ``demo_targets/db_bound.py`` trace: without this marker, every db_query
    event's nearest non-SDK ancestor is ``_traced_call``, not ``fetch_user``/
    ``create_schema``/etc.). This third marker has no analogue on the
    network_request side because requests/urllib3 instrumentation is entirely
    third-party (already caught by the ``"opentelemetry"`` marker) -- this
    project has no wrapper code of its own in that path.
    """
    file = event.source.file
    return file == _BUILTIN_SOURCE_FILE or "opentelemetry" in file or file.endswith("_otel_bootstrap.py")


def nearest_function_ancestor(
    event: TraceEvent,
    index: dict[str, TraceEvent],
    memo: dict[str, TraceEvent | None],
    *,
    skip_noise: bool = False,
) -> TraceEvent | None:
    """Nearest ancestor of ``event`` (via ``parent_event`` pointers) that is a
    ``function_call`` event, or ``None`` if unresolvable.

    Public (no leading underscore) precisely so other modules can reuse this
    exact walk rather than re-implementing a second, potentially-divergent
    version of it -- unlike this module's other private helpers (e.g.
    ``_stable_id``), which are cheap enough that ``phosphor_projector.project``
    deliberately reimplements its own local equivalent rather than reaching
    into this module's internals (see that module's ``_stable_edge_id``
    docstring), this walk is genuinely stateful/nontrivial (iterative,
    memoized, cycle- and dangling-reference-safe, with the ``skip_noise``
    instrumentation-skipping variant below) -- exactly the kind of logic that
    must have one canonical implementation. ``phosphor_projector.project``'s
    ``bug_lens`` calls this directly to resolve which function "owns" a
    captured ``type="error"`` event, using the same ``skip_noise=True``
    semantics as the ``db_query``/``network_request`` "invokes" edges below.

    Walks iteratively (no recursion -- real traces can chain thousands of
    events deep) and memoizes every id visited on the walk to the same
    final result, since everything on one ancestor chain shares the same
    nearest function_call ancestor. Dangling references (parent_event
    pointing at an id not in this trace) and cycles both resolve to
    ``None`` -- never fabricated.

    ``skip_noise=True`` (used only for ``network_request``/``db_query``
    "invokes" edge derivation, never for ``function_call`` "calls" edge
    derivation -- see ``_is_instrumentation_noise``) additionally keeps
    walking past a ``function_call`` ancestor that is itself instrumentation
    bookkeeping rather than stopping there, so the resolved caller is the
    traced script's own function, not an OTel SDK internal. Callers passing
    different ``skip_noise`` values for the same event id MUST pass separate
    ``memo`` dicts (``build_graph`` does this) -- a single memo cannot
    correctly serve both walk semantics at once.
    """
    path: list[str] = []
    seen: set[str] = set()
    result: TraceEvent | None = None

    current_id = event.parent_event
    while current_id is not None:
        if current_id in memo:
            result = memo[current_id]
            break
        if current_id in seen:
            result = None  # cycle in parent_event chain -- malformed data, bail safely
            break
        seen.add(current_id)
        path.append(current_id)

        current = index.get(current_id)
        if current is None:
            result = None  # dangling reference: parent not captured in this trace
            break
        if current.type == "function_call" and not (skip_noise and _is_instrumentation_noise(current)):
            result = current
            break
        current_id = current.parent_event
    else:
        result = None

    for visited_id in path:
        memo[visited_id] = result
    return result


def build_graph(events: list[TraceEvent], trace_id: str) -> ComputationalGraph:
    """Fold ``events`` into a ``ComputationalGraph`` with static node identity.

    See the module docstring for the id-derivation scheme, the aggregation
    rule, and the current real-data limitation on edge production (parent_event
    is not yet populated for function_call events by phosphor_trace.normalize).
    """
    index: dict[str, TraceEvent] = {e.event_id: e for e in events}

    function_nodes: dict[str, Node] = {}
    host_nodes: dict[str, Node] = {}
    process_nodes: dict[str, Node] = {}
    database_nodes: dict[str, Node] = {}
    edge_acc: dict[tuple[str, str, str], _EdgeAccumulator] = {}
    ancestor_memo: dict[str, TraceEvent | None] = {}
    # Separate memo for the noise-skipping walk used by "invokes" (network/db)
    # edge derivation below -- see _nearest_function_ancestor's docstring on
    # why the two walk semantics (skip_noise=False for "calls" edges vs.
    # skip_noise=True here) must never share one memo.
    invokes_ancestor_memo: dict[str, TraceEvent | None] = {}

    stats = GraphBuildStats()

    # Real sampled rss_bytes values, grouped by the pid they were measured
    # on -- accumulated during pass 1 below, then folded into each pid's own
    # process_node's attributes afterward (see module docstring's
    # "memory_sample events" section for why this is a node attribute, never
    # a node/edge of its own).
    rss_bytes_by_pid: dict[int, list[int]] = defaultdict(list)

    def function_node(file: str, function: str | None) -> Node:
        func = function or _UNKNOWN_FUNCTION
        node_id = _stable_id("fn", file, func)
        node = function_nodes.get(node_id)
        if node is None:
            node = Node(node_id=node_id, node_type="function", label=func, attributes={"file": file})
            function_nodes[node_id] = node
        return node

    def host_node(host: str) -> Node:
        node_id = _stable_id("host", host)
        node = host_nodes.get(node_id)
        if node is None:
            node = Node(node_id=node_id, node_type="host", label=host, attributes={})
            host_nodes[node_id] = node
        return node

    def process_node(pid: int) -> Node:
        node_id = _stable_id("proc", str(pid))
        node = process_nodes.get(node_id)
        if node is None:
            node = Node(node_id=node_id, node_type="process", label=f"pid {pid}", attributes={"pid": pid})
            process_nodes[node_id] = node
        return node

    def database_node(db_path: str) -> Node:
        node_id = _stable_id("db", db_path)
        node = database_nodes.get(node_id)
        if node is None:
            node = Node(node_id=node_id, node_type="database", label=db_path, attributes={})
            database_nodes[node_id] = node
        return node

    def accumulate_edge(source_id: str, target_id: str, relation: str, event: TraceEvent) -> None:
        key = (source_id, target_id, relation)
        acc = edge_acc.get(key)
        if acc is None:
            acc = _EdgeAccumulator()
            edge_acc[key] = acc
        acc.count += 1
        acc.total_duration_ms += event.duration_ms if event.duration_ms is not None else 0.0
        acc.event_refs.append(event.event_id)

    # --- pass 1: nodes (every event contributes at least a process node) ---
    for event in events:
        stats.total_events += 1
        process_node(event.runtime.pid)

        if event.type == "function_call":
            stats.function_call_events += 1
            function_node(event.source.file, event.source.function)
        elif event.type == "network_request":
            stats.network_request_events += 1
            host_node(_extract_host(event))
        elif event.type == "db_query":
            stats.db_query_events += 1
            database_node(_extract_db_path(event))
        elif event.type == "memory_sample":
            stats.memory_sample_events += 1
            resource = event.resource or {}
            rss_raw = resource.get("memory.rss_bytes")
            if rss_raw is not None:
                rss_bytes_by_pid[event.runtime.pid].append(int(rss_raw))
        else:
            stats.other_event_types += 1

    # --- fold real sampled rss_bytes into their owning process node's
    # attributes (peak_rss_mb / mean_rss_mb) -- see module docstring's
    # "memory_sample events" section. A pid with zero real samples simply
    # gets no attributes here at all (never a fabricated 0/null). ---
    for pid, rss_values in rss_bytes_by_pid.items():
        node = process_node(pid)
        # str-coerced, not a raw float: Node.attributes (the canonical schema)
        # is typed dict[str, str | int] -- there is no float member, and this
        # module must not redefine that schema (see this file's module
        # docstring; the one schema change this project's discipline permits
        # is the EventType Literal addition, not this). Mutating the dict
        # in-place bypasses pydantic's assignment validation, so a raw float
        # would not raise here -- but it would silently violate the declared
        # type contract for every downstream reader. str(round(...)) keeps
        # the same "coerce to str" discipline phosphor_trace.normalize
        # already applies to every resource dict value.
        node.attributes["peak_rss_mb"] = str(round(max(rss_values) / _BYTES_PER_MB, _RSS_MB_ROUNDING_DIGITS))
        node.attributes["mean_rss_mb"] = str(
            round((sum(rss_values) / len(rss_values)) / _BYTES_PER_MB, _RSS_MB_ROUNDING_DIGITS)
        )

    # --- pass 2: edges, aggregated per (source, target, relation) ---
    for event in events:
        if event.type == "function_call":
            ancestor = nearest_function_ancestor(event, index, ancestor_memo)
            if ancestor is None:
                stats.calls_unresolved_events += 1
                continue
            caller = function_node(ancestor.source.file, ancestor.source.function)
            callee = function_node(event.source.file, event.source.function)
            accumulate_edge(caller.node_id, callee.node_id, "calls", event)
            stats.calls_edge_events += 1

        elif event.type == "network_request":
            # skip_noise=True: walk past OTel-SDK-internal frames
            # (time.time_ns, Span.start, ...) that would otherwise look like
            # the "nearest" function_call ancestor by pure interval geometry
            # -- see _is_instrumentation_noise's docstring for the real,
            # evidence-based diagnosis. Uses its own memo (invokes_ancestor_
            # memo), never ancestor_memo -- the two walks have different
            # semantics and must not share memoized results.
            ancestor = nearest_function_ancestor(event, index, invokes_ancestor_memo, skip_noise=True)
            if ancestor is None:
                stats.invokes_unresolved_events += 1
                continue
            caller = function_node(ancestor.source.file, ancestor.source.function)
            target = host_node(_extract_host(event))
            accumulate_edge(caller.node_id, target.node_id, "invokes", event)
            stats.invokes_edge_events += 1

        elif event.type == "db_query":
            # Same nearest-function-call-ancestor walk as network_request
            # above (including skip_noise=True and the same
            # invokes_ancestor_memo) -- deliberately not a separate/parallel
            # code path (see module docstring). Reuses the existing
            # "invokes" relation: "calling function invokes database" is
            # exactly the same shape of fact as "calling function invokes
            # host", and EdgeRelation (the canonical schema) has no
            # dedicated database-specific relation to reach for instead.
            ancestor = nearest_function_ancestor(event, index, invokes_ancestor_memo, skip_noise=True)
            if ancestor is None:
                stats.db_invokes_unresolved_events += 1
                continue
            caller = function_node(ancestor.source.file, ancestor.source.function)
            target = database_node(_extract_db_path(event))
            accumulate_edge(caller.node_id, target.node_id, "invokes", event)
            stats.db_invokes_edge_events += 1

    edges: list[Edge] = []
    for (source_id, target_id, relation), acc in edge_acc.items():
        avg_latency_ms = acc.total_duration_ms / acc.count if acc.count else 0.0
        edges.append(
            Edge(
                edge_id=_stable_id("edge", source_id, target_id, relation),
                source=source_id,
                target=target_id,
                relation=relation,  # type: ignore[arg-type]  # relation is always "calls"/"invokes" here
                dynamic=EdgeDynamics(
                    count=acc.count,
                    total_duration_ms=acc.total_duration_ms,
                    avg_latency_ms=avg_latency_ms,
                    event_refs=list(acc.event_refs),
                ),
            )
        )

    nodes: list[Node] = [
        *function_nodes.values(),
        *host_nodes.values(),
        *database_nodes.values(),
        *process_nodes.values(),
    ]

    stats.node_count = len(nodes)
    stats.edge_count = len(edges)

    global _last_build_stats
    _last_build_stats = stats
    logger.info(
        "build_graph(trace_id=%r): %d events -> %d nodes / %d edges "
        "(calls: %d resolved / %d unresolved; invokes: %d resolved / %d unresolved; "
        "db invokes: %d resolved / %d unresolved)",
        trace_id,
        stats.total_events,
        stats.node_count,
        stats.edge_count,
        stats.calls_edge_events,
        stats.calls_unresolved_events,
        stats.invokes_edge_events,
        stats.invokes_unresolved_events,
        stats.db_invokes_edge_events,
        stats.db_invokes_unresolved_events,
    )

    return ComputationalGraph(trace_id=trace_id, nodes=nodes, edges=edges)

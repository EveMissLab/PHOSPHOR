"""phosphor_trace.normalize -- turn phosphor_collector's two raw JSON artifacts
into the canonical ``TraceEvent`` list defined in ``phosphor_trace.schema``.

This is the seam between "raw capture" and "everything else PHOSPHOR does".
``phosphor_collector.collect`` knows nothing about ``TraceEvent``; it only
promises a manifest dict pointing at two files (see its module docstring for
the exact raw shapes). This module is the only place that reads those two
raw shapes and is responsible for producing well-formed, schema-valid
``TraceEvent`` objects for ``phosphor_graph`` and everything downstream.

Three sources, five event types
----------------------------------
- The viztracer JSON's ``"X"`` (duration) events become ``type="function_call"``
  events -- one ``TraceEvent`` per ``"X"`` event (the call's own duration is
  ``dur``; we do not synthesize a separate "return" event for it).
- The OTel spans JSON's ``spans`` become one ``TraceEvent`` each, classified
  by real, observed signals rather than guessed:
  - a span named exactly ``_otel_bootstrap.UNCAUGHT_EXCEPTION_SPAN_NAME``
    (``"phosphor.uncaught_exception"`` -- duplicated here as a literal
    rather than imported, since ``_otel_bootstrap.py`` is explicitly not
    meant to be imported, see its own module docstring) becomes
    ``type="error"``, ``source.file="<error>"`` -- the whole target script
    terminated via an uncaught exception or a non-clean ``sys.exit``.
  - a span whose ``attributes`` carry ``db.system`` (confirmed emitted only
    by ``_otel_bootstrap.py``'s ``_instrument_sqlite3`` -- see that
    function's docstring for why no off-the-shelf DB-API instrumentor was
    used) becomes ``type="db_query"``, ``source.file="<database>"`` --
    *unless* its ``status_code`` is ``"ERROR"`` (a genuinely failed query,
    e.g. malformed SQL -- see ``_traced_call``'s explicit exception
    handling), in which case it becomes ``type="error"`` instead while
    keeping ``source.file="<database>"`` (the failure is still, specifically,
    a database query -- nothing about its identity is lost, its ``resource``
    dict keeps every ``db.*`` attribute it always had, plus the
    ``exception.type``/``exception.message`` attributes ``_traced_call`` adds
    on failure).
  - every other span becomes ``type="network_request"``,
    ``source.file="<network>"`` (from the requests/urllib3
    instrumentation), similarly promoted to ``type="error"`` (keeping
    ``source.file="<network>"``) if its ``status_code`` is ``"ERROR"``.

  All four share the same ``resource``-building and ``parent_event``-linking
  logic below -- only ``type``/``source.file`` differ. An ``error`` event's
  ``resource`` always carries whatever attributes its originating span had
  (so a failed db_query's ``error`` event still has ``db.statement``, etc.),
  plus ``exception.type``/``exception.message`` (and, for the whole-script
  case, ``exception.stacktrace``) -- real, specific detail, never just "an
  error happened" (see ``_otel_bootstrap.py``'s ``_emit_error_span`` and
  ``_traced_call``).
- The memory-samples JSON's ``samples`` (``phosphor_collector.collect``'s
  third artifact -- see its module docstring for the exact raw shape) become
  one ``TraceEvent`` each, ``type="memory_sample"``, ``source.file="<memory>"``
  -- see ``_normalize_memory_samples`` below for the full field-by-field
  rationale. Unlike the other four types, these are handled entirely
  separately from ``_reconstruct_call_stacks`` (see that section below and
  ``normalize()``'s own docstring): a memory sample is a background,
  asynchronous measurement, never "called by" anything on the traced
  script's call stack the way a network/db event genuinely is.

Hard invariant: every ``TraceEvent`` this module emits carries
``Evidence(level=EvidenceLevel.OBSERVED, confidence=1.0)``. These are real
captured facts, not inference -- only ``phosphor_graph``/``phosphor_explain``
are allowed to layer ``inferred``/``hypothesized``/``verified`` claims on top
(Hallucination Control, whitepaper §24; see ``phosphor_trace/schema.py``).

Design notes for downstream (phosphor_graph) readers
-------------------------------------------------------
- ``parent_event`` is populated two ways, in order of precedence:
  1. For network_request events whose originating OTel span's
     ``parent_span_id`` refers to another span *also* captured in this same
     trace (resolved via each span's own ``span_id``, unrelated to our
     ``event_id`` namespace -- see ``_normalize_otel``'s internal
     ``otel span_id -> event_id`` map). This is the most directly observed
     link available (the instrumentation library itself reported it) and is
     never overridden.
  2. For every event without a parent_event from (1) -- including every
     function_call event, since viztracer's raw "X" events carry no explicit
     parent pointer of their own -- ``_reconstruct_call_stacks`` derives one
     via interval nesting: within a single (pid, tid), a function_call
     event's ``[timestamp, timestamp + duration_ms/1000]`` interval
     containing another event's start time is a directly computed geometric
     fact from real measured start/end times, not a guess (the same
     technique flame graphs use to reconstruct a call tree from ts/dur
     pairs). See that function's docstring for the exact algorithm and its
     scope limits (single-thread only; assumes well-nested, non-overlapping
     call/return pairs).
- OTel spans carry no pid/tid of their own (see ``_otel_bootstrap.py``'s
  ``_span_to_dict``). Since the OTel exporter and viztracer run in the exact
  same subprocess invocation (see ``phosphor_collector.collect``'s module
  docstring), network_request events reuse the pid/tid of the traced
  process's main thread, read from the viztracer file's own ``"M"``
  (``process_name``/``thread_name``) metadata events. If no such metadata is
  present, this falls back to ``pid=0, tid=0`` -- a sentinel, not an
  observed value.
- ``resource`` values are always coerced to ``str`` before being handed to
  the schema: OTel attribute values are frequently ``int``/``bool``/``float``
  (e.g. ``http.status_code``), and ``TraceEvent.resource`` is typed
  ``dict[str, str] | None`` -- pydantic does NOT implicitly coerce those
  scalar types into ``str`` (verified: it raises), so this module must do it
  explicitly rather than let construction fail.
"""

from __future__ import annotations

import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any

from phosphor_trace.schema import (
    Evidence,
    EvidenceLevel,
    RuntimeContext,
    SourceLocation,
    TraceEvent,
)

# Matches viztracer's "<function> (<file>:<line>)" name format. Greedy ``.+``
# for the file group is deliberate: it lets Windows drive-letter colons
# (``C:\...``) survive, because the regex backtracks to the *last*
# ``:<digits>)`` in the string rather than stopping at the first colon.
_NAME_RE = re.compile(r"^(.+) \((.+):(\d+)\)$")

_BUILTIN_FILE = "<builtin>"
_NETWORK_FILE = "<network>"
_DATABASE_FILE = "<database>"
_ERROR_FILE = "<error>"
_MEMORY_FILE = "<memory>"

# The one attribute name that reliably distinguishes a db_query span from a
# network_request span in this project's own OTel output: emitted by every
# span _otel_bootstrap.py's _instrument_sqlite3 produces (confirmed against a
# real captured trace of demo_targets/db_bound.py -- 'db.system': 'sqlite' on
# every sqlite3.execute/executemany span), and never emitted by the requests/
# urllib3 instrumentation's http.* spans. Not a guess against the OTel
# semantic-conventions spec in the abstract -- this project only has to agree
# with what its own two instrumentation paths actually emit.
_DB_QUERY_MARKER_ATTR = "db.system"

# Duplicated from _otel_bootstrap.UNCAUGHT_EXCEPTION_SPAN_NAME as a literal,
# not imported: _otel_bootstrap.py is explicitly not meant to be imported
# (see its own module docstring -- it's invoked as a subprocess script, not
# a library). The one span this exact name is ever given, by construction
# (_otel_bootstrap.py's _emit_error_span is its only caller).
_UNCAUGHT_EXCEPTION_SPAN_NAME = "phosphor.uncaught_exception"

# The only status_code value _otel_bootstrap.py's exporter ever produces for
# a genuinely failed span (see OTel's own StatusCode enum: UNSET/OK/ERROR).
_ERROR_STATUS_CODE = "ERROR"

# The exact literal prefix phosphor_collector.collect() writes into
# collector_result["error"] for exactly one case: the bootstrap subprocess
# exited non-zero (see its "if proc.returncode != 0:" branch). That single
# error shape is ambiguous by itself -- it covers both "the target script
# raised/exited non-zero, but _otel_bootstrap.py still gracefully wrote both
# output artifacts (including a real type="error" span, see module
# docstring)" and "the bootstrap subprocess crashed before it could write
# anything at all". normalize() below resolves the ambiguity by attempting
# to load the files regardless when it sees this prefix, rather than
# guessing from the string alone -- see normalize()'s docstring. No other
# collector_result["error"] shape (missing script, timeout, unreadable
# output) is ever potentially-recoverable this way, so every other shape
# still raises immediately, unchanged from before this module supported
# type="error" events.
_RECOVERABLE_ERROR_PREFIX = "subprocess exited with code "


class CollectionFailedError(Exception):
    """Raised when normalize() cannot produce a usable TraceEvent list at all.

    A caller must not be able to mistake "collection failed" for "the traced
    program simply did nothing" -- a genuine collection failure (missing
    script, timeout, missing/unparseable output files) must surface loudly
    here rather than producing a silently empty or partial TraceEvent list.

    Note this is NOT raised just because ``collector_result["error"]`` is
    set: a target script that raised an uncaught exception or called
    ``sys.exit`` with a non-clean code also makes the collector subprocess
    exit non-zero (``collector_result["error"]`` starts with "subprocess
    exited with code ..."), but ``_otel_bootstrap.py`` still writes both
    output artifacts in that case, including a real ``type="error"``-bound
    span for the failure (see its ``_emit_error_span``) -- that is genuinely
    useful, fully captured data, not a failed collection, so ``normalize()``
    still attempts to load and normalize it below rather than discarding it.
    Only when that attempt itself fails (the files are truly missing or
    unparseable -- e.g. the subprocess crashed before either artifact could
    be written at all) does this error get raised for that case too, via the
    same ``_load_json`` path used for every other genuine failure.
    """


class _EventIdGenerator:
    """Produces unique, stable-within-one-normalize()-call event ids."""

    def __init__(self) -> None:
        self._next = 0

    def next_id(self) -> str:
        event_id = f"evt_{self._next:08d}"
        self._next += 1
        return event_id


def _observed_evidence() -> Evidence:
    return Evidence(level=EvidenceLevel.OBSERVED, confidence=1.0)


def _parse_viztracer_name(name: str) -> tuple[str, str, int | None]:
    """Return (function, file, line) for a viztracer "X" event's ``name``.

    Ordinary Python calls look like ``"add (C:\\...\\demo.py:9)"``. Builtins
    and C-implemented methods (``builtins.print``, ``str.rpartition``,
    ``dict.get``, ``_thread.allocate_lock``, ...) have no ``(file:line)``
    suffix at all -- confirmed against real viztracer output, where these
    make up the majority of events for a trivial script (import-machinery
    and stdlib calls dominate a raw trace). For those, per spec: function is
    the full raw name, file is the "<builtin>" sentinel, line is None.

    Note a related but distinct case this function does NOT special-case:
    frozen-stdlib frames like ``"run_path (<frozen runpy>:269)"`` DO match
    the ``(file:line)`` pattern (the regex only cares about the trailing
    ``(...:digits)`` shape), so they parse as a "real" source location with
    file="<frozen runpy>" -- a bracketed pseudo-path, not an on-disk file,
    but faithfully reproducing what viztracer actually recorded. Callers
    that want strictly on-disk source locations should additionally filter
    out any ``source.file`` starting with ``"<"``.
    """
    match = _NAME_RE.match(name)
    if match:
        func, file, line = match.group(1), match.group(2), int(match.group(3))
        return func, file, line
    return name, _BUILTIN_FILE, None


def _load_json(path: str, trace_id: str, label: str) -> dict[str, Any]:
    file_path = Path(path)
    if not file_path.is_file():
        raise CollectionFailedError(
            f"normalize() could not find the {label} file for trace_id={trace_id!r} "
            f"at {path!r} (collector_result reported no error, but the file is missing)"
        )
    try:
        with open(file_path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        raise CollectionFailedError(
            f"normalize() could not parse the {label} file for trace_id={trace_id!r} "
            f"at {path!r}: {exc}"
        ) from exc


def _main_process_thread(viz_data: dict[str, Any]) -> tuple[int, int]:
    """Best-effort (pid, tid) of the traced subprocess's main thread.

    Read from viztracer's own "M" metadata events, since OTel spans (from
    the same subprocess invocation, see module docstring) don't carry
    pid/tid of their own.

    MUST prefer the ``thread_name`` event whose ``args.name == "MainThread"``
    over just taking the first ``thread_name`` event in file order: for a
    script that spawns worker threads (e.g. ``ThreadingHTTPServer``, one of
    the two demo targets), viztracer emits one ``thread_name`` metadata event
    per thread in *completion* order, not creation order -- a background
    worker thread routinely finishes (and so gets its metadata event
    written) before "MainThread"'s own event appears. Taking the first match
    blindly was a real bug, caught by cross-checking real client-request
    events against real server-thread events on ``demo_targets/io_bound.py``:
    it silently attributed every OTel network_request event to an unrelated
    background thread's tid, which meant they could never interval-nest
    with the (correctly-tid'd) function_call events that actually made those
    requests. Falls back to the first thread_name event if no "MainThread"
    is present (e.g. a single-threaded script may not even emit a
    thread_name event distinct from the implicit main thread), then to
    process_name's own pid, then to ``(0, 0)`` -- a sentinel, never a real
    observed value.
    """
    trace_events = viz_data.get("traceEvents", [])
    thread_name_events = [e for e in trace_events if e.get("ph") == "M" and e.get("name") == "thread_name"]

    main_thread_event = next(
        (e for e in thread_name_events if (e.get("args") or {}).get("name") == "MainThread"),
        None,
    )
    if main_thread_event is not None:
        return int(main_thread_event.get("pid", 0)), int(main_thread_event.get("tid", 0))

    if thread_name_events:
        first = thread_name_events[0]
        return int(first.get("pid", 0)), int(first.get("tid", 0))

    process_name_event = next(
        (e for e in trace_events if e.get("ph") == "M" and e.get("name") == "process_name"),
        None,
    )
    if process_name_event is not None:
        pid = int(process_name_event.get("pid", 0))
        return pid, pid

    return 0, 0


def _viztracer_base_time_seconds(viz_data: dict[str, Any]) -> float:
    """Real Unix-epoch anchor (seconds) for viztracer's ``ts`` values.

    viztracer's raw ``ts``/``dur`` fields are NOT Unix epoch time -- they're
    relative to an internal monotonic clock. ``viztracer_metadata.
    baseTimeNanoseconds`` is the real epoch instant that ``ts=0``
    corresponds to (confirmed empirically: adding it to a real captured
    event's ``ts`` lands within milliseconds of an OTel span's true
    ``start_time_unix_nano``-derived timestamp for the same real-world
    moment). Without this offset, function_call timestamps and
    network_request timestamps live in two numerically incomparable scales
    (differing by ~1.78 billion), which silently defeated ALL interval
    nesting between them -- caught the same way as the thread-selection bug
    above, by cross-checking real captured data rather than trusting the
    two sources to already agree.

    Falls back to 0.0 (leaving function_call timestamps in viztracer's
    relative scale, as before) if this metadata is ever absent -- degrades
    function_call-to-function_call nesting not at all (a uniform per-event
    offset cancels out in interval comparisons among themselves), but
    function_call-to-network_request nesting would not occur in that case.
    """
    return float(viz_data.get("viztracer_metadata", {}).get("baseTimeNanoseconds", 0)) / 1_000_000_000.0


def _normalize_viztracer(
    viz_data: dict[str, Any],
    trace_id: str,
    id_gen: _EventIdGenerator,
) -> list[TraceEvent]:
    trace_events = viz_data.get("traceEvents", [])
    base_time_s = _viztracer_base_time_seconds(viz_data)

    events: list[TraceEvent] = []
    for raw in trace_events:
        if raw.get("ph") != "X":
            continue

        name = raw.get("name", "")
        func, file, line = _parse_viztracer_name(name)

        ts_us = raw.get("ts", 0.0)
        dur_us = raw.get("dur", 0.0)

        events.append(
            TraceEvent(
                event_id=id_gen.next_id(),
                trace_id=trace_id,
                timestamp=base_time_s + float(ts_us) / 1_000_000.0,
                type="function_call",
                source=SourceLocation(file=file, line=line, function=func),
                runtime=RuntimeContext(pid=int(raw.get("pid", 0)), tid=int(raw.get("tid", 0))),
                duration_ms=float(dur_us) / 1_000.0,
                evidence=_observed_evidence(),
            )
        )

    return events


def _normalize_otel(
    otel_data: dict[str, Any],
    trace_id: str,
    id_gen: _EventIdGenerator,
    fallback_pid: int,
    fallback_tid: int,
) -> list[TraceEvent]:
    spans = otel_data.get("spans", [])

    events: list[TraceEvent] = []
    otel_span_id_to_event_id: dict[str, str] = {}
    span_parent_ids: list[str | None] = []

    for span in spans:
        name = span.get("name") or "<unnamed span>"
        start_ns = span.get("start_time_unix_nano")
        duration_ms = span.get("duration_ms")

        attributes = span.get("attributes") or {}
        resource = {str(k): str(v) for k, v in attributes.items()}
        if span.get("kind") is not None:
            resource["otel.kind"] = str(span["kind"])
        if span.get("status_code") is not None:
            resource["otel.status_code"] = str(span["status_code"])
        if span.get("status_description"):
            resource["otel.status_description"] = str(span["status_description"])

        is_uncaught_exception = name == _UNCAUGHT_EXCEPTION_SPAN_NAME
        is_db_query = _DB_QUERY_MARKER_ATTR in attributes
        is_error_status = span.get("status_code") == _ERROR_STATUS_CODE

        if is_uncaught_exception:
            # The whole target script terminated -- not attached to any
            # particular database/network call, see module docstring.
            event_type = "error"
            source_file = _ERROR_FILE
        elif is_db_query:
            event_type = "error" if is_error_status else "db_query"
            source_file = _DATABASE_FILE
        else:
            event_type = "error" if is_error_status else "network_request"
            source_file = _NETWORK_FILE

        event = TraceEvent(
            event_id=id_gen.next_id(),
            trace_id=trace_id,
            timestamp=float(start_ns) / 1_000_000_000.0 if start_ns is not None else 0.0,
            type=event_type,
            source=SourceLocation(file=source_file, line=None, function=name),
            runtime=RuntimeContext(pid=fallback_pid, tid=fallback_tid),
            duration_ms=float(duration_ms) if duration_ms is not None else None,
            resource=resource,
            evidence=_observed_evidence(),
        )

        events.append(event)
        span_id = span.get("span_id")
        if span_id:
            otel_span_id_to_event_id[span_id] = event.event_id
        span_parent_ids.append(span.get("parent_span_id"))

    # Second pass: link parent_event using the real parent_span_id -> our
    # event_id map, but only when the parent span was itself captured (a
    # parent outside this trace resolves to nothing, and we do not invent a
    # placeholder for it).
    for event, parent_span_id in zip(events, span_parent_ids):
        if parent_span_id and parent_span_id in otel_span_id_to_event_id:
            event.parent_event = otel_span_id_to_event_id[parent_span_id]

    return events


def _normalize_memory_samples(
    memory_data: dict[str, Any],
    trace_id: str,
    id_gen: _EventIdGenerator,
    fallback_pid: int,
    fallback_tid: int,
) -> list[TraceEvent]:
    """Turn phosphor_collector's raw memory-samples JSON (see
    ``phosphor_collector.collect``'s module docstring for the exact
    ``{"trace_id": ..., "samples": [{"timestamp_unix", "rss_bytes",
    "vms_bytes"}, ...]}`` shape) into one ``type="memory_sample"``
    ``TraceEvent`` per real sample.

    ``timestamp`` is the sample's own ``timestamp_unix`` used as-is: it is
    already a real Unix-epoch ``time.time()`` value (see
    ``_otel_bootstrap.py``'s ``_sample_memory_loop``) -- the SAME frame
    ``_normalize_otel``'s ``start_time_unix_nano``-derived timestamps use, so
    no offset/conversion is needed here, unlike viztracer's own ``ts``
    (relative to an internal monotonic clock -- see
    ``_viztracer_base_time_seconds``, whose whole reason for existing is to
    convert viztracer's scale into this same real-epoch frame).

    ``source.file`` is ``"<memory>"`` -- a sentinel parallel to
    ``_NETWORK_FILE``/``_DATABASE_FILE``/``_ERROR_FILE`` above, since a
    memory sample likewise has no real on-disk source location of its own.
    ``source.function`` is the fixed literal ``"memory.sample"`` (every
    sample is the same kind of event; there is no per-sample "function name"
    the way a viztracer call has one).

    ``resource`` carries ``memory.rss_bytes``/``memory.vms_bytes``, coerced
    to ``str`` -- same discipline as every other ``resource`` dict in this
    module (``TraceEvent.resource`` is typed ``dict[str, str] | None`` and
    pydantic does not implicitly coerce ``int``).

    ``runtime`` reuses the same ``(fallback_pid, fallback_tid)``
    ``_normalize_otel`` falls back to (the traced subprocess's own main
    thread, read from viztracer's own "M" metadata -- see
    ``_main_process_thread``). This is a deliberate, documented choice, not
    an oversight: a memory sample is a real, process-wide measurement
    (``psutil.Process(os.getpid()).memory_info()``, taken by a background
    daemon thread -- see ``_otel_bootstrap.py``'s ``_sample_memory_loop``),
    not tied to any single thread the way a ``function_call`` event
    genuinely is. ``RuntimeContext`` has no "process-wide, no specific
    thread" sentinel of its own, so attributing every sample to the main
    thread's runtime context is the most honest fit available in the current
    schema, given the process's own memory footprint is exactly what is
    being measured (see ``_otel_bootstrap.py``'s own docstring: the traced
    target runs in-process via ``runpy.run_path``, not as a further child
    process, so this subprocess's memory IS the target script's memory).

    ``parent_event`` is deliberately left unset (``None``) here, and this
    function's output must NEVER be passed through
    ``_reconstruct_call_stacks`` (see ``normalize()``'s own docstring for
    where that separation is enforced). A memory sample is an asynchronous,
    background measurement the sampler thread took independently of
    whatever the traced script's own call stack looked like at that exact
    instant -- unlike a network/db event, it was not "called by" anything on
    that stack, so interval-nesting it in would fabricate a causal link this
    project has no real evidence for (Hallucination Control, whitepaper
    Sec.24 -- see ``phosphor_trace/schema.py``'s module docstring).

    ``evidence`` stays ``OBSERVED`` -- these are real measured
    ``psutil`` readings, exactly as directly-observed as any other captured
    event.
    """
    samples = memory_data.get("samples", [])

    events: list[TraceEvent] = []
    for sample in samples:
        rss_bytes = sample.get("rss_bytes")
        vms_bytes = sample.get("vms_bytes")
        events.append(
            TraceEvent(
                event_id=id_gen.next_id(),
                trace_id=trace_id,
                timestamp=float(sample.get("timestamp_unix", 0.0)),
                type="memory_sample",
                source=SourceLocation(file=_MEMORY_FILE, line=None, function="memory.sample"),
                runtime=RuntimeContext(pid=fallback_pid, tid=fallback_tid),
                resource={
                    "memory.rss_bytes": str(rss_bytes),
                    "memory.vms_bytes": str(vms_bytes),
                },
                evidence=_observed_evidence(),
            )
        )

    return events


def _reconstruct_call_stacks(events: list[TraceEvent]) -> None:
    """Populate ``parent_event`` via interval nesting, grouped by (pid, tid).

    Mutates ``events`` in place. Never touches an event that already has a
    ``parent_event`` (e.g. from genuine OTel ``parent_span_id`` chaining in
    ``_normalize_otel`` -- that link was reported by the instrumentation
    itself and is strictly more directly observed than anything this
    function computes, so it always wins).

    Algorithm: within one (pid, tid), sort events by start time (ties broken
    function_call-before-other, so a function_call that legitimately
    contains another event starting at the exact same timestamp is treated
    as the container, not a sibling -- true ties between two function_call
    events fall back to their original order, which is undefined when two
    calls share an identical microsecond timestamp; this is a real, if rare,
    ambiguity, not hidden here). Walk in order maintaining a stack of
    currently-open function_call frames: pop any frame whose
    ``timestamp + duration_ms/1000`` end time is at or before the current
    event's start; whatever remains on top of the stack (if anything) is the
    event's parent; if the current event is itself a function_call, push it
    as a new frame.

    This is a direct, deterministic computation from real measured start/end
    times -- not a probabilistic guess -- for a single thread's properly
    nested call/return pairs, which is exactly what viztracer's "X" events
    capture for ordinary synchronous Python calls. Scope limits, not hidden:
    never attempted across threads/processes (concurrent wall-clock overlap
    across threads does not imply a caller/callee relationship); assumes
    well-nested intervals, which is not guaranteed for generators/coroutines
    that suspend mid-call; an event with ``duration_ms=None`` is treated as
    a zero-width instant (it can nest inside an open frame, but never itself
    becomes a frame other events nest inside, since only function_call
    events are pushed and every function_call has a real ``dur`` from
    viztracer).
    """
    by_thread: dict[tuple[int, int], list[TraceEvent]] = defaultdict(list)
    for event in events:
        by_thread[(event.runtime.pid, event.runtime.tid)].append(event)

    def end_time(event: TraceEvent) -> float:
        return event.timestamp + (event.duration_ms or 0.0) / 1_000.0

    for thread_events in by_thread.values():
        ordered = sorted(
            thread_events,
            key=lambda e: (e.timestamp, 0 if e.type == "function_call" else 1),
        )

        stack: list[TraceEvent] = []
        for event in ordered:
            while stack and end_time(stack[-1]) <= event.timestamp:
                stack.pop()
            if stack and event.parent_event is None:
                event.parent_event = stack[-1].event_id
            if event.type == "function_call":
                stack.append(event)


def normalize(collector_result: dict[str, Any], trace_id: str) -> list[TraceEvent]:
    """Normalize a phosphor_collector.collect() result into TraceEvents.

    Raises ``CollectionFailedError`` for a genuine collection failure --
    missing script, timeout, or unreadable/unparseable output -- so a failed
    collection is never mistaken for "the program did nothing" by silently
    yielding an empty or partial list. See ``CollectionFailedError``'s own
    docstring for the one deliberate exception to "raise whenever
    ``collector_result['error']`` is set": a target script that raised an
    uncaught exception or exited non-zero still gets its two output
    artifacts written by ``_otel_bootstrap.py`` (including a real
    ``type="error"`` span for the failure), so that case is not fatal here --
    ``normalize()`` still attempts to load and normalize it, same as a clean
    run, only actually raising if that attempt itself fails.

    Returns the combined viztracer-derived (``function_call``),
    OTel-derived (``network_request``/``db_query``/``error``), and
    memory-sampler-derived (``memory_sample``) events, sorted by
    ``timestamp`` ascending. Every event carries
    ``Evidence(level=OBSERVED, confidence=1.0)`` -- an error genuinely
    observed to occur is exactly as directly-observed as any other captured
    event, never downgraded to a lower evidence level (whitepaper Sec.24,
    Hallucination Control; see ``phosphor_trace/schema.py``).

    ``memory_sample`` events are deliberately built and appended AFTER
    ``_reconstruct_call_stacks`` runs, over a separate list containing only
    the function_call/network_request/db_query/error events -- never mixed
    into the list ``_reconstruct_call_stacks`` itself walks. That function
    groups everything it sees by ``(pid, tid)`` and links same-thread events
    by real interval nesting; since every ``memory_sample`` event shares the
    traced process's main-thread ``(pid, tid)`` (see
    ``_normalize_memory_samples``'s own docstring for why), including them in
    that walk would both fabricate a ``parent_event`` link for a background
    measurement that was not actually "called by" anything on the stack, and
    let a sample's own timestamp spuriously pop/perturb open call frames it
    has no real relationship to. Keeping them out entirely -- not just
    leaving ``parent_event`` unset on them after the fact -- is what
    guarantees both.
    """
    error = collector_result.get("error")
    if error and not error.startswith(_RECOVERABLE_ERROR_PREFIX):
        raise CollectionFailedError(
            f"cannot normalize trace_id={trace_id!r}: collection failed: {error}"
        )

    id_gen = _EventIdGenerator()

    viz_data = _load_json(collector_result["viztracer_path"], trace_id, "viztracer")
    otel_data = _load_json(collector_result["otel_spans_path"], trace_id, "otel spans")
    memory_data = _load_json(collector_result["memory_samples_path"], trace_id, "memory samples")

    fallback_pid, fallback_tid = _main_process_thread(viz_data)

    function_events = _normalize_viztracer(viz_data, trace_id, id_gen)
    network_events = _normalize_otel(otel_data, trace_id, id_gen, fallback_pid, fallback_tid)
    memory_events = _normalize_memory_samples(memory_data, trace_id, id_gen, fallback_pid, fallback_tid)

    reconstructable_events = function_events + network_events
    _reconstruct_call_stacks(reconstructable_events)

    all_events = reconstructable_events + memory_events
    all_events.sort(key=lambda e: e.timestamp)
    return all_events

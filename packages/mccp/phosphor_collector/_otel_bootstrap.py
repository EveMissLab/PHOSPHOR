"""In-subprocess bootstrap: sets up OpenTelemetry + viztracer, runs the target
script, dumps both raw artifacts.

This file is NOT meant to be imported. It is invoked directly as a script by
``phosphor_collector.collect``::

    python _otel_bootstrap.py <target_script> <viztracer_out> <otel_out> <memory_samples_out> [trace_id]

Rationale for doing OTel *and* viztracer setup inside this subprocess rather
than the parent (phosphor_collector.collect):

- viztracer always traces the target as a separate OS process, and
  OpenTelemetry's in-process TracerProvider / instrumentation state does not
  cross a subprocess boundary. Any OTel wiring done in the parent would never
  see the target script's HTTP calls, so it has to be re-created here, before
  the target script's own code runs.
- We use viztracer's Python API (``VizTracer().start()/.stop()/.save()``)
  rather than the ``python -m viztracer`` CLI wrapper, and start the tracer
  *after* OpenTelemetry (and its instrumentation packages) have finished
  importing. Importing the OTel SDK pulls in a surprisingly large amount of
  stdlib machinery (re, typing, enum, logging, ipaddress, ...); tracing that
  import from process start would bury the target script's own events under
  tens of thousands of unrelated "X" events. Starting the tracer only around
  ``runpy.run_path(target_script)`` keeps the viztracer output focused on
  the thing PHOSPHOR is actually supposed to explain: the target script.

Uncaught target-script failures (exception or non-clean ``sys.exit``)
------------------------------------------------------------------------
An exception that escapes ``runpy.run_path``, or a non-clean ``sys.exit``,
is caught here (never silently swallowed, never left to crash this
bootstrap script itself before it can write its output) and captured as a
real ERROR-status OTel span (see ``_emit_error_span``) alongside every other
span this subprocess produces -- both artifacts are still written
(``tracer.save()``/the OTel spans dump both happen in the ``finally`` below
regardless of how the target script finished, exactly as before this
capture was added).

This bootstrap still exits non-zero (``sys.exit(1)``, unchanged) and still
writes ``run_error`` to both ``payload["error"]`` and stderr in that case --
that existing exit-code/stderr contract, which ``phosphor_collector.collect``
depends on to detect "the subprocess did not cleanly finish", is deliberately
left untouched here. What changed is downstream: ``phosphor_trace.normalize``
now knows how to tell "the target script itself crashed, but genuinely
useful output was still captured" apart from "collection produced nothing
usable at all" (missing script, timeout, unreadable output) and only treats
the latter as fatal -- see that module's docstring.

Background memory sampler (third output artifact)
-------------------------------------------------------
A daemon thread (``_sample_memory_loop``) samples the *real* process memory
of this exact subprocess (``psutil.Process(os.getpid())`` -- the traced
target script runs in-process here via ``runpy.run_path``, not as a further
child process, so this subprocess's own memory IS the target script's
memory) roughly every ``_MEMORY_SAMPLE_INTERVAL_S`` (50ms) seconds, appending
``{"timestamp_unix": ..., "rss_bytes": ..., "vms_bytes": ...}`` dicts to an
in-memory list. Its ``threading.Thread`` is created and ``.start()``-ed
BEFORE ``tracer.start()`` (not after) -- deliberately outside the traced
window, same reasoning as the OTel SDK setup earlier in this function:
empirically confirmed, against this project's own real trace-bound test,
that ``Thread.start()`` itself (CPython's implementation unconditionally
waits on an internal ``threading.Event`` to confirm the new OS thread
actually began running) gets captured by viztracer -- which traces every
thread active while it is running, not just the target script's -- as real
extra ``function_call`` nodes/edges if it runs while the tracer is started.
The thread's own loop keeps running throughout ``runpy.run_path`` regardless
of exactly when ``.start()`` was called, so real sampling still covers the
target script's actual execution window. It is stopped (a plain one-item
``list[bool]`` flag flipped to ``True``, then ``join(timeout=...)``) only
AFTER ``tracer.stop()``/``tracer.save()`` in the existing ``finally`` block,
for the identical reason on the stop side (``Thread.join()`` has its own
traceable internals too) -- this only appends statements to the existing
``try/except/finally`` around ``runpy.run_path``, strictly after its two
existing lines; it does not reorder or replace any of the existing exception
handling or the viztracer stop/save sequence, so the exit-code/stderr
contract described above is untouched. The stop signal is deliberately a
plain flag checked with a bare index read plus ``time.sleep`` for the
between-samples pause inside the loop body itself, NOT a ``threading.Event``
-- see ``_sample_memory_loop``'s own docstring for why: the loop body is the
one part of this sampler that unavoidably keeps running *during* the traced
window, so it must stay as viztracer-invisible as possible on its own too.
The collected samples are written, regardless of how the target script
finished (same "always write, even on failure" discipline as the OTel spans
dump below), to a NEW third file -- ``<memory_samples_out>`` -- shaped as
``{"trace_id": ..., "samples": [...]}``. This is deliberately a plain list,
not folded into the OTel span/duration model: a memory sample is a
point-in-time value, not a duration, so forcing it into the existing span
shape would be a worse fit than this dedicated lightweight artifact. See
``phosphor_collector.collect``'s module docstring for the full three-artifact
manifest contract (``memory_samples_path`` alongside the existing
``viztracer_path``/``otel_spans_path``).
"""

from __future__ import annotations

import json
import os
import runpy
import sys
import threading
import time
import traceback


_MAX_CAPTURED_TEXT_CHARS = 4000

# How often the background memory sampler (_sample_memory_loop) takes a real
# psutil.Process().memory_info() reading while the target script's own
# runpy.run_path is executing. 50ms is frequent enough to catch a short-lived
# allocation spike in an ordinary demo-script-scale run without adding
# meaningful overhead of its own (one psutil call plus a dict append, per
# tick) -- not tuned against any specific target, just a conservative,
# documented, inspectable default (same "no principled tunable, just a
# recorded choice" stance phosphor_projector.project takes for its own
# threshold constants).
_MEMORY_SAMPLE_INTERVAL_S = 0.05

# The span name for the one error span this module emits for an uncaught
# failure that terminates the whole target script (as opposed to a single
# failed sqlite3 call, which stays attached to its own "sqlite3.execute"/
# "sqlite3.executemany" span -- see _instrument_sqlite3's _traced_call).
# phosphor_trace.normalize matches this exact literal to classify the span
# as type="error" with source.file="<error>" rather than "<database>"/
# "<network>" -- see that module's _normalize_otel and its comment on why
# the string is duplicated there rather than imported (this file is not
# meant to be imported, see the module docstring above).
UNCAUGHT_EXCEPTION_SPAN_NAME = "phosphor.uncaught_exception"


def _truncate_text(text: str) -> str:
    """Cap a captured text field's length so something unboundedly large (a
    huge generated SQL statement, a deep exception traceback, ...) can never
    make a span attribute (and therefore the otel_spans.json file)
    unboundedly large. Appends a visible marker rather than silently
    dropping the tail, so a reader of the captured span can tell truncation
    happened rather than mistaking the cut-off text for the whole value.
    Shared by both the sqlite3 SQL-statement capture (_instrument_sqlite3)
    and the exception message/traceback capture (_emit_error_span) below --
    same size concern, same fix, no reason for two copies.
    """
    if len(text) <= _MAX_CAPTURED_TEXT_CHARS:
        return text
    return text[:_MAX_CAPTURED_TEXT_CHARS] + f"...<truncated, {len(text)} chars total>"


def _emit_error_span(tracer, exception_type: str, message: str, stacktrace: str | None) -> None:
    """Emit one real OTel span with ERROR status for an uncaught failure that
    terminates the target script (an exception that escaped ``runpy.run_path``,
    or ``sys.exit`` with a non-clean code).

    Reuses the exact same span/attribute/status machinery
    ``_instrument_sqlite3``'s ``_traced_call`` already uses for a failed
    query -- not a third output format (this project's two-artifact
    contract, documented in ``phosphor_collector.collect``'s module
    docstring, must not gain a third file/shape).

    Exception detail is set as plain span *attributes*
    (``exception.type``/``exception.message``/``exception.stacktrace``),
    not left to OpenTelemetry's own default ``record_exception``
    behavior: empirically confirmed (against a real captured span) that the
    SDK's default only puts this detail on a span *event*, and
    ``_span_to_dict`` below only ever serializes span *attributes* -- so
    relying on the default would silently lose the detail this function
    exists to capture. ``span.set_status`` is still called explicitly too,
    for the same reason (defense over relying on ``set_status_on_exception``
    defaults matching exactly what we want).
    """
    from opentelemetry.trace import Status, StatusCode

    with tracer.start_as_current_span(UNCAUGHT_EXCEPTION_SPAN_NAME) as span:
        span.set_attribute("exception.type", exception_type)
        span.set_attribute("exception.message", _truncate_text(message))
        if stacktrace:
            span.set_attribute("exception.stacktrace", _truncate_text(stacktrace))
        span.set_status(Status(StatusCode.ERROR, message))


def _instrument_sqlite3(tracer) -> None:
    """Monkeypatch stdlib ``sqlite3`` to emit one OTel span per real
    ``execute``/``executemany`` call, carrying the SQL statement, the db file
    path, and (via the span's own start/end time) duration.

    No off-the-shelf OpenTelemetry instrumentor is used here. The generic
    DB-API 2.0 instrumentor (``opentelemetry-instrumentation-dbapi``, which
    ``sqlite3`` implements) was hand-tested against real stdlib ``sqlite3``
    before writing this function: it DOES cleanly wrap ``sqlite3.connect``
    and DOES emit real ``db.system``/``db.statement`` spans (confirmed with a
    real CREATE/INSERT/SELECT sequence). But it resolves the db name/host
    purely by reading attributes (``connection_attributes``) off the
    *Connection instance itself* (see its ``DatabaseApiIntegration.
    get_connection_attributes``) -- and stdlib ``sqlite3.Connection`` exposes
    no such attribute: there is no ``.database``, and the raw C-extension
    type has no instance ``__dict__`` at all (confirmed: ``conn.x = 1`` on a
    real ``sqlite3.connect(...)`` result raises ``AttributeError: ...  no
    __dict__ for setting new attributes``). Since the db file path is a
    required field here, that library is a real dependency that does not fit
    this specific need, so this hand-written wrapper takes its place instead
    -- explicit and minimal, per this project's stated preference over
    fighting a library that doesn't fit.

    Because raw ``sqlite3.Connection``/``sqlite3.Cursor`` are immutable
    C-implemented types, per-class monkeypatching of their methods is also
    not possible (confirmed: ``sqlite3.Cursor.execute = ...`` raises
    ``TypeError: cannot set 'execute' attribute of immutable type
    'sqlite3.Cursor'``). What IS patchable is the one plain Python function
    at the module boundary, ``sqlite3.connect``, combined with the
    ``factory=`` keyword it already accepts: a pure-Python subclass of
    ``sqlite3.Connection``/``sqlite3.Cursor`` DOES get its own instance
    ``__dict__`` (confirmed empirically), so the traced connection can carry
    its own db path and route every ``execute``/``executemany`` call through
    a span-emitting override.

    Scope limits, not hidden:
    - Only traces calls that go through ``sqlite3.connect()`` (the
      standard, near-universal entry point). A script that constructs
      ``sqlite3.Connection`` some other way is not traced.
    - If the caller passes their own ``factory=`` to ``sqlite3.connect()``,
      that factory is respected as-is (never silently replaced) and that
      connection is simply not traced -- its ``execute``/``executemany``
      calls run unmodified, exactly as the caller's own factory intended.
    - ``executescript`` (arbitrary multi-statement SQL blobs, no parameter
      binding) is not wrapped -- ``execute``/``executemany`` are the two
      methods this project's whitepaper scope calls out.

    A genuinely failed query (e.g. malformed SQL, a missing table/column) is
    captured on its own span too, not silently swallowed: the ``try/except``
    inside ``_traced_call`` below explicitly sets ``exception.type``/
    ``exception.message`` attributes and an ERROR ``span.set_status`` before
    re-raising -- the same explicit-attribute pattern ``_emit_error_span``
    uses for a whole-script uncaught exception, and for the same reason
    (empirically confirmed: OpenTelemetry's own default exception recording
    only reaches span *events*, which ``_span_to_dict`` never serializes --
    see ``_emit_error_span``'s docstring). ``phosphor_trace.normalize``
    recognizes the resulting ERROR-status span and emits a
    ``type="error"`` ``TraceEvent`` for it (``source.file`` stays
    ``"<database>"``, since the failure is still, specifically, a database
    query) rather than the normal ``type="db_query"``.
    """
    import sqlite3

    from opentelemetry.trace import Status, StatusCode

    def _traced_call(cursor, method_name, sql, *args, **kwargs):
        db_path = getattr(cursor.connection, "_phosphor_db_path", "<unknown>")
        with tracer.start_as_current_span(f"sqlite3.{method_name}") as span:
            span.set_attribute("db.system", "sqlite")
            span.set_attribute("db.name", db_path)
            span.set_attribute("db.statement", _truncate_text(str(sql)))
            span.set_attribute("db.operation", method_name)
            unbound = getattr(sqlite3.Cursor, method_name)
            try:
                return unbound(cursor, sql, *args, **kwargs)
            except Exception as exc:
                span.set_attribute("exception.type", type(exc).__name__)
                span.set_attribute("exception.message", _truncate_text(str(exc)))
                span.set_status(Status(StatusCode.ERROR, str(exc)))
                raise

    class _TracedCursor(sqlite3.Cursor):
        def execute(self, sql, *args, **kwargs):
            return _traced_call(self, "execute", sql, *args, **kwargs)

        def executemany(self, sql, *args, **kwargs):
            return _traced_call(self, "executemany", sql, *args, **kwargs)

    class _TracedConnection(sqlite3.Connection):
        def cursor(self, factory=None):
            return sqlite3.Connection.cursor(self, factory or _TracedCursor)

        def execute(self, sql, *args, **kwargs):
            return self.cursor().execute(sql, *args, **kwargs)

        def executemany(self, sql, *args, **kwargs):
            return self.cursor().executemany(sql, *args, **kwargs)

    _original_connect = sqlite3.connect

    def _patched_connect(database, *args, **kwargs):
        caller_supplied_factory = "factory" in kwargs
        kwargs.setdefault("factory", _TracedConnection)
        connection = _original_connect(database, *args, **kwargs)
        if not caller_supplied_factory:
            # Only our own _TracedConnection subclass has an instance
            # __dict__ to hold this; a caller-supplied factory's connection
            # is left completely alone (see docstring scope limits).
            connection._phosphor_db_path = str(database)
        return connection

    sqlite3.connect = _patched_connect


def _sample_memory_loop(pid: int, stop_flag: list[bool], samples: list[dict]) -> None:
    """Background loop: append one real memory sample roughly every
    ``_MEMORY_SAMPLE_INTERVAL_S`` seconds until ``stop_flag[0]`` becomes True.

    Runs on its own daemon thread (started/stopped around ``runpy.run_path``
    in ``main()``, see module docstring's "Background memory sampler"
    section), *while viztracer is actively tracing* -- so every traced
    Python-level function this loop itself calls becomes a real
    ``function_call`` event too, exactly like everything else running during
    that window (this bootstrap has no way to scope viztracer's capture to
    one thread; it traces every thread that runs while started). That is why
    the stop signal here is a plain one-item ``list[bool]`` (checked with a
    bare index read, not a function call) and the between-samples pause is
    plain ``time.sleep`` (one C-implemented call) rather than
    ``threading.Event.wait()``/``.is_set()``: empirically confirmed, against
    this project's own real ``tests/test_graph.py::
    test_end_to_end_real_trace_bounds_node_count_despite_many_calls``, that
    ``threading.Event`` pulls in several of its own pure-Python methods
    (``Event.wait``, ``Event.is_set``, the internal ``RLock.__enter__``/
    ``__exit__`` it uses) that viztracer faithfully captures as real
    ``function_call`` nodes/edges every single run -- silently inflating
    every downstream ``ComputationalGraph`` with fixed sampler bookkeeping
    that has nothing to do with the traced target script. A plain list
    index and ``time.sleep`` add, at most, one shared "<builtin>"-file node
    for ``time.sleep`` itself (the same kind of fixed, already-tolerated
    overhead ``phosphor_graph.build``'s own noise-filtering already assumes
    exists) instead of a small tower of stdlib ``threading`` frames.
    ``threading.Thread.start()`` itself (needed regardless, to actually spin
    up the thread) still contributes a handful of one-time stdlib frames --
    unavoidable without abandoning a real background thread entirely, and
    small enough in practice not to threaten the same bound.

    ``psutil.Process(pid)`` is resolved once, outside the loop -- ``pid`` is
    always ``os.getpid()`` of this exact subprocess (the target script runs
    in-process via ``runpy.run_path``, not as a further child process, so
    this subprocess's own RSS/VMS genuinely IS the target script's memory
    footprint at each sample instant).

    A single failed sample (e.g. a transient ``psutil.Error`` -- not expected
    against this subprocess's own live PID, but not assumed impossible
    either) is swallowed and the loop continues rather than letting a
    background sampling thread crash the whole collection run over a
    best-effort diagnostic signal; the target script's own success/failure is
    what this project's exit-code contract is about, not this sampler's.
    Zero samples (a target script finishing before this thread is ever
    scheduled) is an accepted, valid outcome -- not an error -- and is left
    for the caller to observe from an empty ``samples`` list.
    """
    import psutil

    try:
        process = psutil.Process(pid)
    except Exception:
        return

    while not stop_flag[0]:
        try:
            mem_info = process.memory_info()
            samples.append(
                {
                    "timestamp_unix": time.time(),
                    "rss_bytes": int(mem_info.rss),
                    "vms_bytes": int(mem_info.vms),
                }
            )
        except Exception:
            pass
        time.sleep(_MEMORY_SAMPLE_INTERVAL_S)


def _span_to_dict(span) -> dict:
    ctx = span.get_span_context()
    parent = span.parent
    attributes = dict(span.attributes) if span.attributes else {}
    start = span.start_time
    end = span.end_time
    duration_ms = (end - start) / 1_000_000.0 if start is not None and end is not None else None
    status = span.status
    return {
        "name": span.name,
        "trace_id": format(ctx.trace_id, "032x") if ctx is not None else None,
        "span_id": format(ctx.span_id, "016x") if ctx is not None else None,
        "parent_span_id": format(parent.span_id, "016x") if parent is not None else None,
        "kind": span.kind.name if span.kind is not None else None,
        "start_time_unix_nano": start,
        "end_time_unix_nano": end,
        "duration_ms": duration_ms,
        "status_code": status.status_code.name if status is not None else None,
        "status_description": status.description if status is not None else None,
        "attributes": attributes,
    }


def main() -> None:
    target_script = sys.argv[1]
    viztracer_out_path = sys.argv[2]
    otel_out_path = sys.argv[3]
    memory_samples_out_path = sys.argv[4]
    collector_trace_id = sys.argv[5] if len(sys.argv) > 5 else None

    # --- OpenTelemetry setup (deliberately NOT traced by viztracer, see module docstring) ---
    from opentelemetry import trace
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    resource_attrs = {"service.name": "phosphor.collector.target"}
    if collector_trace_id:
        resource_attrs["phosphor.trace_id"] = collector_trace_id

    exporter = InMemorySpanExporter()
    provider = TracerProvider(resource=Resource.create(resource_attrs))
    provider.add_span_processor(SimpleSpanProcessor(exporter))
    trace.set_tracer_provider(provider)

    instrumented_libraries: list[str] = []

    try:
        from opentelemetry.instrumentation.requests import RequestsInstrumentor

        RequestsInstrumentor().instrument()
        instrumented_libraries.append("requests")
    except Exception:
        pass

    try:
        from opentelemetry.instrumentation.urllib3 import URLLib3Instrumentor

        URLLib3Instrumentor().instrument()
        instrumented_libraries.append("urllib3")
    except Exception:
        pass

    try:
        _instrument_sqlite3(trace.get_tracer("phosphor.collector.sqlite3"))
        instrumented_libraries.append("sqlite3")
    except Exception:
        pass

    # --- viztracer setup (also not traced by itself until .start() below) ---
    from viztracer import VizTracer

    tracer = VizTracer(output_file=viztracer_out_path, verbose=0)

    # --- run the actual target script, traced ---
    run_error: str | None = None
    script_dir = os.path.dirname(os.path.abspath(target_script))
    if script_dir not in sys.path:
        sys.path.insert(0, script_dir)
    sys.argv = [target_script]

    error_tracer = trace.get_tracer("phosphor.collector.errors")

    # --- background memory sampler setup. threading.Thread.start() itself
    # (not just _sample_memory_loop's own body) is a real Python-level call
    # with its own internal machinery (CPython's Thread.start()
    # unconditionally waits on an internal threading.Event to confirm the
    # new OS thread actually began running) -- empirically confirmed, this
    # gets captured by viztracer as real function_call nodes/edges if it
    # runs while the tracer is active, exactly like anything else running on
    # any thread during that window. So the thread is started here, BEFORE
    # tracer.start() below, not "right before tracer.start()" as a
    # decoration -- deliberately outside the traced window, same reasoning
    # as the OTel SDK setup earlier in this function (see module docstring).
    # The thread's own loop keeps running throughout runpy.run_path below
    # regardless of exactly when .start() was called, so sampling still
    # covers the target script's real execution window; only the one-time
    # startup bookkeeping is moved out from under viztracer. See
    # _sample_memory_loop's docstring for the matching design choice inside
    # the loop body itself (plain list[bool] + time.sleep, not
    # threading.Event, for the same reason). ---
    memory_samples: list[dict] = []
    stop_memory_sampler: list[bool] = [False]
    memory_sampler_thread = threading.Thread(
        target=_sample_memory_loop,
        args=(os.getpid(), stop_memory_sampler, memory_samples),
        daemon=True,
        name="phosphor-memory-sampler",
    )
    memory_sampler_thread.start()

    tracer.start()
    try:
        runpy.run_path(target_script, run_name="__main__")
    except SystemExit as exc:
        if exc.code not in (None, 0):
            run_error = f"target script called sys.exit({exc.code!r})"
            _emit_error_span(error_tracer, "SystemExit", run_error, None)
    except BaseException as exc:  # noqa: BLE001 - capture *anything* the target raises
        run_error = f"{type(exc).__name__}: {exc}"
        _emit_error_span(error_tracer, type(exc).__name__, str(exc), traceback.format_exc())
    finally:
        # tracer.stop()/tracer.save() first, completely unchanged from
        # before this sampler existed -- this finally block gets new
        # statements APPENDED after them, never reordered or interleaved
        # with them, so the existing viztracer stop/save behavior this
        # bootstrap's exit-code contract depends on is untouched.
        tracer.stop()
        tracer.save(output_file=viztracer_out_path)

        # Stop+join the sampler only now, after tracer.stop() -- so
        # Thread.join()'s own internal machinery (like Thread.start()'s,
        # see the setup comment above) is never captured by viztracer
        # either, for the same reason. The sampler's loop has already been
        # running throughout runpy.run_path above regardless of this
        # timing; stopping it a few milliseconds later than "immediately"
        # costs nothing real.
        stop_memory_sampler[0] = True
        memory_sampler_thread.join(timeout=1.0)

    # --- dump OTel spans regardless of how the target script finished ---
    provider.force_flush()
    spans = [_span_to_dict(s) for s in exporter.get_finished_spans()]
    payload = {
        "trace_id": collector_trace_id,
        "instrumented_libraries": instrumented_libraries,
        "spans": spans,
        "error": run_error,
    }
    with open(otel_out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, default=str)

    # --- dump memory samples regardless of how the target script finished
    # (same "always write" discipline as the OTel spans dump above) ---
    memory_payload = {
        "trace_id": collector_trace_id,
        "samples": memory_samples,
    }
    with open(memory_samples_out_path, "w", encoding="utf-8") as f:
        json.dump(memory_payload, f)

    if run_error is not None:
        sys.stderr.write(run_error + "\n")
        sys.exit(1)


if __name__ == "__main__":
    main()

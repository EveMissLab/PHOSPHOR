"""Unit tests for phosphor_trace.normalize.

These run the real phosphor_collector.collect() pipeline against demo
scripts under demo_targets/ -- no mocking of viztracer, OpenTelemetry, or
the collector's output -- then feed the real result into normalize() and
check the resulting TraceEvent list. For the network-call test we spin up
our own local http.server in a background thread so the test is fully
offline and deterministic (no real external network access).
"""

from __future__ import annotations

import http.server
import threading
import uuid
from pathlib import Path

import pytest

from phosphor_collector.collect import collect
from phosphor_trace.normalize import CollectionFailedError, _reconstruct_call_stacks, normalize
from phosphor_trace.schema import Evidence, EvidenceLevel, RuntimeContext, SourceLocation, TraceEvent

REPO_ROOT = Path(__file__).resolve().parent.parent
DEMO_TARGETS = REPO_ROOT / "demo_targets"
HELLO_SCRIPT = DEMO_TARGETS / "hello_trace.py"
HTTP_SCRIPT = DEMO_TARGETS / "http_call.py"
DB_SCRIPT = DEMO_TARGETS / "db_bound.py"
ERROR_SCRIPT = DEMO_TARGETS / "error_case.py"
IO_BOUND_SCRIPT = DEMO_TARGETS / "io_bound.py"


def _new_trace_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


class _EchoHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802 - stdlib method name
        body = b"hello from local test server"
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format, *args):  # noqa: A002 - silence stdlib default logging
        pass


class _LocalServer:
    """A tiny local HTTP server run in a background thread, offline-only."""

    def __init__(self) -> None:
        self._httpd = http.server.HTTPServer(("127.0.0.1", 0), _EchoHandler)
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self._thread.start()
        host, port = self._httpd.server_address
        return f"http://{host}:{port}/"

    def __exit__(self, *exc_info) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        self._thread.join(timeout=5)


def _assert_common_invariants(events: list[TraceEvent], trace_id: str) -> None:
    assert len(events) > 0

    event_ids = [e.event_id for e in events]
    assert len(event_ids) == len(set(event_ids)), "event_ids must all be unique"

    timestamps = [e.timestamp for e in events]
    assert timestamps == sorted(timestamps), "events must be sorted by timestamp"

    for event in events:
        assert event.trace_id == trace_id
        assert event.evidence.level == EvidenceLevel.OBSERVED
        assert event.evidence.confidence == 1.0
        # Every event must round-trip through the schema unchanged (proves
        # normalize() only ever emits real TraceEvent instances, not dicts
        # or some near-miss shape).
        assert isinstance(event, TraceEvent)


def test_normalize_hello_trace_produces_observed_function_calls(tmp_path):
    trace_id = _new_trace_id("norm-hello")

    result = collect(
        script_path=str(HELLO_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=60,
    )
    assert result["error"] is None, f"unexpected collector error: {result['error']}"

    events = normalize(result, trace_id)

    _assert_common_invariants(events, trace_id)

    function_events = [e for e in events if e.type == "function_call"]
    assert len(function_events) > 0

    # At least one function_call event must have a real source file/line
    # (i.e. actually pointing into hello_trace.py, not a "<builtin>" event).
    real_source_events = [
        e for e in function_events if e.source.file != "<builtin>" and e.source.line is not None
    ]
    assert len(real_source_events) > 0
    names = {e.source.function for e in real_source_events}
    assert "add" in names
    assert "greet" in names
    for e in real_source_events:
        assert isinstance(e.source.line, int)
        assert e.runtime.pid > 0
        assert e.runtime.tid > 0

    # Events actually sourced from hello_trace.py itself (a strict subset of
    # real_source_events -- viztracer also captures frozen-stdlib frames like
    # "<frozen runpy>"/"<frozen importlib._bootstrap>", which have a real
    # (file:line) suffix and thus aren't "<builtin>", but aren't on-disk
    # files either -- see the module-level note in the test file).
    own_script_events = [e for e in real_source_events if e.source.file.endswith("hello_trace.py")]
    assert len(own_script_events) > 0
    own_names = {e.source.function for e in own_script_events}
    assert "add" in own_names
    assert "greet" in own_names

    # hello_trace.py makes no HTTP calls -> no network_request events.
    assert not any(e.type == "network_request" for e in events)

    # Builtin/no-file-line events (e.g. "builtins.print") must still be
    # well-formed per the documented fallback.
    builtin_events = [e for e in function_events if e.source.file == "<builtin>"]
    assert len(builtin_events) > 0
    for e in builtin_events:
        assert e.source.line is None
        assert e.source.function == e.source.file or e.source.function  # non-empty


def test_normalize_http_call_produces_observed_network_request(tmp_path):
    trace_id = _new_trace_id("norm-http")

    with _LocalServer() as base_url:
        import os

        env_backup = os.environ.get("PHOSPHOR_DEMO_URL")
        os.environ["PHOSPHOR_DEMO_URL"] = base_url
        try:
            result = collect(
                script_path=str(HTTP_SCRIPT),
                trace_id=trace_id,
                out_dir=str(tmp_path),
                max_events=20000,
                timeout_s=60,
            )
        finally:
            if env_backup is None:
                os.environ.pop("PHOSPHOR_DEMO_URL", None)
            else:
                os.environ["PHOSPHOR_DEMO_URL"] = env_backup

    assert result["error"] is None, f"unexpected collector error: {result['error']}"

    events = normalize(result, trace_id)
    _assert_common_invariants(events, trace_id)

    network_events = [e for e in events if e.type == "network_request"]
    assert len(network_events) > 0, (
        "expected at least one OTel-derived network_request event from the "
        "instrumented requests.get() call"
    )

    for e in network_events:
        assert e.source.file == "<network>"
        assert e.resource is not None
        # requests instrumentation should surface at least one http.* attribute.
        assert any(k.startswith("http.") for k in e.resource)
        # every resource value must already be a plain string (schema requires
        # dict[str, str] and does not coerce ints/bools implicitly).
        for value in e.resource.values():
            assert isinstance(value, str)

    function_events = [e for e in events if e.type == "function_call"]
    assert len(function_events) > 0
    real_source_events = [
        e for e in function_events if e.source.file != "<builtin>" and e.source.line is not None
    ]
    assert len(real_source_events) > 0


def test_normalize_db_bound_produces_observed_db_query_events(tmp_path):
    trace_id = _new_trace_id("norm-db")

    result = collect(
        script_path=str(DB_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=50000,
        timeout_s=60,
    )
    assert result["error"] is None, f"unexpected collector error: {result['error']}"

    events = normalize(result, trace_id)
    _assert_common_invariants(events, trace_id)

    db_events = [e for e in events if e.type == "db_query"]
    # db_bound.py runs: 1 CREATE + 1 executemany INSERT + 1 COUNT + 20
    # per-user SELECTs (see its own USER_COUNT) = 23 real sqlite3 queries.
    assert len(db_events) == 23, (
        f"expected 23 real db_query events (1 CREATE + 1 executemany + "
        f"1 COUNT + 20 SELECTs), got {len(db_events)} -- demo script or "
        f"collector behavior may have changed"
    )

    for e in db_events:
        assert e.source.file == "<database>"
        assert e.evidence.level == EvidenceLevel.OBSERVED
        assert e.evidence.confidence == 1.0
        assert e.resource is not None
        # every resource value must already be a plain string (schema
        # requires dict[str, str] and does not coerce ints/bools implicitly).
        for value in e.resource.values():
            assert isinstance(value, str)
        # the real, observed attribute names this project's own
        # _instrument_sqlite3 (phosphor_collector/_otel_bootstrap.py) emits --
        # see that function's docstring for why no off-the-shelf DB-API
        # instrumentor was used instead.
        assert e.resource["db.system"] == "sqlite"
        assert e.resource["db.name"].endswith(".sqlite3")
        assert "db.statement" in e.resource
        assert e.resource["db.operation"] in ("execute", "executemany")

    # must NOT be misclassified as network_request -- the whole point of
    # this normalization path is to split db_query out from it.
    assert not any(e.type == "network_request" for e in db_events)

    statements = {e.resource["db.statement"] for e in db_events}
    assert any("CREATE TABLE" in s for s in statements)
    assert any("INSERT INTO users" in s for s in statements)
    assert any("SELECT COUNT" in s for s in statements)
    assert any("SELECT id, name, email FROM users WHERE id = ?" in s for s in statements)

    # the N+1-style SELECT loop must appear as 20 distinct real db_query
    # events (raw, per-event level -- aggregation into one edge is
    # build_graph's job, verified in tests/test_graph.py).
    select_events = [
        e for e in db_events
        if e.resource["db.statement"] == "SELECT id, name, email FROM users WHERE id = ?"
    ]
    assert len(select_events) == 20

    function_events = [e for e in events if e.type == "function_call"]
    assert len(function_events) > 0
    own_script_events = [
        e for e in function_events if e.source.file.endswith("db_bound.py")
    ]
    assert len(own_script_events) > 0
    own_names = {e.source.function for e in own_script_events}
    assert "fetch_user" in own_names
    assert "create_schema" in own_names


def test_normalize_io_bound_produces_observed_memory_sample_events(tmp_path):
    """io_bound.py makes 21 real HTTP round trips (see that demo target's
    module docstring) -- enough real wall-clock time for the background
    memory sampler (~50ms period, see _otel_bootstrap._sample_memory_loop)
    to take several real ticks, confirmed already in
    tests/test_collector.py::test_collect_produces_real_nonzero_memory_samples.
    This test confirms the SAME real collect() output normalizes correctly
    into type="memory_sample" TraceEvents.
    """
    trace_id = _new_trace_id("norm-memory")

    result = collect(
        script_path=str(IO_BOUND_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=30,
    )
    assert result["error"] is None, f"unexpected collector error: {result['error']}"

    events = normalize(result, trace_id)
    _assert_common_invariants(events, trace_id)

    memory_events = [e for e in events if e.type == "memory_sample"]
    assert len(memory_events) >= 2, (
        f"expected several real memory_sample events (io_bound.py's 21 real "
        f"HTTP round trips give the ~50ms sampler several ticks), got "
        f"{len(memory_events)}"
    )

    for e in memory_events:
        assert e.source.file == "<memory>"
        assert e.source.line is None
        assert e.source.function == "memory.sample"
        # Deliberately never linked into the call-stack reconstruction (see
        # _normalize_memory_samples's docstring) -- a memory sample is a
        # background measurement, not "called by" anything on the stack.
        assert e.parent_event is None
        assert e.evidence.level == EvidenceLevel.OBSERVED
        assert e.evidence.confidence == 1.0
        assert e.resource is not None
        assert set(e.resource.keys()) == {"memory.rss_bytes", "memory.vms_bytes"}
        for value in e.resource.values():
            assert isinstance(value, str)
        # real, plausible psutil readings -- never placeholder/zero values.
        assert int(e.resource["memory.rss_bytes"]) > 1_000_000
        assert int(e.resource["memory.vms_bytes"]) > 1_000_000
        assert e.runtime.pid > 0
        assert e.runtime.tid > 0

    # memory_sample events reuse the same main-thread (pid, tid) fallback
    # network_request events use (see _normalize_memory_samples's docstring
    # on why -- a memory sample is process-wide, not thread-specific).
    function_events = [e for e in events if e.type == "function_call"]
    real_pids = {e.runtime.pid for e in function_events}
    assert {e.runtime.pid for e in memory_events} <= real_pids


def test_normalize_raises_on_collector_error(tmp_path):
    trace_id = _new_trace_id("norm-missing")

    result = collect(
        script_path=str(DEMO_TARGETS / "does_not_exist.py"),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=60,
    )
    assert result["error"] is not None

    with pytest.raises(CollectionFailedError):
        normalize(result, trace_id)


def _mk_event(
    event_id: str,
    timestamp: float,
    duration_ms: float | None,
    *,
    type: str = "function_call",  # noqa: A002 - matches TraceEvent field name
    function: str = "f",
    pid: int = 1,
    tid: int = 1,
    parent_event: str | None = None,
) -> TraceEvent:
    return TraceEvent(
        event_id=event_id,
        trace_id="t",
        timestamp=timestamp,
        type=type,
        source=SourceLocation(file="demo.py", line=1, function=function),
        runtime=RuntimeContext(pid=pid, tid=tid),
        duration_ms=duration_ms,
        parent_event=parent_event,
        evidence=Evidence(level=EvidenceLevel.OBSERVED, confidence=1.0),
    )


def test_reconstruct_call_stacks_nests_events_within_one_thread():
    # main() [0, 100)ms  ->  add() [10, 20)ms, greet() [30, 90)ms -> print() [40, 50)ms
    main = _mk_event("main", 0.0, 100.0, function="main")
    add = _mk_event("add", 0.010, 10.0, function="add")
    greet = _mk_event("greet", 0.030, 60.0, function="greet")
    inner_print = _mk_event("print", 0.040, 10.0, function="print")
    events = [main, add, greet, inner_print]

    _reconstruct_call_stacks(events)

    assert main.parent_event is None
    assert add.parent_event == "main"
    assert greet.parent_event == "main"
    assert inner_print.parent_event == "greet"


def test_reconstruct_call_stacks_never_links_across_threads():
    # Two function_call events on DIFFERENT tids whose intervals overlap in
    # wall-clock time must never be linked -- concurrent overlap across
    # threads does not imply a caller/callee relationship.
    thread1 = _mk_event("t1-outer", 0.0, 100.0, function="outer", tid=1)
    thread2 = _mk_event("t2-inner", 0.010, 10.0, function="inner", tid=2)
    events = [thread1, thread2]

    _reconstruct_call_stacks(events)

    assert thread1.parent_event is None
    assert thread2.parent_event is None


def test_reconstruct_call_stacks_never_overrides_existing_parent_event():
    # A network_request event that already has a parent_event set (e.g. from
    # genuine OTel parent_span_id chaining) must keep that link, not have it
    # overwritten by interval-nesting even though it falls inside main()'s
    # interval too.
    main = _mk_event("main", 0.0, 100.0, function="main")
    otel_linked = _mk_event(
        "span-child", 0.020, 5.0, type="network_request", function="GET",
        parent_event="span-parent-from-otel",
    )
    events = [main, otel_linked]

    _reconstruct_call_stacks(events)

    assert otel_linked.parent_event == "span-parent-from-otel"


def test_reconstruct_call_stacks_pops_sibling_frames_correctly():
    # main() [0, 100)ms -> a() [10, 20)ms, b() [30, 40)ms -- siblings, both
    # children of main, NOT nested in each other.
    main = _mk_event("main", 0.0, 100.0, function="main")
    a = _mk_event("a", 0.010, 10.0, function="a")
    b = _mk_event("b", 0.030, 10.0, function="b")
    events = [main, a, b]

    _reconstruct_call_stacks(events)

    assert a.parent_event == "main"
    assert b.parent_event == "main"


def test_normalize_hello_trace_populates_real_parent_event_linkage(tmp_path):
    trace_id = _new_trace_id("norm-parent")

    result = collect(
        script_path=str(HELLO_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=60,
    )
    assert result["error"] is None

    events = normalize(result, trace_id)
    by_id = {e.event_id: e for e in events}

    own_script_events = [
        e for e in events
        if e.type == "function_call" and e.source.file.endswith("hello_trace.py")
    ]
    add_events = [e for e in own_script_events if e.source.function == "add"]
    greet_events = [e for e in own_script_events if e.source.function == "greet"]
    assert add_events and greet_events

    # add() and greet() are both called directly from main() in
    # hello_trace.py -- their real parent_event, resolved back through the
    # same event list, must point at a "main" function_call event.
    for e in [*add_events, *greet_events]:
        assert e.parent_event is not None, (
            f"{e.source.function} at {e.event_id} has no parent_event -- "
            "interval-nesting reconstruction did not link it"
        )
        parent = by_id[e.parent_event]
        assert parent.type == "function_call"
        assert parent.source.function == "main"


def test_normalize_event_ids_stable_and_unique_across_calls(tmp_path):
    trace_id = _new_trace_id("norm-stable")

    result = collect(
        script_path=str(HELLO_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=60,
    )
    assert result["error"] is None

    events_a = normalize(result, trace_id)
    events_b = normalize(result, trace_id)

    # Each call independently produces unique ids (and, since it's the same
    # deterministic generation scheme applied to the same input, the same
    # ids both times -- "stable" within repeated normalization of one
    # unchanged collector_result).
    assert [e.event_id for e in events_a] == [e.event_id for e in events_b]
    assert len(events_a) == len(events_b)


def test_normalize_error_case_does_not_raise_despite_collector_error(tmp_path):
    """The real collector reports an error (the subprocess exits non-zero,
    same as it always has -- see _otel_bootstrap.py's preserved exit-code
    contract), but that must no longer be fatal to normalize(): the target
    script's real, uncaught ZeroDivisionError was gracefully captured as
    data, not lost.
    """
    trace_id = _new_trace_id("norm-error")

    result = collect(
        script_path=str(ERROR_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=30,
    )
    # error_case.py deliberately crashes -- collect() must still report this
    # via its existing, unchanged exit-code contract.
    assert result["error"] is not None
    assert "subprocess exited with code" in result["error"]

    events = normalize(result, trace_id)  # must NOT raise CollectionFailedError
    _assert_common_invariants(events, trace_id)
    assert len(events) > 100  # real trace, not a stub


def test_normalize_error_case_produces_uncaught_exception_error_event(tmp_path):
    trace_id = _new_trace_id("norm-error-uncaught")

    result = collect(
        script_path=str(ERROR_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=30,
    )
    events = normalize(result, trace_id)

    error_events = [e for e in events if e.type == "error"]
    assert len(error_events) == 2, (
        f"expected exactly 2 error events (1 recovered bad db_query + 1 "
        f"uncaught top-level exception), got {len(error_events)}"
    )

    uncaught = [e for e in error_events if e.source.file == "<error>"]
    assert len(uncaught) == 1
    uncaught_event = uncaught[0]

    # Real, specific detail -- not just "an error happened".
    assert uncaught_event.evidence.level == EvidenceLevel.OBSERVED
    assert uncaught_event.evidence.confidence == 1.0
    assert uncaught_event.resource is not None
    assert uncaught_event.resource["exception.type"] == "ZeroDivisionError"
    assert uncaught_event.resource["exception.message"] in {
        "division by zero", "integer division or modulo by zero",
    }
    assert "error_case.py" in uncaught_event.resource["exception.stacktrace"]
    assert "crash" in uncaught_event.resource["exception.stacktrace"]
    assert uncaught_event.resource["otel.status_code"] == "ERROR"
    for value in uncaught_event.resource.values():
        assert isinstance(value, str)


def test_normalize_error_case_produces_failed_db_query_error_event(tmp_path):
    trace_id = _new_trace_id("norm-error-db")

    result = collect(
        script_path=str(ERROR_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=30,
    )
    events = normalize(result, trace_id)

    error_events = [e for e in events if e.type == "error"]
    db_error = [e for e in error_events if e.source.file == "<database>"]
    assert len(db_error) == 1
    event = db_error[0]

    # Kept its full db_query identity -- a failed query is still specifically
    # a database-query failure, not a generic error.
    assert event.resource["db.system"] == "sqlite"
    assert event.resource["db.statement"] == "SELECT price FROM items"
    assert event.resource["db.operation"] == "execute"
    # Real, specific exception detail on top of the db_query identity.
    assert event.resource["exception.type"] == "OperationalError"
    assert "no such column" in event.resource["exception.message"]
    assert event.evidence.level == EvidenceLevel.OBSERVED

    # The successful queries before the bad one must NOT be misclassified as
    # errors -- only the genuinely failed one is.
    db_events = [e for e in events if e.type == "db_query"]
    assert len(db_events) == 2
    statements = {e.resource["db.statement"] for e in db_events}
    assert any("CREATE TABLE" in s for s in statements)
    assert any("INSERT INTO items" in s for s in statements)
    for e in db_events:
        assert e.resource.get("otel.status_code") != "ERROR"


def test_normalize_error_case_preserves_events_before_the_failure(tmp_path):
    """One real failure must never corrupt or truncate the rest of the
    trace: every function_call/db_query event genuinely captured before
    (and, for the recovered db_query failure, also after) the failure must
    still be present and well-formed.
    """
    trace_id = _new_trace_id("norm-error-before")

    result = collect(
        script_path=str(ERROR_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=30,
    )
    events = normalize(result, trace_id)
    _assert_common_invariants(events, trace_id)

    own_script_events = [
        e for e in events if e.type == "function_call" and e.source.file.endswith("error_case.py")
    ]
    own_names = {e.source.function for e in own_script_events}
    # setup_database/run_bad_query ran before the recovered db failure;
    # compute_after_recovered_failure ran after it (and before the fatal
    # crash); crash itself is the function whose call is captured even
    # though it never returns normally (viztracer's "X" event covers a
    # call's [entry, exit-however-it-happened] interval).
    for expected in (
        "setup_database",
        "run_bad_query",
        "compute_after_recovered_failure",
        "crash",
    ):
        assert expected in own_names, f"{expected} missing from captured function_call events"

    # The two successful db_query events (CREATE + INSERT, both before the
    # recovered failure) are present and well-formed, not corrupted.
    db_events = [e for e in events if e.type == "db_query"]
    assert len(db_events) == 2
    for e in db_events:
        assert e.evidence.level == EvidenceLevel.OBSERVED
        assert e.resource is not None
        for value in e.resource.values():
            assert isinstance(value, str)


def test_normalize_error_case_builds_into_graph_without_crashing(tmp_path):
    """build_graph() must handle type="error" events gracefully (they are
    simply not yet wired into node/edge production -- out of this phase's
    scope) rather than raising on an event type it doesn't special-case.
    """
    from phosphor_graph.build import build_graph

    trace_id = _new_trace_id("norm-error-graph")

    result = collect(
        script_path=str(ERROR_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=30,
    )
    events = normalize(result, trace_id)

    graph = build_graph(events, trace_id)  # must not raise
    assert len(graph.nodes) > 0
    assert len(graph.edges) > 0

"""Unit tests for phosphor_collector.collect.

These run the real viztracer + OpenTelemetry pipeline against trivial demo
scripts under demo_targets/ -- no mocking of viztracer or OTel, since the
whole point of this module is that its output is real, evidence-grounded
trace data.
"""

from __future__ import annotations

import json
import time
import uuid
from pathlib import Path

from phosphor_collector.collect import collect

REPO_ROOT = Path(__file__).resolve().parent.parent
DEMO_TARGETS = REPO_ROOT / "demo_targets"
HELLO_SCRIPT = DEMO_TARGETS / "hello_trace.py"
SLEEP_SCRIPT = DEMO_TARGETS / "sleep_forever.py"
ERROR_SCRIPT = DEMO_TARGETS / "error_case.py"
IO_BOUND_SCRIPT = DEMO_TARGETS / "io_bound.py"


def _new_trace_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def test_collect_produces_two_parseable_json_files(tmp_path):
    trace_id = _new_trace_id("hello")

    result = collect(
        script_path=str(HELLO_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=60,
    )

    assert result["error"] is None, f"unexpected error: {result['error']}"
    assert result["trace_id"] == trace_id
    assert result["truncated"] is False

    viztracer_path = Path(result["viztracer_path"])
    otel_spans_path = Path(result["otel_spans_path"])

    # Files actually exist on disk.
    assert viztracer_path.is_file()
    assert otel_spans_path.is_file()

    # Non-empty.
    assert viztracer_path.stat().st_size > 0
    assert otel_spans_path.stat().st_size > 0

    # Both parse as JSON.
    viz_data = json.loads(viztracer_path.read_text(encoding="utf-8"))
    otel_data = json.loads(otel_spans_path.read_text(encoding="utf-8"))

    # Raw viztracer Chrome-trace-format shape.
    assert "traceEvents" in viz_data
    assert isinstance(viz_data["traceEvents"], list)
    assert len(viz_data["traceEvents"]) > 0

    x_events = [e for e in viz_data["traceEvents"] if e.get("ph") == "X"]
    assert len(x_events) > 0
    assert result["event_count"] == len(x_events)

    # We expect to see our own demo functions show up by name somewhere in
    # the captured events (proves it's really tracing our script, not just
    # producing an empty shell).
    names = " ".join(e.get("name", "") for e in x_events)
    assert "add" in names
    assert "greet" in names

    # Each X event has the fields the next module (phosphor_trace) needs.
    for e in x_events[:5]:
        assert "name" in e
        assert "ts" in e
        assert "dur" in e
        assert "pid" in e
        assert "tid" in e

    # Raw OTel spans shape.
    assert "spans" in otel_data
    assert isinstance(otel_data["spans"], list)
    assert "instrumented_libraries" in otel_data
    assert "error" in otel_data
    assert otel_data.get("trace_id") == trace_id
    # hello_trace.py makes no HTTP calls, so we expect zero captured spans --
    # but the file itself must still be well-formed and non-empty (i.e. the
    # {"spans": [], ...} envelope, not a truncated/missing file).
    assert otel_data["spans"] == []
    assert otel_data["error"] is None


def test_collect_truncates_when_max_events_is_low(tmp_path):
    trace_id = _new_trace_id("truncate")

    result = collect(
        script_path=str(HELLO_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=2,
        timeout_s=60,
    )

    assert result["error"] is None, f"unexpected error: {result['error']}"
    assert result["truncated"] is True
    assert result["event_count"] == 2

    viztracer_path = Path(result["viztracer_path"])
    assert viztracer_path.is_file()

    viz_data = json.loads(viztracer_path.read_text(encoding="utf-8"))
    x_events = [e for e in viz_data["traceEvents"] if e.get("ph") == "X"]
    assert len(x_events) == 2

    # Truncation must keep the *earliest* events, chronologically by ts.
    ts_values = [e["ts"] for e in x_events]
    assert ts_values == sorted(ts_values)


def test_collect_does_not_truncate_when_under_budget(tmp_path):
    trace_id = _new_trace_id("nobudget")

    result = collect(
        script_path=str(HELLO_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=60,
    )

    assert result["error"] is None
    assert result["truncated"] is False
    assert result["event_count"] > 2


def test_collect_reports_error_for_missing_script(tmp_path):
    trace_id = _new_trace_id("missing")

    result = collect(
        script_path=str(DEMO_TARGETS / "does_not_exist.py"),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=60,
    )

    assert result["error"] is not None
    assert "does not exist" in result["error"]
    assert result["event_count"] == 0
    assert result["truncated"] is False
    # Paths are still deterministically populated even though nothing was written.
    assert result["viztracer_path"].endswith(f"{trace_id}.viztracer.json")
    assert result["otel_spans_path"].endswith(f"{trace_id}.otel_spans.json")


def test_collect_kills_subprocess_and_reports_timeout(tmp_path):
    trace_id = _new_trace_id("timeout")
    started = time.monotonic()

    result = collect(
        script_path=str(SLEEP_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=2,
    )

    elapsed = time.monotonic() - started

    assert result["error"] is not None
    assert "timed out" in result["error"].lower()
    # Should not have hung anywhere near the script's real 30s sleep.
    assert elapsed < 25


def test_collect_still_writes_both_artifacts_when_target_script_crashes(tmp_path):
    """error_case.py deliberately crashes (an uncaught ZeroDivisionError).
    collect()'s existing exit-code contract is unchanged by that (see
    _otel_bootstrap.py's module docstring): the subprocess still exits
    non-zero and result["error"] is still set -- but _otel_bootstrap.py now
    still writes both output artifacts fully, including a real ERROR-status
    span for the crash, rather than losing them.
    """
    trace_id = _new_trace_id("error-case")
    started = time.monotonic()

    result = collect(
        script_path=str(ERROR_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=30,
    )

    elapsed = time.monotonic() - started
    assert elapsed < 10  # error_case.py itself promises well under 10s

    assert result["error"] is not None
    assert result["error"].startswith("subprocess exited with code")
    assert "ZeroDivisionError" in result["error"]

    viztracer_path = Path(result["viztracer_path"])
    otel_spans_path = Path(result["otel_spans_path"])
    assert viztracer_path.is_file() and viztracer_path.stat().st_size > 0
    assert otel_spans_path.is_file() and otel_spans_path.stat().st_size > 0

    viz_data = json.loads(viztracer_path.read_text(encoding="utf-8"))
    x_events = [e for e in viz_data["traceEvents"] if e.get("ph") == "X"]
    assert len(x_events) > 0
    assert result["event_count"] == len(x_events)
    names = " ".join(e.get("name", "") for e in x_events)
    assert "setup_database" in names
    assert "crash" in names

    otel_data = json.loads(otel_spans_path.read_text(encoding="utf-8"))
    assert otel_data["error"] is not None
    assert "ZeroDivisionError" in otel_data["error"]
    assert len(otel_data["spans"]) > 0

    error_spans = [s for s in otel_data["spans"] if s.get("status_code") == "ERROR"]
    # 1 recovered bad db_query span + 1 top-level uncaught-exception span.
    assert len(error_spans) == 2
    uncaught_spans = [s for s in error_spans if s.get("name") == "phosphor.uncaught_exception"]
    assert len(uncaught_spans) == 1
    assert uncaught_spans[0]["attributes"]["exception.type"] == "ZeroDivisionError"


def test_collect_produces_real_nonzero_memory_samples(tmp_path):
    """io_bound.py makes 21 real HTTP round trips against its own local
    server (see that demo target's module docstring) -- enough real
    wall-clock time for the background memory sampler
    (_otel_bootstrap._sample_memory_loop, ~50ms period) to take several
    samples, not just zero or one.
    """
    trace_id = _new_trace_id("memsamples")

    result = collect(
        script_path=str(IO_BOUND_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=30,
    )

    assert result["error"] is None, f"unexpected error: {result['error']}"
    assert "memory_samples_path" in result

    memory_samples_path = Path(result["memory_samples_path"])
    assert memory_samples_path.is_file()
    assert memory_samples_path.stat().st_size > 0

    memory_data = json.loads(memory_samples_path.read_text(encoding="utf-8"))
    assert memory_data["trace_id"] == trace_id
    assert "samples" in memory_data
    samples = memory_data["samples"]
    assert isinstance(samples, list)

    # io_bound.py's real HTTP round trips take long enough (loopback, but 21
    # of them) that the ~50ms-period sampler should get several real ticks
    # in, not just zero or one.
    assert len(samples) >= 2, f"expected several real memory samples, got {len(samples)}"

    for sample in samples:
        assert set(sample.keys()) == {"timestamp_unix", "rss_bytes", "vms_bytes"}
        assert isinstance(sample["timestamp_unix"], float)
        assert isinstance(sample["rss_bytes"], int)
        assert isinstance(sample["vms_bytes"], int)
        # Real process memory for even a trivial Python process is always
        # well above zero -- these must be genuine psutil readings, never
        # placeholder/zero values.
        assert sample["rss_bytes"] > 1_000_000
        assert sample["vms_bytes"] > 1_000_000

    # Timestamps are real wall-clock time.time() values, taken in
    # nondecreasing order (the sampler appends strictly sequentially from a
    # single thread).
    timestamps = [s["timestamp_unix"] for s in samples]
    assert timestamps == sorted(timestamps)


def test_collect_memory_sampler_does_not_crash_on_trivial_script(tmp_path):
    """hello_trace.py finishes in a handful of milliseconds. The background
    memory sampler thread may get zero or very few samples in before it's
    stopped -- that must not crash collect() or leave a malformed/missing
    memory_samples_path file (see _otel_bootstrap._sample_memory_loop's
    docstring: zero samples is an accepted, valid outcome).
    """
    trace_id = _new_trace_id("memtrivial")

    result = collect(
        script_path=str(HELLO_SCRIPT),
        trace_id=trace_id,
        out_dir=str(tmp_path),
        max_events=20000,
        timeout_s=60,
    )

    assert result["error"] is None, f"unexpected error: {result['error']}"

    memory_samples_path = Path(result["memory_samples_path"])
    assert memory_samples_path.is_file()

    memory_data = json.loads(memory_samples_path.read_text(encoding="utf-8"))
    assert memory_data["trace_id"] == trace_id
    assert isinstance(memory_data["samples"], list)
    # Zero or a handful -- either is fine, just must be a well-formed list,
    # never absent or malformed.
    for sample in memory_data["samples"]:
        assert sample["rss_bytes"] > 0
        assert sample["vms_bytes"] > 0

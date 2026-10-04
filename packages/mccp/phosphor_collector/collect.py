"""phosphor_collector.collect -- run a target script under viztracer + OpenTelemetry.

This module is the very first stage of the PHOSPHOR MCCP pipeline. It knows
nothing about the canonical ``TraceEvent`` schema in ``phosphor_trace.schema``
-- its only job is to run a script, capture two *raw* JSON artifacts on disk
(one from viztracer, one from an in-subprocess OpenTelemetry exporter), and
hand back a small manifest dict pointing at them. ``phosphor_trace`` is the
module responsible for normalizing those two raw shapes into ``TraceEvent``.

Launch mechanism: the target script is run in a single subprocess as
``python _otel_bootstrap.py <script> <viztracer_out> <otel_out>
<memory_samples_out> <trace_id>`` (``_otel_bootstrap.py`` lives alongside
this file). That bootstrap does the OpenTelemetry TracerProvider/
instrumentation setup, then uses viztracer's Python API (``VizTracer().
start()/.stop()/.save()``, equivalent in output format to ``python -m
viztracer -o ... <script>``) to trace only the target script's own execution
-- not the OTel SDK's own import graph -- while a background daemon thread
samples the subprocess's own real process memory (``psutil``) roughly every
50ms, before writing all three raw JSON files and exiting. See
``_otel_bootstrap.py`` for why (including exactly where the memory-sampler
thread starts/stops relative to the target script's execution).

Output contract (the ONLY interface downstream modules may rely on)
---------------------------------------------------------------------
``collect()`` returns a dict shaped exactly like::

    {
        "trace_id": str,
        "viztracer_path": str,       # path to the raw viztracer Chrome-trace JSON
        "otel_spans_path": str,      # path to the raw OTel spans JSON
        "memory_samples_path": str,  # path to the raw memory-samples JSON
        "truncated": bool,       # True if the viztracer event budget was hit
        "event_count": int,      # number of "X" (duration) events actually
                                  # present in the viztracer file after any
                                  # truncation -- this is what phosphor_trace
                                  # will iterate over
        "error": str | None,     # set on timeout / crash / unreadable output;
                                  # None on a clean run
    }

``viztracer_path``, ``otel_spans_path``, and ``memory_samples_path`` are
always populated with the deterministic on-disk location ``collect()``
intended to write (``<out_dir>/<trace_id>.viztracer.json``,
``<out_dir>/<trace_id>.otel_spans.json``, and
``<out_dir>/<trace_id>.memory_samples.json`` respectively), even in an error
path where the file may not have actually been written -- callers must check
``os.path.exists`` (or rely on ``error``) rather than assume presence.

Raw viztracer JSON shape (Chrome trace event format)
-----------------------------------------------------
Top level: ``{"traceEvents": [...], "viztracer_metadata": {...}, "file_info": {...}}``.

Each entry in ``traceEvents`` has a ``"ph"`` (phase) key:

- ``"M"`` -- metadata events (process_name / thread_name). No ``ts``/``dur``.
- ``"X"`` -- complete duration events. Has ``name``, ``ts`` (start, float
  microseconds), ``dur`` (float microseconds), ``pid``, ``tid``.

``name`` is ``"<function> (<absolute file path>:<lineno>)"`` for ordinary
Python functions, e.g. ``"add (C:\\...\\demo.py:2)"``. Builtins (e.g.
``builtins.print``) have no ``(file:line)`` suffix at all. To parse this:

    import re
    _NAME_RE = re.compile(r"^(.+) \\((.+):(\\d+)\\)$")
    m = _NAME_RE.match(event["name"])
    if m:
        func, file, line = m.group(1), m.group(2), int(m.group(3))
    else:
        func, file, line = event["name"], "<builtin>", None

This module truncates ``traceEvents`` in place (see ``truncated``/``event_count``
above) *only when the budget is exceeded* -- an under-budget run leaves the
viztracer file byte-for-byte as viztracer produced it.

Raw OTel spans JSON shape
---------------------------
Written by the in-subprocess bootstrap (``_otel_bootstrap.py``). Top level::

    {
        "trace_id": str | None,           # the collect() trace_id, for cross-reference
        "instrumented_libraries": [str],  # subset of ["requests", "urllib3", "sqlite3"]
                                           # that were actually importable/instrumented
                                           # in that subprocess
        "spans": [ ... ],
        "error": str | None,              # set if the target script raised/exited non-zero
    }

Each entry in ``spans``::

    {
        "name": str,
        "trace_id": str,               # 32 hex chars (OTel trace id)
        "span_id": str,                # 16 hex chars
        "parent_span_id": str | None,  # 16 hex chars, or None for a root span
        "kind": str,                   # e.g. "CLIENT", "INTERNAL"
        "start_time_unix_nano": int,
        "end_time_unix_nano": int,
        "duration_ms": float,
        "status_code": str,            # "UNSET" | "OK" | "ERROR"
        "status_description": str | None,
        "attributes": dict,            # OTel semantic-convention attrs, e.g.
                                        # http.method, http.url, http.status_code
    }

Note the OTel ``trace_id``/``span_id`` fields are OpenTelemetry's own
identifiers (hex strings), unrelated to the ``trace_id`` argument passed into
``collect()`` (which is PHOSPHOR's run identifier and is only carried along
in the top-level ``"trace_id"`` field for cross-reference).

Raw memory-samples JSON shape
--------------------------------
Written by the in-subprocess bootstrap's background sampler thread (see
``_otel_bootstrap.py``'s ``_sample_memory_loop``). Top level::

    {
        "trace_id": str | None,  # the collect() trace_id, for cross-reference
        "samples": [
            {
                "timestamp_unix": float,  # real time.time() at sample instant
                "rss_bytes": int,         # psutil Process.memory_info().rss
                "vms_bytes": int,         # psutil Process.memory_info().vms
            },
            ...
        ],
    }

``samples`` is a plain list of point-in-time readings, not an OTel span --
a memory sample has no duration, so forcing it into the span/duration model
the other two artifacts use would be a worse fit than this dedicated shape.
It can legitimately be empty (e.g. a target script that finishes in a
handful of milliseconds, before the sampler thread is ever scheduled) --
that is not itself an error condition.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from typing import Any

_BOOTSTRAP_SCRIPT = Path(__file__).parent / "_otel_bootstrap.py"


def collect(
    script_path: str,
    trace_id: str,
    out_dir: str,
    max_events: int = 20000,
    timeout_s: int = 60,
) -> dict[str, Any]:
    """Run ``script_path`` under viztracer + in-subprocess OTel, capture raw JSON.

    See the module docstring for the exact return shape and the exact shape
    of the two JSON files written to ``out_dir``.
    """
    out_dir_path = Path(out_dir)
    out_dir_path.mkdir(parents=True, exist_ok=True)

    viztracer_path = out_dir_path / f"{trace_id}.viztracer.json"
    otel_spans_path = out_dir_path / f"{trace_id}.otel_spans.json"
    memory_samples_path = out_dir_path / f"{trace_id}.memory_samples.json"

    result: dict[str, Any] = {
        "trace_id": trace_id,
        "viztracer_path": str(viztracer_path),
        "otel_spans_path": str(otel_spans_path),
        "memory_samples_path": str(memory_samples_path),
        "truncated": False,
        "event_count": 0,
        "error": None,
    }

    script = Path(script_path)
    if not script.is_file():
        result["error"] = f"script_path does not exist: {script_path}"
        return result

    if not _BOOTSTRAP_SCRIPT.is_file():
        result["error"] = f"internal error: bootstrap script missing at {_BOOTSTRAP_SCRIPT}"
        return result

    # Note: we invoke the bootstrap script directly with the plain interpreter,
    # NOT via `python -m viztracer -o ... <script>`. The bootstrap controls
    # viztracer itself (via VizTracer().start()/.stop()/.save(), see
    # _otel_bootstrap.py's module docstring) so that tracing only covers the
    # target script's own execution, not the OTel SDK's own (large) import
    # graph running beforehand in the same subprocess.
    cmd = [
        sys.executable,
        str(_BOOTSTRAP_SCRIPT),
        str(script.resolve()),
        str(viztracer_path),
        str(otel_spans_path),
        str(memory_samples_path),
        trace_id,
    ]

    try:
        proc = subprocess.run(
            cmd,
            timeout=timeout_s,
            capture_output=True,
            text=True,
        )
    except subprocess.TimeoutExpired:
        result["error"] = (
            f"collection timed out after {timeout_s}s running {script_path} "
            f"(subprocess killed)"
        )
        return result

    if proc.returncode != 0:
        stderr_tail = (proc.stderr or "").strip()[-2000:]
        result["error"] = f"subprocess exited with code {proc.returncode}: {stderr_tail}"
        # Fall through: even on a non-zero exit, the bootstrap's `finally`
        # block still writes the OTel spans file, and viztracer still writes
        # whatever it captured before the crash, so both may still be usable.

    truncated, event_count, viz_error = _enforce_event_budget(viztracer_path, max_events)
    result["truncated"] = truncated
    result["event_count"] = event_count
    if viz_error is not None and result["error"] is None:
        result["error"] = viz_error

    return result


def _enforce_event_budget(viztracer_path: Path, max_events: int) -> tuple[bool, int, str | None]:
    """Read the raw viztracer JSON, truncate traceEvents if over budget.

    Returns (truncated, event_count, error). ``event_count`` is the number of
    "X" (duration) events present in the file after truncation (or all of
    them, if under budget). Only rewrites the file when truncation actually
    happens -- an under-budget file is left exactly as viztracer wrote it.
    """
    if not viztracer_path.is_file():
        return False, 0, f"viztracer produced no output file at {viztracer_path}"

    try:
        with open(viztracer_path, "r", encoding="utf-8") as f:
            viz_data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        return False, 0, f"could not parse viztracer output at {viztracer_path}: {exc}"

    trace_events = viz_data.get("traceEvents", [])
    meta_events = [e for e in trace_events if e.get("ph") == "M"]
    x_events = [e for e in trace_events if e.get("ph") == "X"]
    other_events = [e for e in trace_events if e.get("ph") not in ("M", "X")]

    if len(x_events) <= max_events:
        return False, len(x_events), None

    x_events_sorted = sorted(x_events, key=lambda e: e.get("ts", 0.0))
    kept_x = x_events_sorted[:max_events]

    viz_data["traceEvents"] = meta_events + kept_x + other_events
    with open(viztracer_path, "w", encoding="utf-8") as f:
        json.dump(viz_data, f)

    return True, len(kept_x), None

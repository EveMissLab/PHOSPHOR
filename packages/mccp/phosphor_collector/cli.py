"""phosphor_collector.cli -- ``phosphor run <script_path>`` CLI entry point.

This is the installed console script (see ``pyproject.toml``'s
``[project.scripts]``: ``phosphor = "phosphor_collector.cli:app"``) as well
as the single place the collect -> normalize -> build_graph pipeline is
wired together end to end. ``phosphor_api.app`` imports ``run_pipeline``
(and ``PipelineError``/``default_traces_dir``) straight from this module
rather than re-implementing any of this -- the CLI and the ``POST
/api/traces`` endpoint run the literal same code path, never two
independently-maintained copies of the same pipeline.

Directory layout written by ``run_pipeline``
----------------------------------------------
``<traces_root>/<trace_id>/``, where ``traces_root`` defaults to ``./traces``
(relative to the current working directory) and can be overridden per call
or via the ``PHOSPHOR_TRACES_DIR`` environment variable::

    traces/<trace_id>/
        graph.json                    # ComputationalGraph, pydantic JSON
        events.json                   # list[TraceEvent], pydantic JSON array
        <trace_id>.viztracer.json     # raw viztracer trace (for the UI's
                                       # Perfetto embed) -- NOT copied here:
                                       # phosphor_collector.collect() is
                                       # pointed at this same trace_id
                                       # directory as its own out_dir, so the
                                       # raw trace lands directly at its
                                       # final location with zero duplication
        <trace_id>.otel_spans.json    # raw OTel spans, same reasoning

``graph_path``/``events_path``/``viztracer_path`` on the returned
``PipelineResult`` are the exact paths a caller (the API, the UI) should
read from -- no path reconstruction needed downstream.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import dataclass
from pathlib import Path

import typer

from phosphor_collector.collect import collect
from phosphor_graph.build import build_graph
from phosphor_trace.normalize import CollectionFailedError, normalize
from phosphor_trace.schema import ComputationalGraph, TraceEvent

logger = logging.getLogger(__name__)

app = typer.Typer(
    name="phosphor",
    help="PHOSPHOR MCCP: trace a real running Python script and build its computational graph.",
    no_args_is_help=True,
)


@app.callback()
def _main() -> None:
    """PHOSPHOR MCCP command-line interface.

    Registering this no-op callback is what keeps ``run`` a required
    subcommand (``phosphor run <script_path>``, per the task spec) instead
    of Typer's single-command shortcut, which collapses a Typer app that
    has exactly one registered command into a bare ``phosphor <script_path>``
    invocation with the subcommand name silently absorbed as the first
    positional argument -- confirmed by reading ``typer.main.get_command``.
    """

_TRACES_DIR_ENV_VAR = "PHOSPHOR_TRACES_DIR"
_DEFAULT_TRACES_DIR = "traces"
_DEFAULT_MAX_EVENTS = 20000
_DEFAULT_TIMEOUT_S = 60


class PipelineError(Exception):
    """Raised when ``run_pipeline`` cannot produce a graph for a script.

    Wraps every failure mode from ``collect()``/``normalize()`` (bad
    ``script_path``, subprocess timeout/crash, unreadable output) behind one
    exception type so both the CLI and ``phosphor_api`` have a single,
    predictable thing to catch -- neither has to separately know about
    ``phosphor_trace.normalize.CollectionFailedError`` vs. a plain
    ``collect()`` error dict.
    """


def default_traces_dir() -> Path:
    """Root directory under which every trace_id gets its own subdirectory.

    Resolved lazily (not cached at import time) so tests and callers can
    override it via the ``PHOSPHOR_TRACES_DIR`` environment variable, or by
    passing ``traces_dir`` explicitly to ``run_pipeline``, without needing to
    reload this module.
    """
    return Path(os.environ.get(_TRACES_DIR_ENV_VAR, _DEFAULT_TRACES_DIR))


@dataclass
class PipelineResult:
    """Everything both the CLI and ``phosphor_api`` need after a pipeline run."""

    trace_id: str
    trace_dir: Path
    graph_path: Path
    events_path: Path
    viztracer_path: str
    event_count: int
    node_count: int
    edge_count: int
    truncated: bool
    graph: ComputationalGraph
    events: list[TraceEvent]


def run_pipeline(
    script_path: str,
    trace_id: str | None = None,
    traces_dir: str | Path | None = None,
    max_events: int = _DEFAULT_MAX_EVENTS,
    timeout_s: int = _DEFAULT_TIMEOUT_S,
) -> PipelineResult:
    """Run ``collect()`` -> ``normalize()`` -> ``build_graph()`` for ``script_path``.

    Writes ``graph.json`` and ``events.json`` under
    ``<traces_dir or default_traces_dir()>/<trace_id>/`` (see module
    docstring for the full directory layout) and returns a ``PipelineResult``
    describing what was written.

    ``trace_id`` defaults to a fresh random ``uuid4().hex``. Raises
    ``PipelineError`` -- never a bare ``collect()``/``normalize()``
    exception -- if any stage fails, so callers have exactly one exception
    type to handle.
    """
    resolved_trace_id = trace_id or uuid.uuid4().hex
    root = Path(traces_dir) if traces_dir is not None else default_traces_dir()
    trace_dir = root / resolved_trace_id
    trace_dir.mkdir(parents=True, exist_ok=True)

    # collect() writes its raw viztracer/OTel JSON directly into trace_dir
    # (out_dir=trace_dir below), so the raw viztracer trace the UI's
    # Perfetto embed needs is already at its final resting place inside
    # traces/<trace_id>/ -- no separate copy step, see module docstring.
    collector_result = collect(
        script_path=script_path,
        trace_id=resolved_trace_id,
        out_dir=str(trace_dir),
        max_events=max_events,
        timeout_s=timeout_s,
    )

    # Do NOT treat collector_result["error"] as fatal here -- normalize()
    # itself is the authority on whether a given error shape is recoverable
    # (a traced target script that crashed or exited non-zero, whose two
    # output artifacts were still written with a real type="error" event
    # inside) or genuinely fatal (missing script, timeout, unreadable
    # output; see CollectionFailedError's docstring). A premature raise
    # here would short-circuit that recoverable path entirely and turn
    # every crashing target script into a hard pipeline failure, which
    # defeats the point of that error-capture work.
    try:
        events = normalize(collector_result, resolved_trace_id)
    except CollectionFailedError as exc:
        raise PipelineError(str(exc)) from exc

    graph = build_graph(events, resolved_trace_id)

    graph_path = trace_dir / "graph.json"
    events_path = trace_dir / "events.json"
    graph_path.write_text(graph.model_dump_json(indent=2), encoding="utf-8")
    events_path.write_text(
        json.dumps([e.model_dump(mode="json") for e in events], indent=2),
        encoding="utf-8",
    )

    result = PipelineResult(
        trace_id=resolved_trace_id,
        trace_dir=trace_dir,
        graph_path=graph_path,
        events_path=events_path,
        viztracer_path=collector_result["viztracer_path"],
        event_count=collector_result["event_count"],
        node_count=len(graph.nodes),
        edge_count=len(graph.edges),
        truncated=collector_result["truncated"],
        graph=graph,
        events=events,
    )
    logger.info(
        "run_pipeline(script_path=%r): trace_id=%r events=%d nodes=%d edges=%d truncated=%s -> %s",
        script_path,
        result.trace_id,
        result.event_count,
        result.node_count,
        result.edge_count,
        result.truncated,
        trace_dir,
    )
    return result


@app.command("run")
def run_command(
    script_path: str = typer.Argument(..., help="Path to the Python script to trace."),
    trace_id: str | None = typer.Option(
        None, "--trace-id", help="Explicit trace_id to use (default: a fresh random id)."
    ),
    traces_dir: str | None = typer.Option(
        None,
        "--traces-dir",
        help=f"Root traces directory (default: {_DEFAULT_TRACES_DIR!r}, override via ${_TRACES_DIR_ENV_VAR}).",
    ),
    max_events: int = typer.Option(
        _DEFAULT_MAX_EVENTS, "--max-events", help="viztracer event budget before truncation."
    ),
    timeout: int = typer.Option(
        _DEFAULT_TIMEOUT_S, "--timeout", help="Subprocess timeout, in seconds."
    ),
) -> None:
    """Trace SCRIPT_PATH and build its computational graph.

    Runs collect() -> normalize() -> build_graph() against SCRIPT_PATH,
    prints a summary, and writes graph.json + events.json (plus the raw
    viztracer trace) under traces/<trace_id>/ for phosphor_api / phosphor_ui
    to load without re-running the trace.
    """
    try:
        result = run_pipeline(
            script_path=script_path,
            trace_id=trace_id,
            traces_dir=traces_dir,
            max_events=max_events,
            timeout_s=timeout,
        )
    except PipelineError as exc:
        typer.echo(f"phosphor run failed: {exc}", err=True)
        raise typer.Exit(code=1) from exc

    typer.echo(f"trace_id:    {result.trace_id}")
    typer.echo(f"events:      {result.event_count}{'  (truncated)' if result.truncated else ''}")
    typer.echo(f"nodes:       {result.node_count}")
    typer.echo(f"edges:       {result.edge_count}")
    typer.echo(f"truncated:   {result.truncated}")
    typer.echo(f"graph:       {result.graph_path}")
    typer.echo(f"events:      {result.events_path}")
    typer.echo(f"viztracer:   {result.viztracer_path}")


if __name__ == "__main__":
    app()

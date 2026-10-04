"""phosphor_api.app -- FastAPI surface over the PHOSPHOR MCCP pipeline.

File-based storage for MVP: this module never opens a real database. It
reuses exactly the ``traces/<trace_id>/`` directory layout that
``phosphor_collector.cli.run_pipeline`` writes (see that module's docstring)
-- ``graph.json`` and ``events.json`` -- as its only persistence mechanism,
per the project plan's "logically separated stores, not necessarily separate
databases" MVP guidance.

Endpoints
----------
- ``POST /api/traces`` -- ``{"script_path": str}`` -> runs the real
  collect -> normalize -> build_graph pipeline synchronously by calling
  ``phosphor_collector.cli.run_pipeline`` (never duplicated here), returns
  ``{"trace_id": str, "event_count": int, "node_count": int, "truncated": bool}``.
- ``GET /api/traces`` -- lists every trace_id already on disk under
  ``default_traces_dir()`` (i.e. every ``traces/<trace_id>/`` subdirectory
  that has a ``graph.json``), most-recently-modified first. Added for
  ``phosphor_ui`` so the viewer can offer a picker instead of requiring the
  user to already know a trace_id. Not part of the original endpoint list in
  the module's original design notes -- new for the UI.
- ``GET /api/graphs/{trace_id}`` -- loads and returns the stored
  ``ComputationalGraph`` for that trace_id. 404 if not found.
- ``GET /api/projection?trace_id=...&scale=macro|meso`` -- loads the stored
  graph and returns ``phosphor_projector.project(graph, scale)``.
- ``GET /api/traces/{trace_id}/viztracer`` -- streams the raw
  ``<trace_id>.viztracer.json`` file (Chrome trace-event format) written by
  ``phosphor_collector.collect`` straight from disk. Added for
  ``phosphor_ui``'s embedded Perfetto view, which needs the raw trace bytes
  client-side (via ``fetch().arrayBuffer()``) to post into the
  ``ui.perfetto.dev`` iframe per Perfetto's documented embedding protocol.
  404 if no such trace/file exists.
- ``POST /api/explain`` -- ``{"trace_id": str, "target_node_id": str}`` ->
  loads the stored graph + events and calls ``phosphor_explain.explain``,
  returning the resulting ``Explanation``. Returns a clean 500 (not an
  unhandled crash) if ``ANTHROPIC_API_KEY`` is not set.
- ``GET /api/complexity?trace_id=...&top_k=10`` -- loads the stored graph
  and returns ``phosphor_projector.project.complexity_lens(graph, top_k)``
  as a ``ComplexityReport``. 400 if ``top_k`` is negative (the same
  ``ValueError`` ``complexity_lens`` itself raises).
- ``GET /api/bugs?trace_id=...`` -- loads the stored graph AND events (the
  raw event list, not just the graph -- ``bug_lens`` needs per-event
  exception detail the graph alone doesn't carry) and returns
  ``phosphor_projector.project.bug_lens(graph, events)`` as a ``BugReport``.

``phosphor_explain.explain`` is called through the ``explain_module``
reference below (``phosphor_explain.explain.explain(...)``, looked up at
call time) rather than via a ``from ... import explain`` bound name, so that
tests can transparently monkeypatch ``phosphor_explain.explain.explain``
itself.

Static UI
----------
``phosphor_ui/`` (plain HTML/CSS/JS, no build step) is mounted at ``"/"``
via ``StaticFiles(html=True)`` at the bottom of this module, after every
``/api/...`` route is registered -- Starlette checks explicit routes before
falling through to a mount, so this ordering is what lets ``/api/...`` keep
working normally while every other path (starting with ``/``, i.e.
``index.html``, ``app.js``, ...) is served as a static file.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import phosphor_explain.explain as explain_module
from phosphor_collector.cli import PipelineError, default_traces_dir, run_pipeline
from phosphor_projector.project import BugReport, ComplexityReport, bug_lens, complexity_lens, project
from phosphor_trace.schema import ComputationalGraph, Explanation, TraceEvent

logger = logging.getLogger(__name__)

_UI_DIR = Path(__file__).resolve().parent.parent / "phosphor_ui"

app = FastAPI(
    title="PHOSPHOR MCCP API",
    description=(
        "Trace a real running Python script, build its computational graph, "
        "project it across scales, and explain any node -- grounded strictly "
        "in captured trace evidence."
    ),
)


# ---------------------------------------------------------------------------
# Request/response models
# ---------------------------------------------------------------------------


class TraceRequest(BaseModel):
    script_path: str


class TraceResponse(BaseModel):
    trace_id: str
    event_count: int
    node_count: int
    truncated: bool


class ExplainRequest(BaseModel):
    trace_id: str
    target_node_id: str


class TraceSummary(BaseModel):
    trace_id: str
    node_count: int | None = None
    edge_count: int | None = None


# ---------------------------------------------------------------------------
# Storage helpers -- read the traces/<trace_id>/ directory run_pipeline wrote
# ---------------------------------------------------------------------------


def _trace_dir(trace_id: str) -> Path:
    return default_traces_dir() / trace_id


def _load_graph(trace_id: str) -> ComputationalGraph:
    graph_path = _trace_dir(trace_id) / "graph.json"
    if not graph_path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"trace_id {trace_id!r} not found (no graph.json under {graph_path.parent})",
        )
    try:
        return ComputationalGraph.model_validate_json(graph_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"could not load stored graph for trace_id {trace_id!r}: {exc}",
        ) from exc


def _load_events(trace_id: str) -> list[TraceEvent]:
    events_path = _trace_dir(trace_id) / "events.json"
    if not events_path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"trace_id {trace_id!r} not found (no events.json under {events_path.parent})",
        )
    try:
        raw = json.loads(events_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise HTTPException(
            status_code=500,
            detail=f"could not load stored events for trace_id {trace_id!r}: {exc}",
        ) from exc
    return [TraceEvent.model_validate(e) for e in raw]


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@app.post("/api/traces", response_model=TraceResponse)
def create_trace(body: TraceRequest) -> TraceResponse:
    try:
        result = run_pipeline(script_path=body.script_path)
    except PipelineError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return TraceResponse(
        trace_id=result.trace_id,
        event_count=result.event_count,
        node_count=result.node_count,
        truncated=result.truncated,
    )


@app.get("/api/traces", response_model=list[TraceSummary])
def list_traces() -> list[TraceSummary]:
    """List every trace_id already collected, most-recently-modified first.

    Scans ``default_traces_dir()`` for subdirectories containing a
    ``graph.json`` (the same file ``_load_graph`` requires) -- a directory
    without one is a partial/failed collection and is skipped rather than
    listed as if it were usable. ``node_count``/``edge_count`` are read from
    that stored graph on a best-effort basis (``None`` if the file exists but
    fails to parse) so ``phosphor_ui``'s picker can show something more
    useful than a bare id without a second round trip per trace.
    """
    root = default_traces_dir()
    if not root.is_dir():
        return []

    candidates = [
        entry
        for entry in root.iterdir()
        if entry.is_dir() and (entry / "graph.json").is_file()
    ]
    candidates.sort(key=lambda p: p.stat().st_mtime, reverse=True)

    summaries: list[TraceSummary] = []
    for entry in candidates:
        node_count: int | None = None
        edge_count: int | None = None
        try:
            graph = ComputationalGraph.model_validate_json(
                (entry / "graph.json").read_text(encoding="utf-8")
            )
            node_count = len(graph.nodes)
            edge_count = len(graph.edges)
        except (OSError, ValueError):
            logger.warning("list_traces: could not parse graph.json for %r", entry.name)
        summaries.append(
            TraceSummary(trace_id=entry.name, node_count=node_count, edge_count=edge_count)
        )
    return summaries


@app.get("/api/graphs/{trace_id}", response_model=ComputationalGraph)
def get_graph(trace_id: str) -> ComputationalGraph:
    return _load_graph(trace_id)


@app.get("/api/projection", response_model=ComputationalGraph)
def get_projection(trace_id: str, scale: Literal["macro", "meso"]) -> ComputationalGraph:
    graph = _load_graph(trace_id)
    return project(graph, scale)


@app.get("/api/traces/{trace_id}/viztracer")
def get_viztracer_trace(trace_id: str) -> FileResponse:
    """Raw ``<trace_id>.viztracer.json`` bytes (Chrome trace-event format),
    unparsed, straight off disk -- for ``phosphor_ui``'s embedded Perfetto
    view, which needs the actual trace bytes client-side to post into the
    ``ui.perfetto.dev`` iframe (Perfetto's ArrayBuffer-based postMessage
    embedding protocol; not something this backend needs to understand).
    """
    viztracer_path = _trace_dir(trace_id) / f"{trace_id}.viztracer.json"
    if not viztracer_path.is_file():
        raise HTTPException(
            status_code=404,
            detail=f"no viztracer trace found for trace_id {trace_id!r} at {viztracer_path}",
        )
    return FileResponse(
        viztracer_path,
        media_type="application/json",
        filename=f"{trace_id}.viztracer.json",
    )


@app.post("/api/explain", response_model=Explanation)
def post_explain(body: ExplainRequest) -> Explanation:
    graph = _load_graph(body.trace_id)
    events = _load_events(body.trace_id)

    # Checked explicitly, before ever calling explain(): constructing a real
    # anthropic.Anthropic() client does not itself fail when the key is
    # missing (confirmed against the installed SDK) -- the failure would
    # only surface later, mid-request, as a slower and less clear error. A
    # clean, immediate 500 here is the "don't let this endpoint crash
    # unhelpfully" behavior the task calls for.
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise HTTPException(
            status_code=500,
            detail=(
                "ANTHROPIC_API_KEY is not set; phosphor_explain.explain() requires a "
                "real Anthropic API key to call the model."
            ),
        )

    try:
        explanation = explain_module.explain(graph, events, body.target_node_id)
    except ValueError as exc:
        # e.g. gather_evidence()'s own ValueError for an unknown target_node_id.
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover -- real Anthropic/network failures
        logger.exception(
            "phosphor_explain.explain failed for trace_id=%r target_node_id=%r",
            body.trace_id,
            body.target_node_id,
        )
        raise HTTPException(status_code=500, detail=f"explain() failed: {exc}") from exc

    return explanation


@app.get("/api/complexity", response_model=ComplexityReport)
def get_complexity(trace_id: str, top_k: int = 10) -> ComplexityReport:
    """Complexity Lens (whitepaper Sec.17) over the stored graph for
    ``trace_id``. Pure aggregation over already-computed edge dynamics --
    see ``phosphor_projector.project.complexity_lens``'s own docstring.
    """
    graph = _load_graph(trace_id)
    try:
        return complexity_lens(graph, top_k=top_k)
    except ValueError as exc:
        # complexity_lens's own guard against a negative top_k.
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/bugs", response_model=BugReport)
def get_bugs(trace_id: str) -> BugReport:
    """Bug Lens (whitepaper Sec.15.2) over the stored graph + events for
    ``trace_id``. Needs both: real ``type="error"`` detail lives only on
    the raw events, not the graph -- see
    ``phosphor_projector.project.bug_lens``'s own docstring for exactly
    which bug categories this can and cannot honestly support.
    """
    graph = _load_graph(trace_id)
    events = _load_events(trace_id)
    return bug_lens(graph, events)


# ---------------------------------------------------------------------------
# Static UI -- mounted last so it never shadows an /api/... route above.
# StaticFiles requires its directory to exist at mount time; phosphor_ui/
# ships index.html + app.js alongside this backend (see that directory).
# ---------------------------------------------------------------------------

app.mount("/", StaticFiles(directory=str(_UI_DIR), html=True), name="ui")

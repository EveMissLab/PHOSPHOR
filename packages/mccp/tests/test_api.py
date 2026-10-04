"""Integration tests for phosphor_api.app.

Exercises the FastAPI endpoints end to end against the real
collect -> normalize -> build_graph -> project pipeline (via
phosphor_collector.cli.run_pipeline) and the real traces/<trace_id>/
file-based storage it writes -- no mocking of the pipeline itself. The one
exception is ``test_explain_endpoint_wiring_with_stubbed_explain``, which is
the single test in this file that stubs ``phosphor_explain.explain.explain``
(no real Anthropic API key is available in CI); every other test here,
including the "clean 500" test, exercises the real endpoint code path.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import phosphor_explain.explain as explain_module
from phosphor_api.app import app
from phosphor_trace.schema import EvidenceLevel, Explanation, ExplanationClaim

REPO_ROOT = Path(__file__).resolve().parent.parent
HELLO_SCRIPT = REPO_ROOT / "demo_targets" / "hello_trace.py"

client = TestClient(app)


@pytest.fixture(autouse=True)
def _isolated_environment(tmp_path, monkeypatch):
    """Every test gets its own traces/ root (never the repo's real traces/
    directory, never another test's trace_ids) and starts with no
    ANTHROPIC_API_KEY set, regardless of the host environment."""
    monkeypatch.setenv("PHOSPHOR_TRACES_DIR", str(tmp_path / "traces"))
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)


def _create_trace(script_path: Path = HELLO_SCRIPT) -> dict:
    response = client.post("/api/traces", json={"script_path": str(script_path)})
    assert response.status_code == 200, response.text
    return response.json()


# ---------------------------------------------------------------------------
# POST /api/traces
# ---------------------------------------------------------------------------


def test_post_traces_runs_real_pipeline_and_returns_summary():
    body = _create_trace()

    assert set(body.keys()) == {"trace_id", "event_count", "node_count", "truncated"}
    assert isinstance(body["trace_id"], str) and body["trace_id"]
    assert body["event_count"] > 0
    assert body["node_count"] > 0
    assert body["truncated"] is False


def test_post_traces_reports_400_for_bad_script_path():
    response = client.post("/api/traces", json={"script_path": "does/not/exist.py"})
    assert response.status_code == 400
    assert "does not exist" in response.json()["detail"]


# ---------------------------------------------------------------------------
# GET /api/graphs/{trace_id}
# ---------------------------------------------------------------------------


def test_get_graph_matches_what_was_computed():
    body = _create_trace()
    trace_id = body["trace_id"]

    response = client.get(f"/api/graphs/{trace_id}")
    assert response.status_code == 200, response.text
    graph = response.json()

    assert graph["trace_id"] == trace_id
    assert len(graph["nodes"]) == body["node_count"]

    function_labels = {n["label"] for n in graph["nodes"] if n["node_type"] == "function"}
    # hello_trace.py's own functions must show up as real function nodes --
    # proves this is the real computed graph, not an empty/placeholder shape.
    assert "add" in function_labels
    assert "greet" in function_labels


def test_get_graph_404_for_unknown_trace_id():
    response = client.get("/api/graphs/does-not-exist")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/projection?trace_id=...&scale=macro|meso
# ---------------------------------------------------------------------------


def test_projection_macro_and_meso_are_visibly_different_for_the_same_trace():
    body = _create_trace()
    trace_id = body["trace_id"]

    macro = client.get("/api/projection", params={"trace_id": trace_id, "scale": "macro"})
    meso = client.get("/api/projection", params={"trace_id": trace_id, "scale": "meso"})
    assert macro.status_code == 200, macro.text
    assert meso.status_code == 200, meso.text

    macro_graph = macro.json()
    meso_graph = meso.json()

    # Same substrate (same trace_id), but visibly distinct projections --
    # not disconnected pipelines producing unrelated data.
    assert macro_graph["trace_id"] == trace_id
    assert meso_graph["trace_id"] == trace_id
    assert macro_graph != meso_graph

    macro_types = {n["node_type"] for n in macro_graph["nodes"]}
    meso_types = {n["node_type"] for n in meso_graph["nodes"]}
    assert macro_types <= {"process", "host"}
    assert "function" in meso_types  # meso keeps function-level nodes; macro rolls them up

    # meso is the base resolution (identity) -- same node count as the
    # originally built graph; macro collapses everything down to process/host.
    assert len(meso_graph["nodes"]) == body["node_count"]
    assert len(macro_graph["nodes"]) < len(meso_graph["nodes"])


def test_projection_404_for_unknown_trace_id():
    response = client.get("/api/projection", params={"trace_id": "nope", "scale": "macro"})
    assert response.status_code == 404


def test_projection_rejects_unsupported_scale():
    body = _create_trace()
    response = client.get(
        "/api/projection", params={"trace_id": body["trace_id"], "scale": "micro"}
    )
    assert response.status_code == 422  # only "macro"/"meso" are accepted by this endpoint


# ---------------------------------------------------------------------------
# POST /api/explain
# ---------------------------------------------------------------------------


def test_explain_returns_clean_500_when_api_key_is_unset():
    body = _create_trace()
    trace_id = body["trace_id"]
    graph = client.get(f"/api/graphs/{trace_id}").json()
    target_node_id = graph["nodes"][0]["node_id"]

    response = client.post(
        "/api/explain", json={"trace_id": trace_id, "target_node_id": target_node_id}
    )
    assert response.status_code == 500
    assert "ANTHROPIC_API_KEY" in response.json()["detail"]


def test_explain_endpoint_wiring_with_stubbed_explain(monkeypatch):
    """The only test in this file that stubs phosphor_explain.explain --
    proves the endpoint's request/response wiring (loads graph+events,
    calls explain(), returns its Explanation as JSON) without a real
    Anthropic API call."""
    body = _create_trace()
    trace_id = body["trace_id"]
    graph = client.get(f"/api/graphs/{trace_id}").json()
    target_node_id = graph["nodes"][0]["node_id"]

    canned = Explanation(
        target_node_id=target_node_id,
        local=ExplanationClaim(
            text="stubbed explanation for wiring test",
            evidence_level=EvidenceLevel.HYPOTHESIZED,
            evidence_refs=[],
        ),
    )

    captured: dict = {}

    def _fake_explain(graph_arg, events_arg, target_node_id_arg, client=None):
        captured["graph_trace_id"] = graph_arg.trace_id
        captured["event_count"] = len(events_arg)
        captured["memory_sample_count"] = sum(1 for e in events_arg if e.type == "memory_sample")
        captured["target_node_id"] = target_node_id_arg
        return canned

    # A real (if fake) key so the endpoint's own ANTHROPIC_API_KEY gate
    # doesn't short-circuit before reaching the stubbed explain() call.
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-dummy-not-real")
    monkeypatch.setattr(explain_module, "explain", _fake_explain)

    response = client.post(
        "/api/explain", json={"trace_id": trace_id, "target_node_id": target_node_id}
    )
    assert response.status_code == 200, response.text
    assert Explanation.model_validate(response.json()) == canned

    assert captured["target_node_id"] == target_node_id
    assert captured["graph_trace_id"] == trace_id
    # body["event_count"] (POST /api/traces' response) is
    # collector_result["event_count"] -- the raw viztracer "X" (function_call)
    # event count only (see phosphor_collector.collect's module docstring
    # and phosphor_collector.cli's run_pipeline). It never included
    # OTel-derived (network_request/db_query/error) events, and -- since
    # phosphor_trace.normalize started emitting type="memory_sample" events
    # -- it does not include those either. hello_trace.py makes no
    # network/db calls, so those two categories are always zero here; the
    # only real, possible gap between the two counts is memory_sample
    # events the background sampler happened to capture during
    # hello_trace.py's brief real run (0 or a handful -- see
    # tests/test_collector.py::
    # test_collect_memory_sampler_does_not_crash_on_trivial_script), so the
    # full stored event count minus that real memory_sample count must
    # equal the collector's own raw event_count exactly.
    assert captured["event_count"] - captured["memory_sample_count"] == body["event_count"]


def test_explain_404_for_unknown_trace_id():
    response = client.post(
        "/api/explain", json={"trace_id": "nope", "target_node_id": "fn_x"}
    )
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/complexity?trace_id=...&top_k=...
# ---------------------------------------------------------------------------


def test_complexity_endpoint_returns_real_report():
    body = _create_trace()
    trace_id = body["trace_id"]

    response = client.get("/api/complexity", params={"trace_id": trace_id, "top_k": 3})
    assert response.status_code == 200, response.text
    report = response.json()

    assert report["trace_id"] == trace_id
    assert report["top_k"] == 3
    assert len(report["top_edges"]) <= 3
    assert len(report["node_costs"]) == body["node_count"]
    # every edge is accounted for: what's shown plus what's explicitly omitted.
    assert len(report["top_edges"]) + report["omitted_edge_count"] == report["total_edge_count"]


def test_complexity_endpoint_default_top_k():
    body = _create_trace()
    response = client.get("/api/complexity", params={"trace_id": body["trace_id"]})
    assert response.status_code == 200, response.text
    assert response.json()["top_k"] == 10


def test_complexity_endpoint_404_for_unknown_trace_id():
    response = client.get("/api/complexity", params={"trace_id": "nope"})
    assert response.status_code == 404


def test_complexity_endpoint_400_for_negative_top_k():
    body = _create_trace()
    response = client.get(
        "/api/complexity", params={"trace_id": body["trace_id"], "top_k": -1}
    )
    assert response.status_code == 400


# ---------------------------------------------------------------------------
# GET /api/bugs?trace_id=...
# ---------------------------------------------------------------------------


def test_bugs_endpoint_returns_real_report():
    body = _create_trace()  # hello_trace.py: no errors, no traffic explosion expected
    trace_id = body["trace_id"]

    response = client.get("/api/bugs", params={"trace_id": trace_id})
    assert response.status_code == 200, response.text
    report = response.json()

    assert report["trace_id"] == trace_id
    assert report["errors"] == []  # hello_trace.py never raises


def test_bugs_endpoint_404_for_unknown_trace_id():
    response = client.get("/api/bugs", params={"trace_id": "nope"})
    assert response.status_code == 404

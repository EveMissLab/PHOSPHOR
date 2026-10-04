from __future__ import annotations

import json

import pytest
from pathlib import Path

from phosphor_spacetime.benchmark.harness import BenchmarkHarness, RunContext
from phosphor_spacetime.benchmark.models import WorkloadOutcome
from phosphor_spacetime.cli import main
from phosphor_spacetime.contracts import validate_payload
from phosphor_spacetime.metrics.compare import compare_run_dirs


REQUIRED_RUN_FILES = {
    "manifest.json",
    "config.json",
    "metrics.json",
    "correctness.json",
    "command-intents.jsonl",
    "actuation-receipts.jsonl",
    "summary.md",
}


def test_b0_event_sparse_run_writes_complete_valid_artifacts(tmp_path: Path):
    harness = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit")
    record = harness.run("C_EVENT_SPARSE", "B0_NATIVE", random_seed=42)

    assert record.valid is True
    assert REQUIRED_RUN_FILES <= {p.name for p in record.run_dir.iterdir()}

    manifest = json.loads((record.run_dir / "manifest.json").read_text(encoding="utf-8"))
    validate_payload("mvp-run-manifest-v0.1", manifest)
    assert manifest["baseline"] == "B0_NATIVE"
    assert manifest["workload"] == "C_EVENT_SPARSE"
    assert manifest["random_seed"] == 42

    correctness = json.loads((record.run_dir / "correctness.json").read_text(encoding="utf-8"))
    assert correctness["valid"] is True
    assert correctness["checks"]["final_state_hash"] is True


def test_event_sparse_rule_baseline_preserves_output_and_reduces_tick_work(tmp_path: Path):
    harness = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit")
    native = harness.run("C_EVENT_SPARSE", "B0_NATIVE", random_seed=42)
    rule = harness.run("C_EVENT_SPARSE", "B2_RULE", random_seed=42)

    native_correctness = json.loads((native.run_dir / "correctness.json").read_text(encoding="utf-8"))
    rule_correctness = json.loads((rule.run_dir / "correctness.json").read_text(encoding="utf-8"))
    native_metrics = json.loads((native.run_dir / "metrics.json").read_text(encoding="utf-8"))
    rule_metrics = json.loads((rule.run_dir / "metrics.json").read_text(encoding="utf-8"))

    assert native_correctness["state_hash"] == rule_correctness["state_hash"]
    assert native_metrics["values"]["tick_iterations"] == 1000
    assert rule_metrics["values"]["tick_iterations"] == 0
    assert rule_metrics["values"]["idle_ticks_avoided"] == 997
    assert rule_metrics["policy"]["policy_source"] == "RULE"


def test_event_sparse_matrix_runs_all_four_baselines_under_same_correctness_contract(tmp_path: Path):
    harness = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit")
    records = harness.run_matrix("C_EVENT_SPARSE", random_seed=7)

    assert [r.baseline for r in records] == ["B0_NATIVE", "B1_FIXED", "B2_RULE", "B3_AI"]
    assert len({r.run_id for r in records}) == 4
    state_hashes = {
        json.loads((r.run_dir / "correctness.json").read_text(encoding="utf-8"))["state_hash"]
        for r in records
    }
    assert len(state_hashes) == 1
    assert all(r.valid for r in records)


def test_b3_uses_m8_ai_adapter_and_records_ai_policy(tmp_path: Path):
    calls = []

    def model(payload):
        calls.append(payload)
        domain = payload["domain"]
        evidence = payload["evidence_refs"]
        return {
            "proposal": {
                "target_domain_id": domain["domain_id"],
                "operation": "SET_TEMPORAL_RATE",
                "value": 1.5,
                "goal": "reduce synthetic temporal debt",
                "reason": "BENCHMARK_AI_FIXTURE",
                "confidence": 0.8,
                "evidence_refs": evidence,
            }
        }

    harness = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit", ai_model_call=model)
    record = harness.run("C_EVENT_SPARSE", "B3_AI", random_seed=42)
    metrics = json.loads((record.run_dir / "metrics.json").read_text(encoding="utf-8"))

    assert len(calls) == 1
    assert metrics["policy"]["policy_source"] == "AI"
    assert metrics["policy"]["ai_status"] == "OK"
    assert metrics["policy"]["used_fallback"] is False


def test_b3_malformed_ai_output_is_retained_as_rule_fallback(tmp_path: Path):
    harness = BenchmarkHarness(
        runs_root=tmp_path,
        git_commit="test-commit",
        ai_model_call=lambda payload: "{broken",
    )
    record = harness.run("C_EVENT_SPARSE", "B3_AI", random_seed=42)
    metrics = json.loads((record.run_dir / "metrics.json").read_text(encoding="utf-8"))

    assert record.valid is True
    assert metrics["policy"]["ai_status"] == "INVALID_OUTPUT"
    assert metrics["policy"]["used_fallback"] is True
    assert metrics["policy"]["policy_source"] == "RULE"


def test_failed_workload_run_is_retained_and_marked_invalid(tmp_path: Path):
    def fail(context: RunContext) -> WorkloadOutcome:
        assert (context.run_dir / "manifest.json").exists(), "manifest must exist before workload launch"
        raise RuntimeError("synthetic failure")

    harness = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit", workload_runner=fail)
    record = harness.run("C_EVENT_SPARSE", "B0_NATIVE", random_seed=1)

    assert record.valid is False
    correctness = json.loads((record.run_dir / "correctness.json").read_text(encoding="utf-8"))
    assert correctness["valid"] is False
    assert correctness["error"]["type"] == "RuntimeError"
    assert "synthetic failure" in correctness["error"]["message"]
    assert (record.run_dir / "summary.md").exists()


def test_compare_does_not_drop_invalid_runs(tmp_path: Path):
    good = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit").run(
        "C_EVENT_SPARSE", "B0_NATIVE", random_seed=1
    )

    def fail(context: RunContext) -> WorkloadOutcome:
        raise RuntimeError("bad run")

    bad = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit", workload_runner=fail).run(
        "C_EVENT_SPARSE", "B1_FIXED", random_seed=1
    )
    report = compare_run_dirs([good.run_dir, bad.run_dir])

    assert report["run_count"] == 2
    assert report["valid_run_count"] == 1
    assert report["invalid_run_count"] == 1
    assert report["by_baseline"]["B1_FIXED"]["invalid_count"] == 1


def test_manifest_repeat_and_seed_are_preserved(tmp_path: Path):
    harness = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit")
    record = harness.run("D_CAUSAL_DAG", "B1_FIXED", random_seed=123, repeat_index=4)
    manifest = json.loads((record.run_dir / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["random_seed"] == 123
    assert manifest["repeat_index"] == 4


def test_all_declared_workloads_have_a_valid_b0_contract(tmp_path: Path):
    harness = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit")
    workload_ids = ["A_ANCHORED", "B_ELASTIC_CPU", "C_EVENT_SPARSE", "D_CAUSAL_DAG", "E_MIXED"]
    records = [harness.run(w, "B0_NATIVE", random_seed=11) for w in workload_ids]
    assert all(record.valid for record in records)
    assert {record.workload for record in records} == set(workload_ids)


def test_compare_aggregates_numeric_metrics_by_baseline(tmp_path: Path):
    harness = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit")
    runs = [
        harness.run("C_EVENT_SPARSE", "B0_NATIVE", random_seed=1, repeat_index=0),
        harness.run("C_EVENT_SPARSE", "B0_NATIVE", random_seed=2, repeat_index=1),
    ]
    report = compare_run_dirs([r.run_dir for r in runs])
    stats = report["by_baseline"]["B0_NATIVE"]["metrics"]["tick_iterations"]
    assert stats["count"] == 2
    assert stats["mean"] == 1000.0
    assert stats["median"] == 1000.0


def test_cli_run_and_matrix_write_artifacts(tmp_path: Path):
    rc = main([
        "run",
        "C_EVENT_SPARSE",
        "--baseline",
        "B0_NATIVE",
        "--runs-root",
        str(tmp_path),
        "--git-commit",
        "cli-test",
        "--seed",
        "3",
    ])
    assert rc == 0

    rc = main([
        "matrix",
        "C_EVENT_SPARSE",
        "--runs-root",
        str(tmp_path),
        "--git-commit",
        "cli-test",
        "--seed",
        "4",
    ])
    assert rc == 0
    manifests = list(tmp_path.glob("*/manifest.json"))
    assert len(manifests) == 5


def test_cli_compare_writes_report(tmp_path: Path):
    harness = BenchmarkHarness(runs_root=tmp_path / "runs", git_commit="test-commit")
    records = harness.run_matrix("C_EVENT_SPARSE", random_seed=2)
    output = tmp_path / "comparison.json"
    rc = main(["compare", *[str(r.run_dir) for r in records], "--output", str(output)])
    assert rc == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["run_count"] == 4
    assert set(report["by_baseline"]) == {"B0_NATIVE", "B1_FIXED", "B2_RULE", "B3_AI"}


def test_compare_marks_mixed_workloads_as_not_directly_comparable(tmp_path: Path):
    harness = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit")
    a = harness.run("A_ANCHORED", "B0_NATIVE", random_seed=1)
    b = harness.run("C_EVENT_SPARSE", "B1_FIXED", random_seed=1)
    report = compare_run_dirs([a.run_dir, b.run_dir])
    assert report["comparison_compatible"] is False
    assert "MIXED_WORKLOADS" in report["compatibility_warnings"]


def test_compare_marks_unbalanced_seed_sets_across_baselines(tmp_path: Path):
    harness = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit")
    b0 = harness.run("C_EVENT_SPARSE", "B0_NATIVE", random_seed=1)
    b1 = harness.run("C_EVENT_SPARSE", "B1_FIXED", random_seed=2)
    report = compare_run_dirs([b0.run_dir, b1.run_dir])
    assert report["comparison_compatible"] is False
    assert "BASELINE_SEED_SETS_DIFFER" in report["compatibility_warnings"]


def test_invalid_run_metrics_do_not_enter_numeric_aggregates(tmp_path: Path):
    good_harness = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit")
    good = good_harness.run("C_EVENT_SPARSE", "B0_NATIVE", random_seed=1)

    def fail(context: RunContext) -> WorkloadOutcome:
        raise RuntimeError("no metric contribution")

    bad = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit", workload_runner=fail).run(
        "C_EVENT_SPARSE", "B0_NATIVE", random_seed=1, repeat_index=1
    )
    report = compare_run_dirs([good.run_dir, bad.run_dir])
    stats = report["by_baseline"]["B0_NATIVE"]["metrics"]["tick_iterations"]
    assert stats["count"] == 1
    assert report["by_baseline"]["B0_NATIVE"]["invalid_count"] == 1


def test_default_b3_fixture_stays_inside_m8_temporal_max_delta(tmp_path: Path):
    harness = BenchmarkHarness(runs_root=tmp_path, git_commit="test-commit")
    record = harness.run("C_EVENT_SPARSE", "B3_AI", random_seed=5)
    metrics = json.loads((record.run_dir / "metrics.json").read_text(encoding="utf-8"))
    proposal = metrics["policy"]["proposal"]
    assert proposal["operation"] == "SET_TEMPORAL_RATE"
    assert proposal["value"] == pytest.approx(1.5)
    assert proposal["metadata"]["goal"] == "reduce benchmark temporal debt"

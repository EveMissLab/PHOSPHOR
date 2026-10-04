from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from phosphor_spacetime.benchmark.harness import BenchmarkHarness
from phosphor_spacetime.benchmark.workloads import run_builtin_workload
from phosphor_spacetime.gate_models import GateCheckError
from phosphor_spacetime.governance.ai_policy import AIPolicyAdapter
from phosphor_spacetime.governance.policy import GovernanceSummary
from phosphor_spacetime.governance.rule_governor import RulePolicy, decide as rule_decide
from phosphor_spacetime.metrics.compare import compare_run_dirs


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise GateCheckError(message)


def check_causal_governance(run_dir: Path, git_commit: str) -> dict[str, Any]:
    native = run_builtin_workload("D_CAUSAL_DAG", {"topology_aware_execution": False}, 42)
    topology = run_builtin_workload("D_CAUSAL_DAG", {"topology_aware_execution": True}, 42)
    _require(native.valid and topology.valid, "causal workload correctness failed")
    _require(native.state_hash == topology.state_hash, "topology-aware execution changed causal result")
    for metric in ("work", "depth", "structural_parallelism", "poset_width"):
        _require(metric in topology.metrics, f"missing causal metric: {metric}")
    _require(topology.correctness_checks.get("hard_causal_violations") is True, "hard causal invariant failed")

    high = GovernanceSummary(
        domain_id="gate:causal",
        role="NORMAL",
        temporal_debt=8.0,
        resource_pressure=0.7,
        causal_criticality=0.95,
        resource_budget_supported=True,
    )
    low = high.model_copy(update={"causal_criticality": 0.1})
    high_proposals = rule_decide(high, RulePolicy())
    low_proposals = rule_decide(low, RulePolicy())
    _require(bool(high_proposals), "high-causal-criticality domain produced no governance proposal")
    _require(low_proposals == [], "low-causal-criticality domain received critical governance action")

    return {
        "work": topology.metrics["work"],
        "depth": topology.metrics["depth"],
        "structural_parallelism": topology.metrics["structural_parallelism"],
        "poset_width": topology.metrics["poset_width"],
        "state_hash_preserved": True,
        "hard_causal_violations": 0,
        "criticality_changes_policy": True,
    }


def check_ai_hierarchical(run_dir: Path, git_commit: str) -> dict[str, Any]:
    summary = GovernanceSummary(
        domain_id="gate:ai",
        role="NORMAL",
        temporal_debt=8.0,
        resource_pressure=0.4,
        causal_criticality=0.9,
        observation_health="HEALTHY",
        current_temporal_rate=1.0,
        native_temporal_rate_supported=True,
    )
    rule_policy = RulePolicy()

    valid_model = lambda payload: {
        "proposal": {
            "target_domain_id": payload["domain"]["domain_id"],
            "operation": "SET_TEMPORAL_RATE",
            "value": 1.5,
            "goal": "reduce gate temporal debt",
            "reason": "GATE_AI_VALID",
            "confidence": 0.8,
            "evidence_refs": payload["evidence_refs"],
        }
    }
    valid = AIPolicyAdapter(valid_model, rule_policy=rule_policy).decide(summary)
    _require(valid.ai_status == "OK", "valid AI proposal was rejected")
    _require(valid.proposals and valid.proposals[0].policy_source == "AI", "valid AI proposal lost AI provenance")

    malformed = AIPolicyAdapter(lambda payload: "{broken", rule_policy=rule_policy).decide(summary)
    _require(malformed.ai_status == "INVALID_OUTPUT", "malformed AI output misclassified")
    _require(malformed.used_fallback and malformed.proposals[0].policy_source == "RULE", "malformed AI output did not fall back")

    def slow(payload: dict[str, Any]) -> dict[str, Any]:
        time.sleep(0.05)
        return {"proposal": None}

    timeout = AIPolicyAdapter(slow, rule_policy=rule_policy, timeout_seconds=0.005).decide(summary)
    _require(timeout.ai_status == "TIMEOUT", "AI timeout was not contained")
    _require(timeout.used_fallback and timeout.proposals[0].policy_source == "RULE", "AI timeout did not use deterministic fallback")

    calls: list[dict[str, Any]] = []
    stale = AIPolicyAdapter(lambda payload: calls.append(payload) or {"proposal": None}, rule_policy=rule_policy).decide(
        summary.model_copy(update={"observation_health": "STALE"})
    )
    _require(stale.ai_status == "BLOCKED" and calls == [], "stale observation reached AI model")
    _require(stale.proposals == [], "stale observation caused adaptive mutation")

    return {
        "valid_ai_status": valid.ai_status,
        "valid_policy_source": valid.proposals[0].policy_source,
        "malformed_status": malformed.ai_status,
        "malformed_fallback_source": malformed.proposals[0].policy_source,
        "timeout_status": timeout.ai_status,
        "timeout_fallback_source": timeout.proposals[0].policy_source,
        "stale_status": stale.ai_status,
        "stale_model_calls": 0,
    }


def check_end_to_end(run_dir: Path, git_commit: str) -> dict[str, Any]:
    runs_root = run_dir / "end-to-end-runs"
    harness = BenchmarkHarness(runs_root=runs_root, git_commit=git_commit)
    records = harness.run_matrix("E_MIXED", random_seed=42)
    _require(len(records) == 4, "end-to-end matrix did not produce four baselines")
    _require(all(record.valid for record in records), "one or more end-to-end baseline runs were invalid")

    required_artifacts = {
        "manifest.json",
        "config.json",
        "metrics.json",
        "correctness.json",
        "command-intents.jsonl",
        "actuation-receipts.jsonl",
        "summary.md",
    }
    for record in records:
        present = {path.name for path in record.run_dir.iterdir() if path.is_file()}
        _require(required_artifacts <= present, f"run {record.run_id} missing artifacts")

    hashes = {
        json.loads((record.run_dir / "correctness.json").read_text(encoding="utf-8"))["state_hash"]
        for record in records
    }
    _require(len(hashes) == 1, "B0-B3 did not preserve the same mixed-workload state")

    comparison = compare_run_dirs([record.run_dir for record in records])
    _require(comparison["comparison_compatible"] is True, "end-to-end baseline comparison marked incompatible")
    _require(comparison["valid_run_count"] == 4, "comparison did not retain four valid baselines")

    b3 = next(record for record in records if record.baseline == "B3_AI")
    b3_metrics = json.loads((b3.run_dir / "metrics.json").read_text(encoding="utf-8"))
    _require(b3_metrics["policy"].get("ai_status") == "OK", "B3 did not traverse AI adapter")

    return {
        "workload": "E_MIXED",
        "baselines": [record.baseline for record in records],
        "valid_runs": 4,
        "state_hash_count": len(hashes),
        "required_artifacts_per_run": sorted(required_artifacts),
        "comparison_compatible": True,
        "b3_ai_status": b3_metrics["policy"]["ai_status"],
        "performance_superiority_required": False,
    }

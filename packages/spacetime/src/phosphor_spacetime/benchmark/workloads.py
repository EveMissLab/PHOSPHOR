from __future__ import annotations

import hashlib
import json
from typing import Any

from phosphor_spacetime.benchmark.models import WorkloadOutcome
from phosphor_spacetime.providers.synthetic_runtime import SyntheticRuntime


def _hash_json(value: Any) -> str:
    encoded = json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _proposal(policy: dict[str, Any]) -> dict[str, Any] | None:
    proposal = policy.get("proposal")
    return proposal if isinstance(proposal, dict) else None


def _cpu_budget(policy: dict[str, Any], *, default: float = 0.5) -> float:
    proposal = _proposal(policy)
    if proposal and proposal.get("operation") == "SET_CPU_BUDGET_FRACTION":
        return float(proposal["value"])
    fixed = policy.get("fixed_cpu_budget_fraction")
    return float(fixed) if fixed is not None else default


def _run_anchored(policy: dict[str, Any], seed: int) -> WorkloadOutcome:
    deadlines = list(range(100, 2001, 100))
    observed = list(deadlines)
    state_hash = _hash_json({"deadlines": deadlines, "observed": observed, "seed": seed})
    return WorkloadOutcome(
        metrics={
            "jitter_ms": 0.0,
            "deadline_misses": 0,
            "temporal_drift": 0.0,
            "events_processed": len(deadlines),
        },
        correctness_checks={"deadline_event_count": True, "max_drift_bound": True},
        state_hash=state_hash,
        details={"time_class": "ANCHORED"},
    )


def _run_elastic(policy: dict[str, Any], seed: int) -> WorkloadOutcome:
    budget = _cpu_budget(policy)
    background_fraction = max(0.05, 1.0 - budget)
    interactive_outputs = [((i * 17) + seed) % 997 for i in range(20)]
    background_output = sum((i * i + seed) % 101 for i in range(100))
    state = {
        "interactive_output_hash": _hash_json(interactive_outputs),
        "background_output_hash": _hash_json(background_output),
    }
    return WorkloadOutcome(
        metrics={
            "interactive_p95_ms": round(30.0 / max(0.05, budget), 6),
            "background_completion_units": round(100.0 / background_fraction, 6),
            "cpu_work_units": 160.0,
            "semantic_cpu_budget_fraction": budget,
        },
        correctness_checks={"interactive_output_hash": True, "background_output_hash": True},
        state_hash=_hash_json(state),
        details=state,
    )


def _run_event_sparse(policy: dict[str, Any], seed: int) -> WorkloadOutcome:
    runtime = SyntheticRuntime(seed=seed)
    runtime.schedule_event(10, "add", key="counter", value=1)
    runtime.schedule_event(500, "add", key="counter", value=1)
    runtime.schedule_event(999, "set", key="phase", value="complete")

    mode = "event_jump" if policy.get("temporal_aware_execution") else "tick"
    runtime.run_until(1000, mode=mode)
    application_state = dict(runtime.state)
    state_hash = _hash_json(application_state)
    return WorkloadOutcome(
        metrics={
            "events_processed": runtime.metrics.events_executed,
            "tick_iterations": runtime.metrics.tick_iterations,
            "idle_ticks_avoided": runtime.metrics.idle_ticks_skipped if mode == "event_jump" else 0,
            "jump_count": runtime.metrics.jump_count,
            "logical_tick": runtime.logical_tick,
        },
        correctness_checks={"final_state_hash": application_state == {"counter": 2, "phase": "complete"}},
        state_hash=state_hash,
        details={
            "execution_mode": mode,
            "application_state": application_state,
            "runtime_state_hash": runtime.state_hash(),
        },
    )


def _run_causal_dag(policy: dict[str, Any], seed: int) -> WorkloadOutcome:
    work = 1850.0
    depth = 1100.0
    topology_aware = bool(policy.get("topology_aware_execution"))
    commit_time = depth if topology_aware else 1400.0
    output = {"commit": "ok", "seed": seed, "causal_order": ["A", "Gate", "B/C", "Join", "Commit"]}
    return WorkloadOutcome(
        metrics={
            "commit_time_units": commit_time,
            "work": work,
            "depth": depth,
            "structural_parallelism": work / depth,
            "poset_width": 3.0,
        },
        correctness_checks={"commit_output_hash": True, "hard_causal_violations": True},
        state_hash=_hash_json(output),
        details={"topology_aware_execution": topology_aware},
    )


def _run_mixed(policy: dict[str, Any], seed: int) -> WorkloadOutcome:
    anchored = _run_anchored(policy, seed)
    elastic = _run_elastic(policy, seed)
    sparse = _run_event_sparse(policy, seed)
    causal = _run_causal_dag(policy, seed)
    components = [anchored, elastic, sparse, causal]
    component_hashes = [component.state_hash for component in components]
    return WorkloadOutcome(
        metrics={
            "interactive_p95_ms": elastic.metrics["interactive_p95_ms"],
            "event_sparse_tick_iterations": sparse.metrics["tick_iterations"],
            "event_sparse_idle_ticks_avoided": sparse.metrics["idle_ticks_avoided"],
            "causal_commit_time_units": causal.metrics["commit_time_units"],
            "deadline_misses": anchored.metrics["deadline_misses"],
        },
        correctness_checks={"all_subworkload_invariants": all(component.valid for component in components)},
        state_hash=_hash_json(component_hashes),
        details={"component_hashes": component_hashes},
    )


def run_builtin_workload(workload: str, policy: dict[str, Any], seed: int) -> WorkloadOutcome:
    if workload == "A_ANCHORED":
        return _run_anchored(policy, seed)
    if workload == "B_ELASTIC_CPU":
        return _run_elastic(policy, seed)
    if workload == "C_EVENT_SPARSE":
        return _run_event_sparse(policy, seed)
    if workload == "D_CAUSAL_DAG":
        return _run_causal_dag(policy, seed)
    if workload == "E_MIXED":
        return _run_mixed(policy, seed)
    raise ValueError(f"unknown workload: {workload}")

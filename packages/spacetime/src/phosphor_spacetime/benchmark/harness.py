from __future__ import annotations

import json
import platform
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

import psutil

from phosphor_spacetime.benchmark.models import Baseline, RunRecord, WorkloadOutcome
from phosphor_spacetime.benchmark.workloads import run_builtin_workload
from phosphor_spacetime.contracts import validate_payload
from phosphor_spacetime.governance.ai_policy import AIPolicyAdapter
from phosphor_spacetime.governance.policy import GovernanceSummary
from phosphor_spacetime.governance.rule_governor import RulePolicy, decide as rule_decide
from phosphor_spacetime.ir.models import EvidenceRef


@dataclass(frozen=True)
class RunContext:
    run_id: str
    run_dir: Path
    workload: str
    baseline: str
    random_seed: int
    repeat_index: int
    policy: dict[str, Any]


WorkloadRunner = Callable[[RunContext], WorkloadOutcome]
AIModelCall = Callable[[dict[str, Any]], str | dict[str, Any]]
BASELINES: tuple[Baseline, ...] = ("B0_NATIVE", "B1_FIXED", "B2_RULE", "B3_AI")


class BenchmarkHarness:
    def __init__(
        self,
        *,
        runs_root: Path | str,
        git_commit: str,
        ai_model_call: AIModelCall | None = None,
        workload_runner: WorkloadRunner | None = None,
        rule_policy: RulePolicy | None = None,
    ) -> None:
        self.runs_root = Path(runs_root)
        self.git_commit = git_commit
        self.ai_model_call = ai_model_call or self._default_ai_model
        self.workload_runner = workload_runner
        self.rule_policy = rule_policy or RulePolicy()

    def run(
        self,
        workload: str,
        baseline: Baseline,
        *,
        random_seed: int = 42,
        repeat_index: int = 0,
    ) -> RunRecord:
        if baseline not in BASELINES:
            raise ValueError(f"unknown baseline: {baseline}")
        run_id = self._new_run_id(workload, baseline, repeat_index)
        run_dir = self.runs_root / run_id
        run_dir.mkdir(parents=True, exist_ok=False)

        manifest = self._manifest(run_id, workload, baseline, random_seed, repeat_index)
        validate_payload("mvp-run-manifest-v0.1", manifest)
        self._write_json(run_dir / "manifest.json", manifest)
        self._write_json(
            run_dir / "config.json",
            {
                "schema_version": "mvp-run-config-v0.1",
                "workload": workload,
                "baseline": baseline,
                "random_seed": random_seed,
                "repeat_index": repeat_index,
                "correctness_contract": self._correctness_contract(workload),
            },
        )
        (run_dir / "command-intents.jsonl").write_text("", encoding="utf-8")
        (run_dir / "actuation-receipts.jsonl").write_text("", encoding="utf-8")

        started = time.perf_counter()
        try:
            policy = self._resolve_policy(workload, baseline, random_seed)
            context = RunContext(
                run_id=run_id,
                run_dir=run_dir,
                workload=workload,
                baseline=baseline,
                random_seed=random_seed,
                repeat_index=repeat_index,
                policy=policy,
            )
            if self.workload_runner is not None:
                outcome = self.workload_runner(context)
            else:
                outcome = run_builtin_workload(workload, policy, random_seed)
            wall_time = time.perf_counter() - started
            values = dict(outcome.metrics)
            values["harness_wall_time_s"] = wall_time
            metrics = {
                "schema_version": "mvp-metrics-v0.1",
                "run_id": run_id,
                "workload": workload,
                "baseline": baseline,
                "values": values,
                "policy": policy,
            }
            correctness = {
                "schema_version": "mvp-correctness-v0.1",
                "run_id": run_id,
                "valid": outcome.valid,
                "checks": outcome.correctness_checks,
                "state_hash": outcome.state_hash,
                "details": outcome.details,
            }
            self._write_json(run_dir / "metrics.json", metrics)
            self._write_json(run_dir / "correctness.json", correctness)
            self._write_summary(run_dir, manifest, metrics, correctness)
            return RunRecord(run_id, run_dir, workload, baseline, outcome.valid)
        except BaseException as exc:
            wall_time = time.perf_counter() - started
            self._write_json(
                run_dir / "metrics.json",
                {
                    "schema_version": "mvp-metrics-v0.1",
                    "run_id": run_id,
                    "workload": workload,
                    "baseline": baseline,
                    "values": {"harness_wall_time_s": wall_time},
                    "policy": {"policy_source": "ERROR"},
                },
            )
            correctness = {
                "schema_version": "mvp-correctness-v0.1",
                "run_id": run_id,
                "valid": False,
                "checks": {},
                "state_hash": None,
                "error": {"type": type(exc).__name__, "message": str(exc)[:512]},
            }
            self._write_json(run_dir / "correctness.json", correctness)
            self._write_summary(run_dir, manifest, None, correctness)
            return RunRecord(run_id, run_dir, workload, baseline, False)

    def run_matrix(
        self,
        workload: str,
        *,
        random_seed: int = 42,
        repeat_index: int = 0,
    ) -> list[RunRecord]:
        return [
            self.run(workload, baseline, random_seed=random_seed, repeat_index=repeat_index)
            for baseline in BASELINES
        ]

    def _manifest(
        self,
        run_id: str,
        workload: str,
        baseline: str,
        random_seed: int,
        repeat_index: int,
    ) -> dict[str, Any]:
        return {
            "schema_version": "mvp-run-manifest-v0.1",
            "run_id": run_id,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "host": {
                "os": platform.system(),
                "os_version": platform.version(),
                "arch": platform.machine() or "unknown",
                "cpu": platform.processor() or None,
                "gpu": None,
                "memory_bytes": int(psutil.virtual_memory().total),
            },
            "software": {
                "git_commit": self.git_commit,
                "schema_versions": [
                    "ssm-ir-v0.1",
                    "ssm-control-v0.1",
                    "ssm-provider-v0.1",
                    "ssm-actuation-receipt-v0.1",
                    "mvp-run-manifest-v0.1",
                ],
                "provider_versions": {},
            },
            "workload": workload,
            "baseline": baseline,
            "policy": {"baseline": baseline, "contract": "mvp-baseline-v0.1"},
            "authority": {"mode": "BENCHMARK_SYNTHETIC"},
            "observation": {"profile": "NORMAL", "accounting": "INCLUDED"},
            "random_seed": random_seed,
            "repeat_index": repeat_index,
            "notes": "M9 synthetic benchmark harness; performance values are measurements/fixtures, not pass criteria.",
        }

    def _resolve_policy(self, workload: str, baseline: str, seed: int) -> dict[str, Any]:
        if baseline == "B0_NATIVE":
            return {
                "policy_source": "NATIVE",
                "proposal": None,
                "ai_status": None,
                "used_fallback": False,
                "temporal_aware_execution": False,
                "topology_aware_execution": False,
            }
        if baseline == "B1_FIXED":
            return {
                "policy_source": "FIXED",
                "proposal": None,
                "ai_status": None,
                "used_fallback": False,
                "fixed_cpu_budget_fraction": 0.6 if workload in {"B_ELASTIC_CPU", "E_MIXED"} else None,
                "temporal_aware_execution": False,
                "topology_aware_execution": False,
            }

        summary = self._governance_summary(workload, seed)
        if baseline == "B2_RULE":
            proposals = rule_decide(summary, self.rule_policy)
            proposal = proposals[0].model_dump(mode="json") if proposals else None
            return {
                "policy_source": proposal["policy_source"] if proposal else "RULE",
                "proposal": proposal,
                "ai_status": None,
                "used_fallback": False,
                "temporal_aware_execution": workload in {"C_EVENT_SPARSE", "E_MIXED"},
                "topology_aware_execution": workload in {"D_CAUSAL_DAG", "E_MIXED"},
            }

        adapter = AIPolicyAdapter(self.ai_model_call, rule_policy=self.rule_policy)
        decision = adapter.decide(summary)
        proposal = decision.proposals[0].model_dump(mode="json") if decision.proposals else None
        source = proposal["policy_source"] if proposal else "AI"
        return {
            "policy_source": source,
            "proposal": proposal,
            "ai_status": decision.ai_status,
            "used_fallback": decision.used_fallback,
            "detail": decision.detail,
            "temporal_aware_execution": workload in {"C_EVENT_SPARSE", "E_MIXED"},
            "topology_aware_execution": workload in {"D_CAUSAL_DAG", "E_MIXED"},
        }

    def _governance_summary(self, workload: str, seed: int) -> GovernanceSummary:
        evidence = EvidenceRef(
            source="benchmark",
            id=f"{workload}:{seed}",
            kind="synthetic",
            level="verified",
        )
        common: dict[str, Any] = {
            "domain_id": f"benchmark:{workload}",
            "observation_health": "HEALTHY",
            "current_cpu_budget_fraction": 0.5,
            "current_temporal_rate": 1.0,
            "current_observation_profile": "NORMAL",
            "evidence_refs": [evidence],
        }
        if workload == "A_ANCHORED":
            return GovernanceSummary(
                **common,
                role="INTERACTIVE",
                temporal_debt=0.0,
                resource_pressure=0.2,
                causal_criticality=0.8,
            )
        if workload == "B_ELASTIC_CPU":
            return GovernanceSummary(
                **common,
                role="INTERACTIVE",
                temporal_debt=8.0,
                resource_pressure=0.75,
                causal_criticality=0.9,
                resource_budget_supported=True,
            )
        if workload == "C_EVENT_SPARSE":
            return GovernanceSummary(
                **common,
                role="NORMAL",
                temporal_debt=8.0,
                resource_pressure=0.3,
                causal_criticality=0.9,
                native_temporal_rate_supported=True,
            )
        if workload == "D_CAUSAL_DAG":
            return GovernanceSummary(
                **common,
                role="NORMAL",
                temporal_debt=7.0,
                resource_pressure=0.8,
                causal_criticality=0.95,
                resource_budget_supported=True,
            )
        if workload == "E_MIXED":
            return GovernanceSummary(
                **common,
                role="NORMAL",
                temporal_debt=8.0,
                resource_pressure=0.85,
                causal_criticality=0.95,
                native_temporal_rate_supported=True,
                resource_budget_supported=True,
            )
        raise ValueError(f"unknown workload: {workload}")

    def _default_ai_model(self, payload: dict[str, Any]) -> dict[str, Any]:
        allowed = payload["allowed_operations"]
        domain = payload["domain"]
        evidence = payload["evidence_refs"]
        if "SET_TEMPORAL_RATE" in allowed:
            value = min(
                payload["safety_envelope"]["temporal_rate_ceiling"],
                domain["current_temporal_rate"] + payload["safety_envelope"]["temporal_rate_max_delta"],
            )
            return {
                "proposal": {
                    "target_domain_id": domain["domain_id"],
                    "operation": "SET_TEMPORAL_RATE",
                    "value": value,
                    "goal": "reduce benchmark temporal debt",
                    "reason": "M9_DETERMINISTIC_AI_FIXTURE",
                    "confidence": 0.8,
                    "evidence_refs": evidence,
                }
            }
        if "SET_CPU_BUDGET_FRACTION" in allowed:
            value = min(
                payload["safety_envelope"]["cpu_budget_max"],
                domain["current_cpu_budget_fraction"] + payload["safety_envelope"]["cpu_budget_max_delta"],
            )
            return {
                "proposal": {
                    "target_domain_id": domain["domain_id"],
                    "operation": "SET_CPU_BUDGET_FRACTION",
                    "value": value,
                    "goal": "reduce benchmark latency under contention",
                    "reason": "M9_DETERMINISTIC_AI_FIXTURE",
                    "confidence": 0.8,
                    "evidence_refs": evidence,
                }
            }
        return {"proposal": None}

    @staticmethod
    def _correctness_contract(workload: str) -> list[str]:
        contracts = {
            "A_ANCHORED": ["deadline_event_count", "max_drift_bound"],
            "B_ELASTIC_CPU": ["interactive_output_hash", "background_output_hash"],
            "C_EVENT_SPARSE": ["final_state_hash"],
            "D_CAUSAL_DAG": ["commit_output_hash", "hard_causal_violations"],
            "E_MIXED": ["all_subworkload_invariants"],
        }
        if workload not in contracts:
            raise ValueError(f"unknown workload: {workload}")
        return contracts[workload]

    @staticmethod
    def _new_run_id(workload: str, baseline: str, repeat_index: int) -> str:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        return f"{stamp}_{workload}_{baseline}_r{repeat_index}_{uuid4().hex[:8]}"

    @staticmethod
    def _write_json(path: Path, payload: dict[str, Any]) -> None:
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )

    @staticmethod
    def _write_summary(
        run_dir: Path,
        manifest: dict[str, Any],
        metrics: dict[str, Any] | None,
        correctness: dict[str, Any],
    ) -> None:
        lines = [
            f"# PHOSPHOR Spacetime Benchmark Run — {manifest['run_id']}",
            "",
            f"- Workload: `{manifest['workload']}`",
            f"- Baseline: `{manifest['baseline']}`",
            f"- Valid: `{correctness['valid']}`",
        ]
        if metrics is not None:
            lines.append(f"- Policy source: `{metrics['policy'].get('policy_source')}`")
        if not correctness["valid"] and "error" in correctness:
            lines.append(
                f"- Error: `{correctness['error']['type']}: {correctness['error']['message']}`"
            )
        lines.extend(["", "Performance values are evidence, not hard pass criteria in M9.", ""])
        (run_dir / "summary.md").write_text("\n".join(lines), encoding="utf-8")

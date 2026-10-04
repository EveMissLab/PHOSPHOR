from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from phosphor_spacetime.gate_checks_contract import check_contract, check_observation_ir
from phosphor_spacetime.gate_checks_control import check_safe_actuation, check_temporal_semantics
from phosphor_spacetime.gate_checks_governance import check_ai_hierarchical, check_causal_governance, check_end_to_end
from phosphor_spacetime.gate_models import GateCheckError, GateId, GateReport, GateResult

__all__ = ["GateCheckError", "GateId", "GateReport", "GateResult", "GateRunner"]


class GateRunner:
    """Execute hard Gate 0–6 checks without treating performance hypotheses as gates."""

    def __init__(self, *, work_root: Path | str, git_commit: str) -> None:
        self.work_root = Path(work_root)
        self.git_commit = git_commit

    def run(self) -> GateReport:
        started = datetime.now(timezone.utc)
        run_id = f"gate_{started.strftime('%Y%m%dT%H%M%S%fZ')}_{uuid4().hex[:8]}"
        run_dir = self.work_root / run_id
        run_dir.mkdir(parents=True, exist_ok=False)

        specs: list[tuple[GateId, str, Callable[[Path], dict[str, Any]]]] = [
            ("G0_CONTRACT", "Contract / Schema Integrity", self._gate_contract),
            ("G1_OBSERVATION_IR", "Observation / IR Safety", self._gate_observation_ir),
            ("G2_SAFE_ACTUATION", "Safe Actuation / Authority", self._gate_safe_actuation),
            ("G3_TEMPORAL_SEMANTICS", "Temporal Semantics", self._gate_temporal_semantics),
            ("G4_CAUSAL_GOVERNANCE", "Causal Governance", self._gate_causal_governance),
            ("G5_AI_HIERARCHICAL", "Hierarchical / AI Fallback", self._gate_ai_hierarchical),
            ("G6_END_TO_END", "End-to-End Benchmark Contract", self._gate_end_to_end),
        ]
        gates = [self._execute_gate(gate_id, name, check, run_dir) for gate_id, name, check in specs]
        finished = datetime.now(timezone.utc)
        report_path = run_dir / "gate-report.json"
        report = GateReport(
            run_id=run_id,
            git_commit=self.git_commit,
            started_at=started,
            finished_at=finished,
            passed=all(gate.passed for gate in gates),
            passed_gate_count=sum(1 for gate in gates if gate.passed),
            failed_gate_count=sum(1 for gate in gates if not gate.passed),
            performance_hypotheses_evaluated=False,
            gates=gates,
            report_path=str(report_path),
        )
        report_path.write_text(
            json.dumps(report.model_dump(mode="json"), ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
        return report

    def _execute_gate(
        self,
        gate_id: GateId,
        name: str,
        check: Callable[[Path], dict[str, Any]],
        run_dir: Path,
    ) -> GateResult:
        try:
            evidence = check(run_dir)
            if not evidence:
                raise GateCheckError("gate produced no evidence")
            return GateResult(gate_id=gate_id, name=name, passed=True, evidence=evidence)
        except BaseException as exc:
            if isinstance(exc, (KeyboardInterrupt, SystemExit)):
                raise
            return GateResult(
                gate_id=gate_id,
                name=name,
                passed=False,
                evidence={},
                failures=[f"{type(exc).__name__}: {exc}"],
            )

    def _gate_contract(self, run_dir: Path) -> dict[str, Any]:
        return check_contract(run_dir, self.git_commit)

    def _gate_observation_ir(self, run_dir: Path) -> dict[str, Any]:
        return check_observation_ir(run_dir, self.git_commit)

    def _gate_safe_actuation(self, run_dir: Path) -> dict[str, Any]:
        return check_safe_actuation(run_dir, self.git_commit)

    def _gate_temporal_semantics(self, run_dir: Path) -> dict[str, Any]:
        return check_temporal_semantics(run_dir, self.git_commit)

    def _gate_causal_governance(self, run_dir: Path) -> dict[str, Any]:
        return check_causal_governance(run_dir, self.git_commit)

    def _gate_ai_hierarchical(self, run_dir: Path) -> dict[str, Any]:
        return check_ai_hierarchical(run_dir, self.git_commit)

    def _gate_end_to_end(self, run_dir: Path) -> dict[str, Any]:
        return check_end_to_end(run_dir, self.git_commit)

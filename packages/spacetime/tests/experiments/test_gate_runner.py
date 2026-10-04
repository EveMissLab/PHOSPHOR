from __future__ import annotations

import json
from pathlib import Path

from phosphor_spacetime.cli import main
from phosphor_spacetime.gates import GateReport, GateRunner


def test_gate_runner_returns_named_gate_0_through_6(tmp_path: Path):
    report = GateRunner(work_root=tmp_path, git_commit="gate-test").run()

    assert isinstance(report, GateReport)
    assert [gate.gate_id for gate in report.gates] == [
        "G0_CONTRACT",
        "G1_OBSERVATION_IR",
        "G2_SAFE_ACTUATION",
        "G3_TEMPORAL_SEMANTICS",
        "G4_CAUSAL_GOVERNANCE",
        "G5_AI_HIERARCHICAL",
        "G6_END_TO_END",
    ]
    assert all(gate.passed for gate in report.gates)
    assert report.passed is True


def test_gate_report_contains_evidence_and_no_hidden_empty_pass(tmp_path: Path):
    report = GateRunner(work_root=tmp_path, git_commit="gate-test").run()

    for gate in report.gates:
        assert gate.evidence, f"{gate.gate_id} passed without evidence"
        assert gate.failures == []


def test_cli_gate_writes_machine_readable_report(tmp_path: Path):
    output = tmp_path / "gate-report.json"
    rc = main([
        "gate",
        "--work-root",
        str(tmp_path / "gate-work"),
        "--git-commit",
        "cli-gate-test",
        "--output",
        str(output),
    ])

    assert rc == 0
    report = json.loads(output.read_text(encoding="utf-8"))
    assert report["schema_version"] == "ssm-gate-report-v0.1"
    assert report["passed"] is True
    assert len(report["gates"]) == 7


def test_gate_runner_is_repeatable_without_run_directory_collision(tmp_path: Path):
    runner = GateRunner(work_root=tmp_path, git_commit="repeat-test")
    first = runner.run()
    second = runner.run()

    assert first.passed is True
    assert second.passed is True
    assert first.run_id != second.run_id


def test_gate_failure_is_recorded_without_aborting_later_gates(tmp_path: Path):
    class FailingRunner(GateRunner):
        def _gate_causal_governance(self, run_dir: Path):
            raise RuntimeError("injected causal gate failure")

    report = FailingRunner(work_root=tmp_path, git_commit="failure-isolation").run()

    assert report.passed is False
    assert report.passed_gate_count == 6
    assert report.failed_gate_count == 1
    causal = next(gate for gate in report.gates if gate.gate_id == "G4_CAUSAL_GOVERNANCE")
    end_to_end = next(gate for gate in report.gates if gate.gate_id == "G6_END_TO_END")
    assert causal.passed is False
    assert "injected causal gate failure" in causal.failures[0]
    assert end_to_end.passed is True


def test_gate_report_keeps_performance_superiority_outside_hard_gate_contract(tmp_path: Path):
    report = GateRunner(work_root=tmp_path, git_commit="hard-gates-only").run()
    end_to_end = next(gate for gate in report.gates if gate.gate_id == "G6_END_TO_END")

    assert end_to_end.evidence["performance_superiority_required"] is False
    assert report.performance_hypotheses_evaluated is False

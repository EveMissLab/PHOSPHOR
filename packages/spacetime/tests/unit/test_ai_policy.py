from __future__ import annotations

import json
import time
from datetime import datetime, timedelta, timezone

import pytest

from phosphor_spacetime.governance.ai_policy import AIPolicyAdapter
from phosphor_spacetime.governance.policy import GovernanceSummary
from phosphor_spacetime.governance.rule_governor import RulePolicy
from phosphor_spacetime.ir.models import EvidenceRef


NOW = datetime(2026, 8, 23, 23, 0, tzinfo=timezone.utc)


def summary(**overrides) -> GovernanceSummary:
    data = {
        "domain_id": "domain:ai-test",
        "role": "NORMAL",
        "temporal_debt": 8.0,
        "resource_pressure": 0.45,
        "causal_criticality": 0.9,
        "observation_health": "HEALTHY",
        "current_cpu_budget_fraction": 0.5,
        "current_temporal_rate": 1.0,
        "current_observation_profile": "NORMAL",
        "paused": False,
        "native_temporal_rate_supported": True,
        "resource_budget_supported": True,
        "observation_profile_supported": True,
        "pause_supported": True,
        "resume_supported": True,
        "last_policy_change_at": None,
        "evidence_refs": [EvidenceRef(source="mccp", id="evt:1", kind="runtime")],
    }
    data.update(overrides)
    return GovernanceSummary(**data)


def policy(**overrides) -> RulePolicy:
    data = {
        "debt_low": 1.0,
        "debt_high": 5.0,
        "pressure_low": 0.35,
        "pressure_high": 0.80,
        "criticality_low": 0.30,
        "criticality_high": 0.70,
        "cpu_budget_min": 0.10,
        "cpu_budget_max": 1.00,
        "cpu_budget_step": 0.10,
        "cpu_budget_max_delta": 0.10,
        "temporal_rate_floor": 0.25,
        "temporal_rate_ceiling": 4.0,
        "temporal_rate_step": 0.50,
        "temporal_rate_max_delta": 0.50,
        "cooldown_seconds": 5.0,
    }
    data.update(overrides)
    return RulePolicy(**data)


def ai_output(*, operation="SET_TEMPORAL_RATE", value=1.5, target="domain:ai-test", **extra):
    proposal = {
        "target_domain_id": target,
        "operation": operation,
        "value": value,
        "goal": "reduce temporal debt within the safety envelope",
        "reason": "AI_EVIDENCE_BASED_ADJUSTMENT",
        "confidence": 0.82,
        "evidence_refs": [{"source": "mccp", "id": "evt:1", "kind": "runtime"}],
    }
    proposal.update(extra)
    return {"proposal": proposal}


def test_valid_ai_proposal_is_schema_bounded_and_marked_ai():
    adapter = AIPolicyAdapter(lambda payload: ai_output(), rule_policy=policy())
    result = adapter.decide(summary(), now=NOW)
    assert result.ai_status == "OK"
    assert result.used_fallback is False
    assert len(result.proposals) == 1
    proposal = result.proposals[0]
    assert proposal.operation == "SET_TEMPORAL_RATE"
    assert proposal.value == pytest.approx(1.5)
    assert proposal.policy_source == "AI"
    assert proposal.metadata["confidence"] == pytest.approx(0.82)
    assert proposal.evidence_refs[0].id == "evt:1"


def test_ai_receives_compact_provider_neutral_summary_and_safety_envelope():
    seen = {}

    def fake(payload):
        seen.update(payload)
        return ai_output()

    result = AIPolicyAdapter(fake, rule_policy=policy()).decide(summary(), now=NOW)
    assert result.ai_status == "OK"
    assert seen["schema_version"] == "ssm-ai-policy-input-v0.1"
    assert seen["domain"]["domain_id"] == "domain:ai-test"
    assert "cpu.max" not in json.dumps(seen)
    assert "job_object" not in json.dumps(seen).lower()
    assert seen["safety_envelope"]["temporal_rate_max_delta"] == pytest.approx(0.5)
    assert "SET_TEMPORAL_RATE" in seen["allowed_operations"]


def test_malformed_json_falls_back_to_rule_governor():
    adapter = AIPolicyAdapter(lambda payload: "{broken", rule_policy=policy())
    result = adapter.decide(summary(), now=NOW)
    assert result.ai_status == "INVALID_OUTPUT"
    assert result.used_fallback is True
    assert result.proposals[0].policy_source == "RULE"
    assert result.proposals[0].operation == "SET_TEMPORAL_RATE"


def test_timeout_falls_back_to_rule_governor_without_waiting_for_model_completion():
    def slow(payload):
        time.sleep(0.15)
        return ai_output()

    adapter = AIPolicyAdapter(slow, rule_policy=policy(), timeout_seconds=0.01)
    started = time.monotonic()
    result = adapter.decide(summary(), now=NOW)
    elapsed = time.monotonic() - started
    assert result.ai_status == "TIMEOUT"
    assert result.used_fallback is True
    assert result.proposals[0].policy_source == "RULE"
    assert elapsed < 0.10


def test_model_exception_falls_back_to_rule_governor():
    def explode(payload):
        raise RuntimeError("model offline")

    result = AIPolicyAdapter(explode, rule_policy=policy()).decide(summary(), now=NOW)
    assert result.ai_status == "ERROR"
    assert result.used_fallback is True
    assert result.proposals[0].policy_source == "RULE"


def test_provider_specific_raw_operation_is_rejected_and_falls_back():
    raw = ai_output(operation="windows.job.set_cpu_rate", value=9000)
    result = AIPolicyAdapter(lambda payload: raw, rule_policy=policy()).decide(summary(), now=NOW)
    assert result.ai_status == "REJECTED"
    assert result.used_fallback is True
    assert result.proposals[0].policy_source == "RULE"


def test_extra_raw_provider_command_field_is_rejected():
    raw = ai_output(provider_command={"cpu.max": "50000 100000"})
    result = AIPolicyAdapter(lambda payload: raw, rule_policy=policy()).decide(summary(), now=NOW)
    assert result.ai_status == "REJECTED"
    assert result.used_fallback is True


def test_cross_domain_proposal_is_rejected():
    result = AIPolicyAdapter(
        lambda payload: ai_output(target="domain:other"),
        rule_policy=policy(),
    ).decide(summary(), now=NOW)
    assert result.ai_status == "REJECTED"
    assert result.used_fallback is True


def test_ai_cannot_invent_evidence_reference():
    raw = ai_output()
    raw["proposal"]["evidence_refs"] = [{"source": "mccp", "id": "evt:not-observed", "kind": "runtime"}]
    result = AIPolicyAdapter(lambda payload: raw, rule_policy=policy()).decide(summary(), now=NOW)
    assert result.ai_status == "REJECTED"
    assert result.used_fallback is True


def test_temporal_rate_must_respect_native_capability_and_max_delta():
    too_large = AIPolicyAdapter(
        lambda payload: ai_output(value=3.0),
        rule_policy=policy(temporal_rate_max_delta=0.5),
    ).decide(summary(current_temporal_rate=1.0), now=NOW)
    assert too_large.ai_status == "REJECTED"

    unsupported = AIPolicyAdapter(
        lambda payload: ai_output(value=1.5),
        rule_policy=policy(),
    ).decide(summary(native_temporal_rate_supported=False), now=NOW)
    assert unsupported.ai_status == "REJECTED"


def test_cpu_budget_must_respect_capability_bounds_and_max_delta():
    raw = ai_output(operation="SET_CPU_BUDGET_FRACTION", value=0.9)
    result = AIPolicyAdapter(
        lambda payload: raw,
        rule_policy=policy(cpu_budget_max_delta=0.1),
    ).decide(summary(current_cpu_budget_fraction=0.5), now=NOW)
    assert result.ai_status == "REJECTED"


def test_pause_is_only_allowed_for_low_criticality_background_domain():
    raw = ai_output(operation="PAUSE", value=True)
    rejected = AIPolicyAdapter(lambda payload: raw, rule_policy=policy()).decide(
        summary(role="INTERACTIVE", causal_criticality=0.1),
        now=NOW,
    )
    assert rejected.ai_status == "REJECTED"

    accepted = AIPolicyAdapter(lambda payload: raw, rule_policy=policy()).decide(
        summary(role="BACKGROUND", causal_criticality=0.1, native_temporal_rate_supported=False),
        now=NOW,
    )
    assert accepted.ai_status == "OK"
    assert accepted.proposals[0].operation == "PAUSE"


def test_stale_observation_blocks_ai_call_and_does_not_fallback_to_mutation():
    calls = 0

    def fake(payload):
        nonlocal calls
        calls += 1
        return ai_output()

    result = AIPolicyAdapter(fake, rule_policy=policy()).decide(
        summary(observation_health="STALE"),
        now=NOW,
    )
    assert calls == 0
    assert result.ai_status == "BLOCKED"
    assert result.used_fallback is False
    assert result.proposals == []


def test_cooldown_blocks_ai_call():
    calls = 0

    def fake(payload):
        nonlocal calls
        calls += 1
        return ai_output()

    result = AIPolicyAdapter(fake, rule_policy=policy()).decide(
        summary(last_policy_change_at=NOW - timedelta(seconds=2)),
        now=NOW,
    )
    assert calls == 0
    assert result.ai_status == "BLOCKED"
    assert result.proposals == []


def test_explicit_ai_abstain_is_not_treated_as_failure_or_rule_fallback():
    result = AIPolicyAdapter(lambda payload: {"proposal": None}, rule_policy=policy()).decide(summary(), now=NOW)
    assert result.ai_status == "ABSTAIN"
    assert result.used_fallback is False
    assert result.proposals == []


def test_ai_cannot_downgrade_forensic_observation_profile():
    raw = ai_output(operation="SET_OBSERVATION_PROFILE", value="FOCUSED")
    result = AIPolicyAdapter(lambda payload: raw, rule_policy=policy()).decide(
        summary(
            current_observation_profile="FORENSIC",
            native_temporal_rate_supported=False,
            resource_budget_supported=False,
        ),
        now=NOW,
    )
    assert result.ai_status == "REJECTED"
    assert result.used_fallback is True
    assert result.proposals == []


def test_string_temporal_rate_is_rejected_instead_of_coerced():
    raw = ai_output(value="1.5")
    result = AIPolicyAdapter(lambda payload: raw, rule_policy=policy()).decide(summary(), now=NOW)
    assert result.ai_status == "REJECTED"
    assert result.used_fallback is True


def test_ai_evidence_refs_are_restricted_to_observed_summary_refs():
    extra_evidence = EvidenceRef(source="ctcl", id="evt:2", kind="causal")
    raw = ai_output()
    raw["proposal"]["evidence_refs"].append(extra_evidence.model_dump(mode="json"))
    result = AIPolicyAdapter(lambda payload: raw, rule_policy=policy()).decide(
        summary(evidence_refs=[EvidenceRef(source="mccp", id="evt:1", kind="runtime"), extra_evidence]),
        now=NOW,
    )
    assert result.ai_status == "OK"
    assert {ref.id for ref in result.proposals[0].evidence_refs} == {"evt:1", "evt:2"}


def test_ai_proposal_requires_explicit_goal():
    raw = ai_output()
    raw["proposal"].pop("goal", None)
    result = AIPolicyAdapter(lambda payload: raw, rule_policy=policy()).decide(summary(), now=NOW)
    assert result.ai_status == "REJECTED"
    assert result.used_fallback is True


def test_ai_must_cite_at_least_one_available_evidence_ref():
    raw = ai_output()
    raw["proposal"]["evidence_refs"] = []
    result = AIPolicyAdapter(lambda payload: raw, rule_policy=policy()).decide(summary(), now=NOW)
    assert result.ai_status == "REJECTED"
    assert result.used_fallback is True


def test_ai_can_only_reduce_observation_resolution_for_quiet_background_domain():
    raw = ai_output(operation="SET_OBSERVATION_PROFILE", value="MINIMAL")
    rejected = AIPolicyAdapter(lambda payload: raw, rule_policy=policy()).decide(
        summary(current_observation_profile="FOCUSED", role="NORMAL", temporal_debt=0.2, resource_pressure=0.2, causal_criticality=0.1),
        now=NOW,
    )
    assert rejected.ai_status == "REJECTED"

    accepted = AIPolicyAdapter(lambda payload: raw, rule_policy=policy()).decide(
        summary(current_observation_profile="FOCUSED", role="BACKGROUND", temporal_debt=0.2, resource_pressure=0.2, causal_criticality=0.1),
        now=NOW,
    )
    assert accepted.ai_status == "OK"
    assert accepted.proposals[0].value == "MINIMAL"


def test_model_baseexception_is_contained_and_falls_back():
    def interrupt(payload):
        raise KeyboardInterrupt("simulated model interrupt")

    result = AIPolicyAdapter(interrupt, rule_policy=policy()).decide(summary(), now=NOW)
    assert result.ai_status == "ERROR"
    assert result.used_fallback is True
    assert result.proposals[0].policy_source == "RULE"


def test_ai_policy_adapter_is_exported_from_governance_package():
    from phosphor_spacetime.governance import AIPolicyAdapter as ExportedAdapter
    from phosphor_spacetime.governance import AIPolicyDecision as ExportedDecision

    assert ExportedAdapter is AIPolicyAdapter
    assert ExportedDecision.__name__ == "AIPolicyDecision"

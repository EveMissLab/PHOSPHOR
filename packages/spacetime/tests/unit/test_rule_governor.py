from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from phosphor_spacetime.governance.policy import GovernanceSummary, PolicyProposal
from phosphor_spacetime.governance.rule_governor import RulePolicy, decide


NOW = datetime(2026, 8, 23, 14, 30, tzinfo=timezone.utc)


def summary(**overrides) -> GovernanceSummary:
    data = {
        "domain_id": "domain:test",
        "role": "NORMAL",
        "temporal_debt": 0.0,
        "resource_pressure": 0.2,
        "causal_criticality": 0.5,
        "observation_health": "HEALTHY",
        "current_cpu_budget_fraction": 0.5,
        "current_temporal_rate": 1.0,
        "current_observation_profile": "NORMAL",
        "paused": False,
        "native_temporal_rate_supported": False,
        "resource_budget_supported": True,
        "observation_profile_supported": True,
        "pause_supported": True,
        "resume_supported": True,
        "last_policy_change_at": None,
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
        "cpu_budget_step": 0.20,
        "cpu_budget_max_delta": 0.10,
        "temporal_rate_floor": 0.25,
        "temporal_rate_ceiling": 4.0,
        "temporal_rate_step": 1.0,
        "temporal_rate_max_delta": 0.50,
        "cooldown_seconds": 5.0,
    }
    data.update(overrides)
    return RulePolicy(**data)


def test_high_debt_high_criticality_prefers_native_temporal_rate():
    proposals = decide(
        summary(
            temporal_debt=9.0,
            causal_criticality=0.95,
            native_temporal_rate_supported=True,
            current_temporal_rate=1.0,
        ),
        policy(),
        now=NOW,
    )

    assert proposals == [
        PolicyProposal(
            target_domain_id="domain:test",
            operation="SET_TEMPORAL_RATE",
            value=1.5,
            reason="HIGH_TEMPORAL_DEBT_CRITICAL_DOMAIN",
            policy_source="RULE",
        )
    ]


def test_high_debt_falls_back_to_cpu_budget_when_native_time_is_unavailable():
    proposals = decide(
        summary(
            temporal_debt=8.0,
            causal_criticality=0.9,
            native_temporal_rate_supported=False,
            current_cpu_budget_fraction=0.4,
        ),
        policy(),
        now=NOW,
    )

    assert len(proposals) == 1
    assert proposals[0].operation == "SET_CPU_BUDGET_FRACTION"
    assert proposals[0].value == pytest.approx(0.5)
    assert proposals[0].reason == "HIGH_TEMPORAL_DEBT_RESOURCE_FALLBACK"


def test_background_domain_under_high_pressure_reduces_cpu_budget():
    proposals = decide(
        summary(
            role="BACKGROUND",
            resource_pressure=0.95,
            causal_criticality=0.1,
            current_cpu_budget_fraction=0.5,
        ),
        policy(),
        now=NOW,
    )

    assert len(proposals) == 1
    assert proposals[0].operation == "SET_CPU_BUDGET_FRACTION"
    assert proposals[0].value == pytest.approx(0.4)
    assert proposals[0].reason == "BACKGROUND_PRESSURE_RELIEF"


def test_background_domain_at_min_budget_can_pause_under_pressure():
    proposals = decide(
        summary(
            role="BACKGROUND",
            resource_pressure=0.95,
            causal_criticality=0.1,
            current_cpu_budget_fraction=0.1,
        ),
        policy(),
        now=NOW,
    )

    assert len(proposals) == 1
    assert proposals[0].operation == "PAUSE"
    assert proposals[0].value is True
    assert proposals[0].reason == "BACKGROUND_PRESSURE_PAUSE"


def test_paused_critical_domain_resumes_when_temporal_debt_is_high():
    proposals = decide(
        summary(
            paused=True,
            temporal_debt=7.0,
            causal_criticality=0.9,
        ),
        policy(),
        now=NOW,
    )

    assert len(proposals) == 1
    assert proposals[0].operation == "RESUME"
    assert proposals[0].reason == "CRITICAL_DEBT_RESUME"


def test_stale_or_error_observation_blocks_mutating_policy():
    for health in ("STALE", "ERROR"):
        proposals = decide(
            summary(
                observation_health=health,
                temporal_debt=100.0,
                resource_pressure=1.0,
                causal_criticality=1.0,
                native_temporal_rate_supported=True,
            ),
            policy(),
            now=NOW,
        )
        assert proposals == []


def test_hysteresis_band_produces_no_change():
    proposals = decide(
        summary(
            temporal_debt=3.0,
            resource_pressure=0.5,
            causal_criticality=0.8,
            current_temporal_rate=1.5,
            native_temporal_rate_supported=True,
        ),
        policy(),
        now=NOW,
    )

    assert proposals == []


def test_cooldown_blocks_otherwise_valid_change():
    proposals = decide(
        summary(
            temporal_debt=9.0,
            causal_criticality=0.9,
            native_temporal_rate_supported=True,
            last_policy_change_at=NOW - timedelta(seconds=2),
        ),
        policy(cooldown_seconds=5.0),
        now=NOW,
    )

    assert proposals == []


def test_temporal_rate_change_respects_max_delta_and_ceiling():
    proposals = decide(
        summary(
            temporal_debt=9.0,
            causal_criticality=0.95,
            native_temporal_rate_supported=True,
            current_temporal_rate=3.8,
        ),
        policy(temporal_rate_step=2.0, temporal_rate_max_delta=0.5, temporal_rate_ceiling=4.0),
        now=NOW,
    )

    assert proposals[0].value == pytest.approx(4.0)


def test_low_debt_restores_native_temporal_rate_toward_one_without_overshoot():
    proposals = decide(
        summary(
            temporal_debt=0.2,
            resource_pressure=0.2,
            causal_criticality=0.5,
            native_temporal_rate_supported=True,
            current_temporal_rate=2.0,
        ),
        policy(temporal_rate_step=1.0, temporal_rate_max_delta=0.4),
        now=NOW,
    )

    assert len(proposals) == 1
    assert proposals[0].operation == "SET_TEMPORAL_RATE"
    assert proposals[0].value == pytest.approx(1.6)
    assert proposals[0].reason == "LOW_DEBT_NORMALIZE_TEMPORAL_RATE"


def test_high_criticality_without_control_surface_requests_focused_observation():
    proposals = decide(
        summary(
            temporal_debt=8.0,
            causal_criticality=0.95,
            native_temporal_rate_supported=False,
            resource_budget_supported=False,
            observation_profile_supported=True,
            current_observation_profile="NORMAL",
        ),
        policy(),
        now=NOW,
    )

    assert len(proposals) == 1
    assert proposals[0].operation == "SET_OBSERVATION_PROFILE"
    assert proposals[0].value == "FOCUSED"
    assert proposals[0].reason == "CRITICAL_DOMAIN_NEEDS_MORE_EVIDENCE"


def test_quiet_background_domain_can_reduce_observation_resolution():
    proposals = decide(
        summary(
            role="BACKGROUND",
            temporal_debt=0.1,
            resource_pressure=0.2,
            causal_criticality=0.1,
            resource_budget_supported=False,
            native_temporal_rate_supported=False,
            current_observation_profile="NORMAL",
        ),
        policy(),
        now=NOW,
    )

    assert len(proposals) == 1
    assert proposals[0].operation == "SET_OBSERVATION_PROFILE"
    assert proposals[0].value == "MINIMAL"
    assert proposals[0].reason == "QUIET_BACKGROUND_OBSERVATION_REDUCTION"


def test_invalid_threshold_order_is_rejected():
    with pytest.raises(ValueError):
        RulePolicy(debt_low=5.0, debt_high=1.0)


def test_normalized_summary_values_are_bounded():
    with pytest.raises(ValueError):
        summary(resource_pressure=1.2)


def test_native_temporal_rate_at_ceiling_falls_back_to_cpu_budget():
    proposals = decide(
        summary(
            temporal_debt=9.0,
            causal_criticality=0.95,
            native_temporal_rate_supported=True,
            current_temporal_rate=4.0,
            current_cpu_budget_fraction=0.4,
        ),
        policy(temporal_rate_ceiling=4.0),
        now=NOW,
    )

    assert len(proposals) == 1
    assert proposals[0].operation == "SET_CPU_BUDGET_FRACTION"
    assert proposals[0].reason == "HIGH_TEMPORAL_DEBT_RESOURCE_FALLBACK"


def test_critical_domain_does_not_downgrade_forensic_observation():
    proposals = decide(
        summary(
            temporal_debt=9.0,
            causal_criticality=0.95,
            native_temporal_rate_supported=False,
            resource_budget_supported=False,
            current_observation_profile="FORENSIC",
        ),
        policy(),
        now=NOW,
    )

    assert proposals == []

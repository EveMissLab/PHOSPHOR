from __future__ import annotations

import json
import queue
import threading
from collections.abc import Callable
from datetime import datetime, timezone
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    ValidationError,
)

from phosphor_spacetime.governance.policy import (
    GovernanceSummary,
    PolicyOperation,
    PolicyProposal,
)
from phosphor_spacetime.governance.rule_governor import RulePolicy, decide as rule_decide
from phosphor_spacetime.ir.models import EvidenceRef


AIStatus = Literal[
    "OK",
    "ABSTAIN",
    "BLOCKED",
    "TIMEOUT",
    "INVALID_OUTPUT",
    "REJECTED",
    "ERROR",
]


class AIPolicyDecision(BaseModel):
    """Result of one AI governance cycle, including deterministic fallback state."""

    model_config = ConfigDict(extra="forbid")

    proposals: list[PolicyProposal] = Field(default_factory=list)
    ai_status: AIStatus
    used_fallback: bool = False
    detail: str | None = None


class _AIProposalDraft(BaseModel):
    """Strict wire shape accepted from an injected AI/model callable."""

    model_config = ConfigDict(extra="forbid")

    target_domain_id: str = Field(min_length=1)
    operation: PolicyOperation
    value: StrictInt | StrictFloat | StrictStr | StrictBool
    goal: str = Field(min_length=1, max_length=512)
    reason: str = Field(min_length=1, max_length=512)
    confidence: float = Field(ge=0.0, le=1.0)
    evidence_refs: list[EvidenceRef] = Field(default_factory=list)


class _AIEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    proposal: _AIProposalDraft | None


ModelCall = Callable[[dict[str, Any]], str | dict[str, Any]]


class AIPolicyAdapter:
    """Schema-bounded AI policy adapter with deterministic Rule Governor fallback.

    The injected ``model_call`` receives only a compact provider-neutral summary
    and safety envelope.  It never receives provider objects and it cannot call
    the actuation layer through this interface.
    """

    def __init__(
        self,
        model_call: ModelCall,
        *,
        rule_policy: RulePolicy,
        timeout_seconds: float = 2.0,
    ) -> None:
        if timeout_seconds <= 0:
            raise ValueError("timeout_seconds must be greater than zero")
        self._model_call = model_call
        self.rule_policy = rule_policy
        self.timeout_seconds = float(timeout_seconds)

    def decide(
        self,
        summary: GovernanceSummary,
        *,
        now: datetime | None = None,
    ) -> AIPolicyDecision:
        now = self._normalize_now(now or datetime.now(timezone.utc))

        if summary.observation_health != "HEALTHY":
            return AIPolicyDecision(
                ai_status="BLOCKED",
                detail="OBSERVATION_NOT_HEALTHY",
            )
        if self._cooldown_active(summary, now):
            return AIPolicyDecision(
                ai_status="BLOCKED",
                detail="POLICY_COOLDOWN_ACTIVE",
            )

        payload = self._build_input(summary)
        try:
            raw = self._invoke_with_timeout(payload)
        except TimeoutError:
            return self._fallback(summary, "TIMEOUT", "AI_CALL_TIMEOUT", now)
        except Exception as exc:
            return self._fallback(summary, "ERROR", self._detail(exc), now)

        try:
            envelope = self._parse_envelope(raw)
        except json.JSONDecodeError as exc:
            return self._fallback(summary, "INVALID_OUTPUT", self._detail(exc), now)
        except ValidationError as exc:
            return self._fallback(summary, "REJECTED", self._detail(exc), now)
        except (TypeError, ValueError) as exc:
            return self._fallback(summary, "INVALID_OUTPUT", self._detail(exc), now)

        if envelope.proposal is None:
            return AIPolicyDecision(ai_status="ABSTAIN")

        try:
            proposal = self._validate_and_materialize(summary, envelope.proposal)
        except (TypeError, ValueError) as exc:
            return self._fallback(summary, "REJECTED", self._detail(exc), now)

        return AIPolicyDecision(
            proposals=[proposal],
            ai_status="OK",
            used_fallback=False,
        )

    def _build_input(self, summary: GovernanceSummary) -> dict[str, Any]:
        p = self.rule_policy
        return {
            "schema_version": "ssm-ai-policy-input-v0.1",
            "task": "Propose at most one bounded provider-neutral governance action, or abstain.",
            "domain": {
                "domain_id": summary.domain_id,
                "role": summary.role,
                "temporal_debt": summary.temporal_debt,
                "resource_pressure": summary.resource_pressure,
                "causal_criticality": summary.causal_criticality,
                "observation_health": summary.observation_health,
                "current_cpu_budget_fraction": summary.current_cpu_budget_fraction,
                "current_temporal_rate": summary.current_temporal_rate,
                "current_observation_profile": summary.current_observation_profile,
                "paused": summary.paused,
            },
            "capabilities": {
                "native_temporal_rate_supported": summary.native_temporal_rate_supported,
                "resource_budget_supported": summary.resource_budget_supported,
                "observation_profile_supported": summary.observation_profile_supported,
                "pause_supported": summary.pause_supported,
                "resume_supported": summary.resume_supported,
            },
            "allowed_operations": self._allowed_operations(summary),
            "safety_envelope": {
                "cpu_budget_min": p.cpu_budget_min,
                "cpu_budget_max": p.cpu_budget_max,
                "cpu_budget_max_delta": p.cpu_budget_max_delta,
                "temporal_rate_floor": p.temporal_rate_floor,
                "temporal_rate_ceiling": p.temporal_rate_ceiling,
                "temporal_rate_max_delta": p.temporal_rate_max_delta,
                "criticality_low": p.criticality_low,
                "criticality_high": p.criticality_high,
                "cooldown_seconds": p.cooldown_seconds,
            },
            "evidence_refs": [ref.model_dump(mode="json") for ref in summary.evidence_refs],
            "output_contract": {
                "proposal": "null or {target_domain_id, operation, value, goal, reason, confidence, evidence_refs}",
                "provider_specific_commands": "forbidden",
            },
        }

    def _allowed_operations(self, summary: GovernanceSummary) -> list[str]:
        operations: list[str] = []
        if summary.native_temporal_rate_supported and not summary.paused:
            operations.append("SET_TEMPORAL_RATE")
        if summary.resource_budget_supported:
            operations.append("SET_CPU_BUDGET_FRACTION")
        if summary.observation_profile_supported:
            operations.append("SET_OBSERVATION_PROFILE")
        if summary.pause_supported and not summary.paused:
            operations.append("PAUSE")
        if summary.resume_supported and summary.paused:
            operations.append("RESUME")
        return operations

    def _invoke_with_timeout(self, payload: dict[str, Any]) -> str | dict[str, Any]:
        result_queue: queue.Queue[tuple[bool, Any]] = queue.Queue(maxsize=1)

        def runner() -> None:
            try:
                result_queue.put((True, self._model_call(payload)))
            except BaseException as exc:
                result_queue.put((False, exc))

        worker = threading.Thread(target=runner, name="pss-ai-policy-call", daemon=True)
        worker.start()
        try:
            ok, result = result_queue.get(timeout=self.timeout_seconds)
        except queue.Empty as exc:
            raise TimeoutError("AI policy call exceeded timeout") from exc
        if not ok:
            assert isinstance(result, BaseException)
            if isinstance(result, Exception):
                raise result
            raise RuntimeError(
                f"model callable raised non-Exception {type(result).__name__}: {result}"
            )
        return result

    @staticmethod
    def _parse_envelope(raw: str | dict[str, Any]) -> _AIEnvelope:
        if isinstance(raw, str):
            parsed = json.loads(raw)
        elif isinstance(raw, dict):
            parsed = raw
        else:
            raise TypeError("AI policy output must be a JSON object or JSON string")
        if not isinstance(parsed, dict):
            raise TypeError("AI policy output root must be an object")
        return _AIEnvelope.model_validate(parsed)

    def _validate_and_materialize(
        self,
        summary: GovernanceSummary,
        draft: _AIProposalDraft,
    ) -> PolicyProposal:
        if draft.target_domain_id != summary.domain_id:
            raise ValueError("AI proposal target does not match governed domain")
        if draft.operation not in self._allowed_operations(summary):
            raise ValueError("AI proposal operation is not available for this domain")

        canonical_refs = self._canonicalize_evidence(summary, draft.evidence_refs)
        value = self._validate_operation_value(summary, draft.operation, draft.value)

        return PolicyProposal(
            target_domain_id=summary.domain_id,
            operation=draft.operation,
            value=value,
            reason=draft.reason,
            policy_source="AI",
            evidence_refs=canonical_refs,
            metadata={"confidence": draft.confidence, "goal": draft.goal},
        )

    def _canonicalize_evidence(
        self,
        summary: GovernanceSummary,
        requested: list[EvidenceRef],
    ) -> list[EvidenceRef]:
        available = {(ref.source, ref.id): ref for ref in summary.evidence_refs}
        if available and not requested:
            raise ValueError("AI proposal must cite at least one available evidence reference")
        materialized: list[EvidenceRef] = []
        seen: set[tuple[str, str]] = set()
        for ref in requested:
            key = (ref.source, ref.id)
            if key not in available:
                raise ValueError(f"AI proposal references unknown evidence {ref.source}:{ref.id}")
            if key in seen:
                continue
            seen.add(key)
            materialized.append(available[key].model_copy(deep=True))
        return materialized

    def _validate_operation_value(
        self,
        summary: GovernanceSummary,
        operation: PolicyOperation,
        value: StrictInt | StrictFloat | StrictStr | StrictBool,
    ) -> float | str | bool:
        p = self.rule_policy

        if operation == "SET_TEMPORAL_RATE":
            numeric = self._strict_number(value, "temporal rate")
            if summary.paused or not summary.native_temporal_rate_supported:
                raise ValueError("native temporal-rate control unavailable")
            if not (p.temporal_rate_floor <= numeric <= p.temporal_rate_ceiling):
                raise ValueError("temporal rate outside safety envelope")
            if abs(numeric - summary.current_temporal_rate) > p.temporal_rate_max_delta + 1e-12:
                raise ValueError("temporal rate exceeds max delta")
            if summary.role == "INTERACTIVE" and numeric < 1.0:
                raise ValueError("AI cannot slow an interactive domain below 1x")
            if numeric == summary.current_temporal_rate:
                raise ValueError("temporal rate proposal is a no-op")
            return numeric

        if operation == "SET_CPU_BUDGET_FRACTION":
            numeric = self._strict_number(value, "CPU budget")
            if not summary.resource_budget_supported:
                raise ValueError("resource-budget control unavailable")
            if not (p.cpu_budget_min <= numeric <= p.cpu_budget_max):
                raise ValueError("CPU budget outside safety envelope")
            if abs(numeric - summary.current_cpu_budget_fraction) > p.cpu_budget_max_delta + 1e-12:
                raise ValueError("CPU budget exceeds max delta")
            if numeric == summary.current_cpu_budget_fraction:
                raise ValueError("CPU budget proposal is a no-op")
            return numeric

        if operation == "SET_OBSERVATION_PROFILE":
            if not isinstance(value, str):
                raise TypeError("observation profile must be a strict string")
            allowed_profiles = {"MINIMAL", "NORMAL", "FOCUSED", "FORENSIC"}
            if value not in allowed_profiles:
                raise ValueError("unsupported observation profile")
            if summary.current_observation_profile == "CUSTOM":
                raise ValueError("AI cannot reinterpret CUSTOM observation profile")
            rank = {"MINIMAL": 0, "NORMAL": 1, "FOCUSED": 2, "FORENSIC": 3}
            current_rank = rank[summary.current_observation_profile]
            target_rank = rank[value]
            if summary.current_observation_profile == "FORENSIC" and target_rank < current_rank:
                raise ValueError("AI cannot downgrade FORENSIC observation")
            if target_rank < current_rank:
                quiet_background = (
                    summary.role == "BACKGROUND"
                    and summary.temporal_debt <= p.debt_low
                    and summary.resource_pressure <= p.pressure_low
                    and summary.causal_criticality <= p.criticality_low
                )
                if not quiet_background:
                    raise ValueError(
                        "AI may reduce observation resolution only for quiet low-criticality background domains"
                    )
            if value == summary.current_observation_profile:
                raise ValueError("observation-profile proposal is a no-op")
            return value

        if operation == "PAUSE":
            if value is not True:
                raise ValueError("PAUSE requires boolean true")
            if summary.paused or not summary.pause_supported:
                raise ValueError("pause unavailable")
            if summary.role != "BACKGROUND" or summary.causal_criticality > p.criticality_low:
                raise ValueError("AI pause is restricted to low-criticality background domains")
            return True

        if operation == "RESUME":
            if value is not True:
                raise ValueError("RESUME requires boolean true")
            if not summary.paused or not summary.resume_supported:
                raise ValueError("resume unavailable")
            return True

        raise ValueError(f"unsupported policy operation: {operation}")

    @staticmethod
    def _strict_number(value: Any, label: str) -> float:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise TypeError(f"{label} must be a strict JSON number")
        return float(value)

    def _fallback(
        self,
        summary: GovernanceSummary,
        status: Literal["TIMEOUT", "INVALID_OUTPUT", "REJECTED", "ERROR"],
        detail: str,
        now: datetime,
    ) -> AIPolicyDecision:
        proposals = rule_decide(summary, self.rule_policy, now=now)
        return AIPolicyDecision(
            proposals=proposals,
            ai_status=status,
            used_fallback=True,
            detail=detail,
        )

    def _cooldown_active(self, summary: GovernanceSummary, now: datetime) -> bool:
        if summary.last_policy_change_at is None or self.rule_policy.cooldown_seconds <= 0:
            return False
        last = self._normalize_now(summary.last_policy_change_at)
        return (now - last).total_seconds() < self.rule_policy.cooldown_seconds

    @staticmethod
    def _normalize_now(value: datetime) -> datetime:
        if value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)

    @staticmethod
    def _detail(exc: BaseException) -> str:
        text = f"{type(exc).__name__}: {exc}".replace("\n", " ")
        return text[:512]

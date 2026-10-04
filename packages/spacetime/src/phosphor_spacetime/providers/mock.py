from __future__ import annotations

from datetime import datetime, timezone
from uuid import uuid4

from phosphor_spacetime.control.intent import CommandIntent
from phosphor_spacetime.control.receipts import ActuationReceipt, ProviderRef
from phosphor_spacetime.control.validator import CapabilitySpec


class MockProvider:
    """Deterministic actuation provider used to prove control semantics before OS mutation."""

    def __init__(
        self,
        *,
        provider_id: str = "mock:local",
        epoch: int = 1,
        health: str = "HEALTHY",
        temporal_rate_mode: str = "SUPPORTED",
        force_verification_mismatch: bool = False,
        raise_on_apply: bool = False,
    ) -> None:
        self._provider_ref = ProviderRef(
            provider_id=provider_id,
            instance_id=f"{provider_id}:instance",
            epoch=epoch,
        )
        self._health = health
        self.temporal_rate_mode = temporal_rate_mode
        self.force_verification_mismatch = force_verification_mismatch
        self.raise_on_apply = raise_on_apply
        self.apply_count = 0
        self._state: dict[str, object] = {
            "paused": False,
            "requested_rate": 1.0,
            "realized_rate": 1.0,
        }

    @property
    def provider_ref(self) -> ProviderRef:
        return self._provider_ref

    @property
    def health(self) -> str:
        return self._health

    def capability_for(self, action: str) -> CapabilitySpec | None:
        if action in {"domain.pause", "domain.resume", "domain.inspect"}:
            return CapabilitySpec(name=action, support="SUPPORTED", provider_epoch=self.provider_ref.epoch)
        if action == "domain.set_temporal_rate":
            support = self.temporal_rate_mode if self.temporal_rate_mode in {"SUPPORTED", "PARTIAL", "UNSUPPORTED"} else "UNSUPPORTED"
            return CapabilitySpec(
                name=action,
                support=support,
                provider_epoch=self.provider_ref.epoch,
                bounds={"rate": {"min": 0.0, "max": 20.0}},
            )
        return CapabilitySpec(name=action, support="UNSUPPORTED", provider_epoch=self.provider_ref.epoch)

    def inspect(self, target_domain_id: str) -> dict:
        observed = dict(self._state)
        if self.force_verification_mismatch:
            observed["paused"] = not bool(observed["paused"])
        return observed

    def apply(self, intent: CommandIntent) -> ActuationReceipt:
        self.apply_count += 1
        if self.raise_on_apply:
            raise RuntimeError("mock provider apply failure")
        before = dict(self._state)
        status = "CONFIRMED"
        if intent.action == "domain.pause":
            self._state["paused"] = True
        elif intent.action == "domain.resume":
            self._state["paused"] = False
        elif intent.action == "domain.set_temporal_rate":
            requested_rate = float(intent.arguments["rate"])
            self._state["requested_rate"] = requested_rate
            if self.temporal_rate_mode == "PARTIAL":
                self._state["realized_rate"] = requested_rate / 2.0
                status = "PARTIAL"
            else:
                self._state["realized_rate"] = requested_rate
        now = datetime.now(timezone.utc)
        realized = dict(self._state)
        return ActuationReceipt(
            receipt_id=f"receipt:{uuid4()}",
            command_id=intent.command_id,
            provider=self.provider_ref,
            status=status,
            started_at=now,
            finished_at=now,
            before=before,
            requested={"action": intent.action, "arguments": dict(intent.arguments)},
            realized=realized,
            observed_after=None,
            actuation_skew=None,
            fence_epoch=self.provider_ref.epoch,
            idempotency_key=intent.idempotency_key,
            evidence_refs=[],
        )

    def verify(self, receipt: ActuationReceipt) -> tuple[bool, dict]:
        observed = self.inspect(receipt.requested.get("target_domain_id", ""))
        realized = receipt.realized or {}
        comparable = {key: observed.get(key) for key in realized}
        match = comparable == realized
        return match, observed

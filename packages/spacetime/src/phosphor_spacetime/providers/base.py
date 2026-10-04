from __future__ import annotations

from typing import Protocol

from phosphor_spacetime.control.intent import CommandIntent
from phosphor_spacetime.control.receipts import ActuationReceipt, ProviderRef
from phosphor_spacetime.control.validator import CapabilitySpec


class Provider(Protocol):
    @property
    def provider_ref(self) -> ProviderRef: ...

    @property
    def health(self) -> str: ...

    def capability_for(self, action: str) -> CapabilitySpec | None: ...

    def inspect(self, target_domain_id: str) -> dict: ...

    def apply(self, intent: CommandIntent) -> ActuationReceipt: ...

    def verify(self, receipt: ActuationReceipt) -> tuple[bool, dict]: ...

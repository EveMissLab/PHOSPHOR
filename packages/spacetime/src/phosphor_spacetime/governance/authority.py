from __future__ import annotations

from datetime import datetime
from threading import RLock
from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class AuthorityGrant(BaseModel):
    """Bounded authority lease used by the v0.1 local Trust/Authority gate."""

    model_config = ConfigDict(extra="forbid")

    grant_id: str = Field(min_length=1)
    actor_id: str = Field(min_length=1)
    target_domain_ids: set[str]
    actions: set[str]
    fence_epoch: int = Field(ge=0)
    issued_at: datetime
    expires_at: datetime | None = None

    def authorizes(self, *, actor_id: str, target_domain_id: str, action: str, at: datetime) -> bool:
        if self.actor_id != actor_id:
            return False
        if target_domain_id not in self.target_domain_ids:
            return False
        if action not in self.actions:
            return False
        if self.expires_at is not None and at >= self.expires_at:
            return False
        return True


class IdempotencyStore:
    """In-memory v0.1 idempotency ledger; later versions may persist this."""

    def __init__(self) -> None:
        self._claimed: set[str] = set()
        self._receipt_ids: dict[str, str] = {}
        self._receipts: dict[str, Any] = {}
        self._lock = RLock()

    def claim(self, key: str) -> bool:
        with self._lock:
            if key in self._claimed:
                return False
            self._claimed.add(key)
            return True

    def complete(self, key: str, *, receipt_id: str, receipt: Any | None = None) -> None:
        with self._lock:
            self._claimed.add(key)
            self._receipt_ids[key] = receipt_id
            if receipt is not None:
                self._receipts[key] = receipt

    def receipt_for(self, key: str) -> str | None:
        with self._lock:
            return self._receipt_ids.get(key)

    def record_for(self, key: str) -> Any | None:
        with self._lock:
            return self._receipts.get(key)

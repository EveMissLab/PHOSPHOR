from __future__ import annotations

from datetime import datetime
from typing import Any, Callable, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field


class ObservationEvent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    event_id: str = Field(default_factory=lambda: f"obs:{uuid4()}")
    domain_id: str
    source: str
    kind: str
    observed_at: datetime
    health: Literal["HEALTHY", "DEGRADED", "STALE", "ERROR"] = "HEALTHY"
    payload: dict[str, Any] = Field(default_factory=dict)
    error_code: str | None = None
    error_detail: str | None = None


class SubscriberFailure(BaseModel):
    model_config = ConfigDict(extra="forbid")

    subscriber_index: int
    error_type: str
    error_detail: str


class ObserverBus:
    """Small in-process fan-out bus with subscriber-failure isolation."""

    def __init__(self) -> None:
        self._subscribers: list[Callable[[ObservationEvent], None]] = []

    def subscribe(self, subscriber: Callable[[ObservationEvent], None]) -> None:
        self._subscribers.append(subscriber)

    def publish(self, event: ObservationEvent) -> list[SubscriberFailure]:
        failures: list[SubscriberFailure] = []
        for index, subscriber in enumerate(tuple(self._subscribers)):
            try:
                subscriber(event)
            except Exception as exc:
                failures.append(
                    SubscriberFailure(
                        subscriber_index=index,
                        error_type=type(exc).__name__,
                        error_detail=str(exc),
                    )
                )
        return failures

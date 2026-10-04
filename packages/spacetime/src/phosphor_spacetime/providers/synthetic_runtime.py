from __future__ import annotations

import copy
import hashlib
import heapq
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import uuid4

from phosphor_spacetime.control.intent import CommandIntent
from phosphor_spacetime.control.receipts import ActuationReceipt, ProviderRef
from phosphor_spacetime.control.validator import CapabilitySpec

EventOperation = Literal["set", "add", "random_add"]
RunMode = Literal["tick", "event_jump"]


@dataclass(order=True, frozen=True)
class ScheduledEvent:
    tick: int
    sequence: int
    operation: EventOperation = field(compare=False)
    payload: dict[str, Any] = field(compare=False, default_factory=dict)

    def as_dict(self) -> dict[str, Any]:
        return {
            "tick": self.tick,
            "sequence": self.sequence,
            "operation": self.operation,
            "payload": copy.deepcopy(self.payload),
        }


@dataclass
class RuntimeMetrics:
    tick_iterations: int = 0
    jump_count: int = 0
    idle_ticks_skipped: int = 0
    events_executed: int = 0
    wall_quanta: int = 0


@dataclass(frozen=True)
class RuntimeSnapshot:
    logical_tick: int
    requested_rate: float
    realized_rate: float
    rate_remainder: float
    paused: bool
    state: dict[str, Any]
    pending_events: tuple[ScheduledEvent, ...]
    next_sequence: int
    rng_state: int

    def semantic_payload(self) -> dict[str, Any]:
        return {
            "logical_tick": self.logical_tick,
            "requested_rate": self.requested_rate,
            "realized_rate": self.realized_rate,
            "rate_remainder": self.rate_remainder,
            "paused": self.paused,
            "state": copy.deepcopy(self.state),
            "pending_events": [event.as_dict() for event in sorted(self.pending_events)],
            "next_sequence": self.next_sequence,
            "rng_state": self.rng_state,
        }

    def state_hash(self) -> str:
        encoded = json.dumps(
            self.semantic_payload(),
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
            allow_nan=False,
        ).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()


class SyntheticRuntime:
    """Deterministic discrete-event runtime with native logical-time control.

    The runtime deliberately separates semantic state from execution-cost metrics.
    Tick execution and event-jump execution may do different amounts of work while
    producing the same state hash.
    """

    _LCG_A = 1664525
    _LCG_C = 1013904223
    _LCG_MASK = 0xFFFFFFFF

    def __init__(self, *, seed: int = 0) -> None:
        if seed < 0:
            raise ValueError("seed must be non-negative")
        self.logical_tick = 0
        self.requested_rate = 1.0
        self.realized_rate = 1.0
        self.rate_remainder = 0.0
        self.paused = False
        self.state: dict[str, Any] = {}
        self.metrics = RuntimeMetrics()
        self._events: list[ScheduledEvent] = []
        self._next_sequence = 0
        self._rng_state = int(seed) & self._LCG_MASK

    @property
    def pending_event_count(self) -> int:
        return len(self._events)

    def schedule_event(self, at_tick: int, operation: EventOperation, **payload: Any) -> ScheduledEvent:
        if at_tick <= self.logical_tick:
            raise ValueError("events must be scheduled strictly in the future")
        if operation not in {"set", "add", "random_add"}:
            raise ValueError(f"unsupported event operation: {operation}")
        try:
            json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
        except (TypeError, ValueError) as exc:
            raise ValueError("event payload must be JSON-serializable with finite numeric values") from exc
        event = ScheduledEvent(
            tick=int(at_tick),
            sequence=self._next_sequence,
            operation=operation,
            payload=copy.deepcopy(payload),
        )
        self._next_sequence += 1
        heapq.heappush(self._events, event)
        return event

    def set_rate(self, rate: float) -> None:
        rate = float(rate)
        if not 0.0 <= rate <= 20.0:
            raise ValueError("logical rate must be within [0.0, 20.0]")
        self.requested_rate = rate
        self.realized_rate = rate

    def pause(self) -> None:
        self.paused = True

    def resume(self) -> None:
        self.paused = False

    def _next_random_u32(self) -> int:
        self._rng_state = (
            self._LCG_A * self._rng_state + self._LCG_C
        ) & self._LCG_MASK
        return self._rng_state

    def _execute_event(self, event: ScheduledEvent) -> None:
        payload = event.payload
        key = payload.get("key")
        if not isinstance(key, str) or not key:
            raise ValueError("event payload requires a non-empty string key")

        if event.operation == "set":
            if "value" not in payload:
                raise ValueError("set event requires value")
            self.state[key] = copy.deepcopy(payload["value"])
        elif event.operation == "add":
            if "value" not in payload or not isinstance(payload["value"], (int, float)):
                raise ValueError("add event requires numeric value")
            current = self.state.get(key, 0)
            if not isinstance(current, (int, float)):
                raise ValueError("add event target must contain a numeric value")
            self.state[key] = current + payload["value"]
        elif event.operation == "random_add":
            low = payload.get("low")
            high = payload.get("high")
            if not isinstance(low, int) or not isinstance(high, int) or low > high:
                raise ValueError("random_add requires integer low <= high")
            current = self.state.get(key, 0)
            if not isinstance(current, (int, float)):
                raise ValueError("random_add target must contain a numeric value")
            draw = low + (self._next_random_u32() % (high - low + 1))
            self.state[key] = current + draw
        else:  # pragma: no cover - guarded at schedule time
            raise ValueError(f"unsupported event operation: {event.operation}")
        self.metrics.events_executed += 1

    def _process_due_events(self) -> None:
        while self._events and self._events[0].tick == self.logical_tick:
            self._execute_event(heapq.heappop(self._events))

    def step(self, units: int = 1) -> int:
        if units < 0:
            raise ValueError("units must be non-negative")
        if self.paused or units == 0:
            return 0
        advanced = 0
        for _ in range(units):
            self.logical_tick += 1
            self.metrics.tick_iterations += 1
            advanced += 1
            self._process_due_events()
        return advanced

    def advance_wall_quanta(self, quanta: int = 1) -> int:
        if quanta < 0:
            raise ValueError("wall quanta must be non-negative")
        self.metrics.wall_quanta += quanta
        if self.paused or quanta == 0:
            return 0
        total = self.rate_remainder + (float(quanta) * self.realized_rate)
        ticks = int(total)
        self.rate_remainder = total - ticks
        return self.step(ticks)

    def event_jump(self) -> int:
        if self.paused or not self._events:
            return 0
        next_tick = self._events[0].tick
        if next_tick <= self.logical_tick:
            raise RuntimeError("pending event is not in the future")
        delta = next_tick - self.logical_tick
        self.logical_tick = next_tick
        self.metrics.jump_count += 1
        self.metrics.idle_ticks_skipped += max(0, delta - 1)
        self._process_due_events()
        return delta

    def run_until(self, target_tick: int, *, mode: RunMode = "tick") -> int:
        if target_tick < self.logical_tick:
            raise ValueError("target tick cannot move backward; use restore for rollback")
        if self.paused or target_tick == self.logical_tick:
            return 0
        start = self.logical_tick
        if mode == "tick":
            self.step(target_tick - self.logical_tick)
        elif mode == "event_jump":
            while self._events and self._events[0].tick <= target_tick:
                self.event_jump()
            if self.logical_tick < target_tick:
                delta = target_tick - self.logical_tick
                self.logical_tick = target_tick
                self.metrics.jump_count += 1
                self.metrics.idle_ticks_skipped += delta
        else:
            raise ValueError(f"unknown run mode: {mode}")
        return self.logical_tick - start

    def snapshot(self) -> RuntimeSnapshot:
        return RuntimeSnapshot(
            logical_tick=self.logical_tick,
            requested_rate=self.requested_rate,
            realized_rate=self.realized_rate,
            rate_remainder=self.rate_remainder,
            paused=self.paused,
            state=copy.deepcopy(self.state),
            pending_events=tuple(copy.deepcopy(sorted(self._events))),
            next_sequence=self._next_sequence,
            rng_state=self._rng_state,
        )

    def restore(self, snapshot: RuntimeSnapshot) -> None:
        self.logical_tick = snapshot.logical_tick
        self.requested_rate = snapshot.requested_rate
        self.realized_rate = snapshot.realized_rate
        self.rate_remainder = snapshot.rate_remainder
        self.paused = snapshot.paused
        self.state = copy.deepcopy(snapshot.state)
        self._events = list(copy.deepcopy(snapshot.pending_events))
        heapq.heapify(self._events)
        self._next_sequence = snapshot.next_sequence
        self._rng_state = snapshot.rng_state

    def state_hash(self) -> str:
        return self.snapshot().state_hash()


@dataclass
class _SyntheticTarget:
    domain_id: str
    runtime: SyntheticRuntime
    owned_by_mvp: bool
    allowlisted: bool


class SyntheticRuntimeProvider:
    """Provider exposing exact logical-time controls for SyntheticRuntime targets."""

    def __init__(
        self,
        *,
        provider_id: str = "synthetic-runtime:local",
        epoch: int = 1,
        health: str = "HEALTHY",
    ) -> None:
        self._provider_ref = ProviderRef(
            provider_id=provider_id,
            instance_id=f"{provider_id}:{uuid4()}",
            epoch=epoch,
        )
        self._health = health
        self._targets: dict[str, _SyntheticTarget] = {}
        self._snapshots: dict[tuple[str, str], RuntimeSnapshot] = {}

    @property
    def provider_ref(self) -> ProviderRef:
        return self._provider_ref

    @property
    def health(self) -> str:
        return self._health

    def capability_for(self, action: str) -> CapabilitySpec | None:
        epoch = self.provider_ref.epoch
        if action in {"domain.inspect", "domain.pause", "domain.resume", "domain.snapshot", "domain.restore"}:
            return CapabilitySpec(
                name=action,
                support="SUPPORTED",
                provider_epoch=epoch,
                projection_semantics="NATIVE_RUNTIME",
            )
        if action == "domain.set_temporal_rate":
            return CapabilitySpec(
                name=action,
                support="SUPPORTED",
                provider_epoch=epoch,
                bounds={"rate": {"min": 0.0, "max": 20.0}},
                projection_semantics="LOGICAL_RATE_NATIVE",
            )
        return CapabilitySpec(name=action, support="UNSUPPORTED", provider_epoch=epoch)

    def register_runtime(
        self,
        domain_id: str,
        runtime: SyntheticRuntime,
        *,
        owned_by_mvp: bool = False,
        allowlisted: bool = False,
    ) -> None:
        if not (owned_by_mvp or allowlisted):
            raise PermissionError("runtime must be owned by the MVP or explicitly allowlisted")
        if domain_id in self._targets:
            raise ValueError(f"runtime already registered: {domain_id}")
        self._targets[domain_id] = _SyntheticTarget(
            domain_id=domain_id,
            runtime=runtime,
            owned_by_mvp=owned_by_mvp,
            allowlisted=allowlisted,
        )

    def unregister_runtime(self, domain_id: str) -> None:
        self._targets.pop(domain_id, None)
        for key in [key for key in self._snapshots if key[0] == domain_id]:
            self._snapshots.pop(key, None)

    def _target(self, domain_id: str) -> _SyntheticTarget:
        try:
            return self._targets[domain_id]
        except KeyError as exc:
            raise PermissionError(f"runtime is not registered with synthetic provider: {domain_id}") from exc

    def inspect(self, target_domain_id: str) -> dict[str, Any]:
        runtime = self._target(target_domain_id).runtime
        return {
            "logical_tick": runtime.logical_tick,
            "requested_rate": runtime.requested_rate,
            "realized_rate": runtime.realized_rate,
            "rate_remainder": runtime.rate_remainder,
            "paused": runtime.paused,
            "pending_events": runtime.pending_event_count,
            "state_hash": runtime.state_hash(),
            "state": copy.deepcopy(runtime.state),
            "time_class": "EVENT_JUMP",
            "event_jump_allowed": True,
            "approximation_allowed": False,
        }

    def apply(self, intent: CommandIntent) -> ActuationReceipt:
        target = self._target(intent.target_domain_id)
        runtime = target.runtime
        before = self.inspect(intent.target_domain_id)
        metadata: dict[str, Any] = {}
        desired: dict[str, Any] | None = None

        if intent.action == "domain.set_temporal_rate":
            if set(intent.arguments) != {"rate"}:
                raise ValueError("set_temporal_rate requires exactly the rate argument")
            rate = float(intent.arguments["rate"])
            desired = {"requested_rate": rate}
            runtime.set_rate(rate)
        elif intent.action == "domain.pause":
            if intent.arguments:
                raise ValueError("pause does not accept arguments")
            runtime.pause()
        elif intent.action == "domain.resume":
            if intent.arguments:
                raise ValueError("resume does not accept arguments")
            runtime.resume()
        elif intent.action == "domain.snapshot":
            if intent.arguments:
                raise ValueError("snapshot does not accept arguments")
            snapshot_id = f"snapshot:{uuid4()}"
            snapshot = runtime.snapshot()
            self._snapshots[(intent.target_domain_id, snapshot_id)] = snapshot
            metadata = {
                "snapshot_id": snapshot_id,
                "snapshot_state_hash": snapshot.state_hash(),
            }
        elif intent.action == "domain.restore":
            if set(intent.arguments) != {"snapshot_id"}:
                raise ValueError("restore requires exactly snapshot_id")
            snapshot_id = intent.arguments["snapshot_id"]
            if not isinstance(snapshot_id, str) or not snapshot_id:
                raise ValueError("snapshot_id must be a non-empty string")
            snapshot = self._snapshots.get((intent.target_domain_id, snapshot_id))
            if snapshot is None:
                raise KeyError(f"unknown snapshot: {snapshot_id}")
            runtime.restore(snapshot)
            metadata = {"restored_snapshot_id": snapshot_id}
        elif intent.action == "domain.inspect":
            if intent.arguments:
                raise ValueError("inspect does not accept arguments")
        else:
            raise ValueError(f"unsupported synthetic provider action: {intent.action}")

        realized = self.inspect(intent.target_domain_id)
        realized.update(metadata)
        now = datetime.now(timezone.utc)
        return ActuationReceipt(
            receipt_id=f"receipt:{uuid4()}",
            command_id=intent.command_id,
            provider=self.provider_ref,
            status="CONFIRMED",
            started_at=now,
            finished_at=now,
            before=before,
            desired=desired,
            requested={
                "target_domain_id": intent.target_domain_id,
                "action": intent.action,
                "arguments": copy.deepcopy(intent.arguments),
            },
            realized=realized,
            observed_after=None,
            actuation_skew=None,
            fence_epoch=self.provider_ref.epoch,
            idempotency_key=intent.idempotency_key,
            evidence_refs=[],
        )

    def verify(self, receipt: ActuationReceipt) -> tuple[bool, dict]:
        target_domain_id = receipt.requested.get("target_domain_id")
        if not isinstance(target_domain_id, str):
            return False, {}
        observed = self.inspect(target_domain_id)
        realized = receipt.realized or {}
        action = receipt.requested.get("action")

        metadata_keys = {"snapshot_id", "snapshot_state_hash", "restored_snapshot_id"}
        comparable = {key: value for key, value in realized.items() if key not in metadata_keys}
        match = all(observed.get(key) == value for key, value in comparable.items())

        if action == "domain.snapshot":
            snapshot_id = realized.get("snapshot_id")
            snapshot = self._snapshots.get((target_domain_id, snapshot_id)) if isinstance(snapshot_id, str) else None
            match = bool(
                match
                and snapshot is not None
                and snapshot.state_hash() == realized.get("snapshot_state_hash")
                and observed.get("state_hash") == realized.get("snapshot_state_hash")
            )
        return match, observed

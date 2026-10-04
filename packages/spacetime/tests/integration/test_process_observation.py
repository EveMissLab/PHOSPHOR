from __future__ import annotations

import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone

from phosphor_spacetime.ir.models import SpacetimeSnapshot
from phosphor_spacetime.observation.bus import ObservationEvent, ObserverBus
from phosphor_spacetime.observation.process import ProcessObserver
from phosphor_spacetime.projection.projector import ObservationProjector
from phosphor_spacetime.registry.domains import DomainRegistry


def _spawn_sleeping_child() -> subprocess.Popen[str]:
    return subprocess.Popen(
        [sys.executable, "-c", "import time; time.sleep(30)"],
        text=True,
    )


def test_registered_process_observer_samples_only_registered_pid():
    child = _spawn_sleeping_child()
    try:
        registry = DomainRegistry()
        domain = registry.register(kind="PROCESS", domain_id="proc:child")
        registry.attach(domain.domain_id, provider_id="process-observer")
        observer = ProcessObserver(registry=registry)
        observer.register_pid(domain.domain_id, child.pid)

        event = observer.sample(domain.domain_id)

        assert event.domain_id == domain.domain_id
        assert event.kind == "process.sample"
        assert event.source == "process-observer"
        assert event.payload["pid"] == child.pid
        assert event.payload["memory_rss_bytes"] >= 0
        assert event.payload["cpu_percent"] >= 0
        assert event.health == "HEALTHY"
    finally:
        child.terminate()
        child.wait(timeout=5)


def test_unregistered_domain_or_pid_is_rejected_without_scanning_machine():
    registry = DomainRegistry()
    domain = registry.register(kind="PROCESS", domain_id="proc:unregistered")
    observer = ProcessObserver(registry=registry)

    event = observer.sample(domain.domain_id)

    assert event.health == "ERROR"
    assert event.error_code == "PID_NOT_REGISTERED"


def test_observer_failure_is_isolated_and_target_keeps_running():
    child = _spawn_sleeping_child()
    try:
        registry = DomainRegistry()
        domain = registry.register(kind="PROCESS", domain_id="proc:dies")
        observer = ProcessObserver(registry=registry)
        observer.register_pid(domain.domain_id, child.pid)

        child.terminate()
        child.wait(timeout=5)
        event = observer.sample(domain.domain_id)

        assert event.health == "ERROR"
        assert event.error_code in {"PROCESS_NOT_FOUND", "PROCESS_ACCESS_DENIED", "PROCESS_OBSERVATION_FAILED"}
        assert child.returncode is not None
    finally:
        if child.poll() is None:
            child.kill()
            child.wait(timeout=5)


def test_observer_bus_delivers_events_without_mutating_event_identity():
    bus = ObserverBus()
    seen: list[ObservationEvent] = []
    bus.subscribe(seen.append)
    event = ObservationEvent(
        event_id="obs:1",
        domain_id="proc:test",
        source="test-observer",
        kind="process.sample",
        observed_at=datetime.now(timezone.utc),
        health="HEALTHY",
        payload={"pid": 123, "cpu_percent": 1.0},
    )

    bus.publish(event)

    assert seen == [event]
    assert seen[0].event_id == "obs:1"


def test_projector_marks_process_observation_stale_after_threshold():
    registry = DomainRegistry()
    domain = registry.register(kind="PROCESS", domain_id="proc:stale")
    snapshot = SpacetimeSnapshot.new(domains=[domain])
    projector = ObservationProjector(stale_after=timedelta(seconds=1))
    observed_at = datetime.now(timezone.utc) - timedelta(seconds=5)
    event = ObservationEvent(
        event_id="obs:stale",
        domain_id=domain.domain_id,
        source="process-observer",
        kind="process.sample",
        observed_at=observed_at,
        health="HEALTHY",
        payload={"pid": 321, "cpu_percent": 2.5, "memory_rss_bytes": 4096},
    )

    projected = projector.apply(snapshot, event, now=datetime.now(timezone.utc))

    state = projected.get_domain(domain.domain_id)
    assert state.observation["health"] == "STALE"
    assert state.observation["last_observed_at"] == observed_at.isoformat()
    assert state.resources["process"]["cpu_percent"] == 2.5
    assert state.resources["process"]["memory_rss_bytes"] == 4096


def test_projector_preserves_observer_error_without_overwriting_last_good_resources():
    registry = DomainRegistry()
    domain = registry.register(kind="PROCESS", domain_id="proc:error")
    snapshot = SpacetimeSnapshot.new(domains=[domain])
    projector = ObservationProjector(stale_after=timedelta(seconds=5))
    now = datetime.now(timezone.utc)
    good = ObservationEvent(
        event_id="obs:good",
        domain_id=domain.domain_id,
        source="process-observer",
        kind="process.sample",
        observed_at=now,
        health="HEALTHY",
        payload={"pid": 444, "cpu_percent": 8.0, "memory_rss_bytes": 8192},
    )
    failed = ObservationEvent(
        event_id="obs:failed",
        domain_id=domain.domain_id,
        source="process-observer",
        kind="process.sample",
        observed_at=now + timedelta(milliseconds=10),
        health="ERROR",
        payload={"pid": 444},
        error_code="PROCESS_OBSERVATION_FAILED",
        error_detail="simulated",
    )

    projected = projector.apply(snapshot, good, now=now)
    projected = projector.apply(projected, failed, now=now + timedelta(milliseconds=10))

    state = projected.get_domain(domain.domain_id)
    assert state.resources["process"]["cpu_percent"] == 8.0
    assert state.observation["health"] == "ERROR"
    assert state.observation["error_code"] == "PROCESS_OBSERVATION_FAILED"


def test_staleness_can_be_refreshed_without_new_observation_event():
    registry = DomainRegistry()
    domain = registry.register(kind="PROCESS", domain_id="proc:refresh-stale")
    snapshot = SpacetimeSnapshot.new(domains=[domain])
    projector = ObservationProjector(stale_after=timedelta(seconds=1))
    observed_at = datetime.now(timezone.utc)
    event = ObservationEvent(
        event_id="obs:fresh",
        domain_id=domain.domain_id,
        source="process-observer",
        kind="process.sample",
        observed_at=observed_at,
        health="HEALTHY",
        payload={"pid": 555, "cpu_percent": 0.0, "memory_rss_bytes": 1024},
    )
    projected = projector.apply(snapshot, event, now=observed_at)
    assert projected.get_domain(domain.domain_id).observation["health"] == "HEALTHY"

    refreshed = projector.refresh_staleness(
        projected,
        now=observed_at + timedelta(seconds=2),
    )

    assert refreshed.get_domain(domain.domain_id).observation["health"] == "STALE"
    assert refreshed.get_domain(domain.domain_id).resources["process"]["memory_rss_bytes"] == 1024


def test_observer_bus_isolates_subscriber_failure_and_delivers_to_remaining_subscribers():
    bus = ObserverBus()
    seen: list[str] = []

    def broken(_: ObservationEvent) -> None:
        raise RuntimeError("subscriber failed")

    def healthy(event: ObservationEvent) -> None:
        seen.append(event.event_id)

    bus.subscribe(broken)
    bus.subscribe(healthy)
    event = ObservationEvent(
        event_id="obs:fanout",
        domain_id="proc:test",
        source="test-observer",
        kind="process.sample",
        observed_at=datetime.now(timezone.utc),
        health="HEALTHY",
        payload={"pid": 1},
    )

    failures = bus.publish(event)

    assert seen == ["obs:fanout"]
    assert len(failures) == 1
    assert failures[0].subscriber_index == 0
    assert failures[0].error_type == "RuntimeError"


def test_projector_clears_old_error_metadata_after_healthy_recovery():
    registry = DomainRegistry()
    domain = registry.register(kind="PROCESS", domain_id="proc:recover")
    snapshot = SpacetimeSnapshot.new(domains=[domain])
    projector = ObservationProjector(stale_after=timedelta(seconds=5))
    now = datetime.now(timezone.utc)
    failed = ObservationEvent(
        event_id="obs:error-first",
        domain_id=domain.domain_id,
        source="process-observer",
        kind="process.sample",
        observed_at=now,
        health="ERROR",
        payload={"pid": 777},
        error_code="PROCESS_OBSERVATION_FAILED",
        error_detail="simulated",
    )
    healthy = ObservationEvent(
        event_id="obs:recovered",
        domain_id=domain.domain_id,
        source="process-observer",
        kind="process.sample",
        observed_at=now + timedelta(milliseconds=10),
        health="HEALTHY",
        payload={"pid": 777, "cpu_percent": 1.0, "memory_rss_bytes": 2048},
    )

    projected = projector.apply(snapshot, failed, now=now)
    projected = projector.apply(projected, healthy, now=now + timedelta(milliseconds=10))

    state = projected.get_domain(domain.domain_id)
    assert state.observation["health"] == "HEALTHY"
    assert "error_code" not in state.observation
    assert "error_detail" not in state.observation

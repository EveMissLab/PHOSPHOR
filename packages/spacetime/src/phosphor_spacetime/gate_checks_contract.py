from __future__ import annotations

import json
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from jsonschema import ValidationError

from phosphor_spacetime.benchmark.harness import BenchmarkHarness
from phosphor_spacetime.contracts import load_schema, validate_payload
from phosphor_spacetime.control.intent import ActorRef, CommandIntent
from phosphor_spacetime.control.receipts import ActuationReceipt
from phosphor_spacetime.gate_models import GateCheckError
from phosphor_spacetime.ir.models import DomainLifecycle, DomainState, SpacetimeSnapshot
from phosphor_spacetime.observation.bus import ObservationEvent, ObserverBus
from phosphor_spacetime.observation.process import ProcessObserver
from phosphor_spacetime.projection.projector import ObservationProjector
from phosphor_spacetime.providers.mock import MockProvider
from phosphor_spacetime.registry.domains import DomainRegistry
from phosphor_spacetime.processes import spawn_observation_probe


def _require(condition: bool, message: str) -> None:
    if not condition:
        raise GateCheckError(message)


def check_contract(run_dir: Path, git_commit: str) -> dict[str, Any]:
    schema_names = [
        "ssm-ir-v0.1",
        "ssm-control-v0.1",
        "ssm-provider-v0.1",
        "ssm-actuation-receipt-v0.1",
        "mvp-run-manifest-v0.1",
    ]
    for name in schema_names:
        schema = load_schema(name)
        _require(bool(schema.get("title")), f"schema {name} has no title")

    now = datetime.now(timezone.utc)
    domain = DomainState(domain_id="gate:contract", kind="SIMULATION", lifecycle=DomainLifecycle.ATTACHED)
    snapshot = SpacetimeSnapshot.new(domains=[domain], snapshot_id="gate:contract:snapshot")
    validate_payload("ssm-ir-v0.1", snapshot.model_dump(mode="json"))

    intent = CommandIntent(
        command_id="gate:contract:command",
        actor=ActorRef(actor_id="gate:system", actor_type="system"),
        target_domain_id=domain.domain_id,
        action="domain.inspect",
        arguments={},
        requested_at=now,
        expires_at=now + timedelta(minutes=1),
        policy_source="STATIC",
        required_capabilities=["domain.inspect"],
        authority_ref="gate:contract:grant",
        evidence_refs=[],
        idempotency_key="gate:contract:idempotency",
    )
    validate_payload("ssm-control-v0.1", intent.model_dump(mode="json"))

    provider_payload = {
        "schema_version": "ssm-provider-v0.1",
        "provider": {
            "provider_id": "gate:mock",
            "provider_type": "MOCK_PROVIDER",
            "provider_version": "gate-v0.1",
            "instance_id": "gate:mock:instance",
            "epoch": 1,
            "health": "HEALTHY",
        },
        "capabilities": [{
            "name": "domain.inspect",
            "support": "SUPPORTED",
            "bounds": None,
            "precision": None,
            "latency_class": "FAST",
            "privilege": "USER",
            "reversibility": "READ_ONLY",
            "side_effect_class": "READ_ONLY",
            "projection_semantics": "EXACT",
        }],
    }
    validate_payload("ssm-provider-v0.1", provider_payload)

    receipt = ActuationReceipt.failed(
        command_id="gate:contract:command",
        provider=MockProvider().provider_ref,
        requested={"action": "domain.inspect", "arguments": {}},
        code="GATE_SAMPLE",
        detail="schema validation sample",
    )
    validate_payload("ssm-actuation-receipt-v0.1", receipt.model_dump(mode="json"))

    harness = BenchmarkHarness(runs_root=run_dir / "contract-runs", git_commit=git_commit)
    record = harness.run("A_ANCHORED", "B0_NATIVE", random_seed=1)
    manifest = json.loads((record.run_dir / "manifest.json").read_text(encoding="utf-8"))
    validate_payload("mvp-run-manifest-v0.1", manifest)

    bad = dict(intent.model_dump(mode="json"))
    bad["schema_version"] = "ssm-control-v999"
    rejected_bad_version = False
    try:
        validate_payload("ssm-control-v0.1", bad)
    except ValidationError:
        rejected_bad_version = True
    _require(rejected_bad_version, "invalid protocol version was not rejected")

    return {
        "schemas_loaded": schema_names,
        "canonical_examples_validated": 5,
        "invalid_version_rejected": True,
        "manifest_run_valid": record.valid,
    }


def check_observation_ir(run_dir: Path, git_commit: str) -> dict[str, Any]:
    registry = DomainRegistry()
    domain = registry.register(kind="PROCESS", domain_id="gate:observer")
    registry.attach(domain.domain_id, provider_id="process-observer")
    observer = ProcessObserver(registry=registry, source="gate-process-observer")
    bus = ObserverBus()
    delivered: list[ObservationEvent] = []

    def broken_subscriber(event: ObservationEvent) -> None:
        raise RuntimeError("injected subscriber failure")

    bus.subscribe(broken_subscriber)
    bus.subscribe(delivered.append)

    process = spawn_observation_probe()
    try:
        observer.register_pid(domain.domain_id, process.pid)
        event = observer.sample(domain.domain_id)
        _require(event.health == "HEALTHY", f"process observation health was {event.health}")
        failures = bus.publish(event)
        _require(len(failures) == 1, "subscriber failure was not isolated")
        _require(delivered == [event], "healthy subscriber did not receive event")
        _require(process.poll() is None, "observer/subscriber failure terminated target process")

        snapshot = SpacetimeSnapshot.new(domains=[registry.get(domain.domain_id).model_copy(deep=True)])
        projector = ObservationProjector(stale_after=timedelta(milliseconds=50))
        # Exercise health/staleness at explicit event times, independent of host load.
        projected = projector.apply(snapshot, event, now=event.observed_at)
        validate_payload("ssm-ir-v0.1", projected.model_dump(mode="json"))
        projected_domain = projected.get_domain(domain.domain_id)
        _require(projected_domain.observation.get("health") == "HEALTHY", "healthy observation not projected")
        _require(projected_domain.resources.get("process", {}).get("pid") == process.pid, "PID was not projected")

        stale = projector.refresh_staleness(projected, now=event.observed_at + timedelta(seconds=1))
        _require(stale.get_domain(domain.domain_id).observation.get("health") == "STALE", "stale observation was not marked")
    finally:
        process.terminate()
        try:
            process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=2)

    return {
        "registered_pid_only": True,
        "subscriber_failure_count": 1,
        "healthy_subscriber_received": True,
        "target_survived_observer_failure": True,
        "ir_schema_valid": True,
        "stale_transition_detected": True,
    }

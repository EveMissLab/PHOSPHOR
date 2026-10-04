from datetime import datetime, timezone

import pytest

from phosphor_spacetime.ir.models import DomainLifecycle, SpacetimeSnapshot
from phosphor_spacetime.ir.patch import IRPatch
from phosphor_spacetime.ir.merge import apply_patch
from phosphor_spacetime.registry.domains import DomainRegistry


def test_domain_identity_is_stable_after_attach():
    registry = DomainRegistry()
    domain = registry.register(kind="PROCESS", parent_domain_id=None)
    first = domain.domain_id
    registry.attach(first, provider_id="mock-provider")
    attached = registry.get(first)
    assert attached.domain_id == first
    assert attached.lifecycle == DomainLifecycle.ATTACHED
    assert attached.governance["provider_id"] == "mock-provider"


def test_detach_keeps_domain_record_but_changes_lifecycle():
    registry = DomainRegistry()
    domain = registry.register(kind="PROCESS")
    registry.attach(domain.domain_id, provider_id="mock-provider")
    registry.detach(domain.domain_id)
    detached = registry.get(domain.domain_id)
    assert detached.lifecycle == DomainLifecycle.DETACHED
    assert detached.domain_id == domain.domain_id


def test_duplicate_explicit_domain_id_is_rejected():
    registry = DomainRegistry()
    registry.register(kind="FIELD", domain_id="field:alpha")
    with pytest.raises(ValueError, match="already registered"):
        registry.register(kind="FIELD", domain_id="field:alpha")


def test_apply_patch_records_conflict_instead_of_silent_overwrite():
    registry = DomainRegistry()
    domain = registry.register(kind="SIMULATION", domain_id="sim:1")
    snapshot = SpacetimeSnapshot.new(domains=[domain])
    first = IRPatch(domain_id="sim:1", source="runtime", timestamp=datetime.now(timezone.utc), epistemic_level="observed", fields={"temporal": {"requested_rate": 1.0}}, evidence_refs=[])
    second = IRPatch(domain_id="sim:1", source="os-observer", timestamp=datetime.now(timezone.utc), epistemic_level="observed", fields={"temporal": {"requested_rate": 2.0}}, evidence_refs=[])
    snapshot = apply_patch(snapshot, first)
    snapshot = apply_patch(snapshot, second)
    projected = snapshot.get_domain("sim:1")
    assert projected.temporal.requested_rate == 1.0
    conflicts = projected.observation["conflicts"]
    assert len(conflicts) == 1
    assert conflicts[0]["path"] == "temporal.requested_rate"
    assert conflicts[0]["existing"] == 1.0
    assert conflicts[0]["incoming"] == 2.0
    assert conflicts[0]["incoming_source"] == "os-observer"


def test_same_source_can_refresh_its_own_field_without_conflict():
    registry = DomainRegistry()
    domain = registry.register(kind="SIMULATION", domain_id="sim:2")
    snapshot = SpacetimeSnapshot.new(domains=[domain])
    for rate in (1.0, 1.5):
        snapshot = apply_patch(snapshot, IRPatch(domain_id="sim:2", source="runtime", timestamp=datetime.now(timezone.utc), epistemic_level="observed", fields={"temporal": {"requested_rate": rate}}, evidence_refs=[]))
    projected = snapshot.get_domain("sim:2")
    assert projected.temporal.requested_rate == 1.5
    assert projected.observation.get("conflicts", []) == []


def test_snapshot_serializes_to_canonical_ir_schema():
    from phosphor_spacetime.contracts import validate_payload
    registry = DomainRegistry()
    domain = registry.register(kind="PROCESS", domain_id="proc:test")
    snapshot = SpacetimeSnapshot.new(domains=[domain])
    validate_payload("ssm-ir-v0.1", snapshot.model_dump(mode="json"))

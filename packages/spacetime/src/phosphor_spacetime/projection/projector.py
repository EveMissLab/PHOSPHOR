from __future__ import annotations

from datetime import datetime, timedelta, timezone

from phosphor_spacetime.ir.merge import apply_patch
from phosphor_spacetime.ir.models import EvidenceRef, SpacetimeSnapshot
from phosphor_spacetime.ir.patch import IRPatch
from phosphor_spacetime.observation.bus import ObservationEvent


class ObservationProjector:
    """Project observer events into the derived Software Spacetime IR."""

    def __init__(self, *, stale_after: timedelta = timedelta(seconds=5)) -> None:
        if stale_after.total_seconds() <= 0:
            raise ValueError("stale_after must be positive")
        self._stale_after = stale_after

    def apply(
        self,
        snapshot: SpacetimeSnapshot,
        event: ObservationEvent,
        *,
        now: datetime | None = None,
    ) -> SpacetimeSnapshot:
        now = now or datetime.now(timezone.utc)
        age = now - event.observed_at
        health = event.health
        if health == "HEALTHY" and age > self._stale_after:
            health = "STALE"

        observation = {
            "health": health,
            "last_observed_at": event.observed_at.isoformat(),
            "last_event_id": event.event_id,
            "last_source": event.source,
        }
        if event.error_code is not None:
            observation["error_code"] = event.error_code
        if event.error_detail is not None:
            observation["error_detail"] = event.error_detail

        fields: dict[str, object] = {"observation": observation}
        if event.health != "ERROR" and event.kind == "process.sample":
            process_fields = {
                key: event.payload[key]
                for key in (
                    "pid",
                    "cpu_percent",
                    "memory_rss_bytes",
                    "memory_vms_bytes",
                    "status",
                    "create_time",
                )
                if key in event.payload
            }
            fields["resources"] = {"process": process_fields}

        evidence = EvidenceRef(
            source=event.source,
            id=event.event_id,
            kind="observation_event",
            level="observed",
        )
        patch = IRPatch(
            domain_id=event.domain_id,
            source=event.source,
            timestamp=event.observed_at,
            epistemic_level="observed",
            fields=fields,
            evidence_refs=[evidence],
        )
        updated = apply_patch(snapshot, patch)
        if event.error_code is None and event.error_detail is None:
            domain = updated.get_domain(event.domain_id)
            domain.observation.pop("error_code", None)
            domain.observation.pop("error_detail", None)
            field_sources = domain.observation.get("_field_sources", {})
            field_sources.pop("observation.error_code", None)
            field_sources.pop("observation.error_detail", None)
        return updated

    def refresh_staleness(
        self,
        snapshot: SpacetimeSnapshot,
        *,
        now: datetime | None = None,
    ) -> SpacetimeSnapshot:
        now = now or datetime.now(timezone.utc)
        updated = snapshot.model_copy(deep=True)
        for domain in updated.domains:
            observed_raw = domain.observation.get("last_observed_at")
            if not observed_raw:
                continue
            try:
                observed_at = datetime.fromisoformat(observed_raw)
            except (TypeError, ValueError):
                continue
            if observed_at.tzinfo is None:
                observed_at = observed_at.replace(tzinfo=timezone.utc)
            if now - observed_at > self._stale_after and domain.observation.get("health") not in {"ERROR", "STALE"}:
                domain.observation["health"] = "STALE"
        return updated

from __future__ import annotations

from uuid import uuid4

from phosphor_spacetime.ir.models import DomainLifecycle, DomainState


class DomainRegistry:
    """In-memory v0.1 registry for stable domain identities and provider attachment."""

    def __init__(self) -> None:
        self._domains: dict[str, DomainState] = {}

    def register(self, *, kind: str, parent_domain_id: str | None = None, domain_id: str | None = None) -> DomainState:
        if parent_domain_id is not None and parent_domain_id not in self._domains:
            raise KeyError(f"unknown parent domain: {parent_domain_id}")
        resolved_id = domain_id or f"domain:{uuid4()}"
        if resolved_id in self._domains:
            raise ValueError(f"domain already registered: {resolved_id}")
        domain = DomainState(domain_id=resolved_id, parent_domain_id=parent_domain_id, kind=kind, lifecycle=DomainLifecycle.REGISTERED)
        self._domains[resolved_id] = domain
        return domain

    def attach(self, domain_id: str, *, provider_id: str) -> DomainState:
        domain = self.get(domain_id)
        domain.lifecycle = DomainLifecycle.ATTACHED
        governance = dict(domain.governance or {})
        governance["provider_id"] = provider_id
        domain.governance = governance
        return domain

    def detach(self, domain_id: str) -> DomainState:
        domain = self.get(domain_id)
        domain.lifecycle = DomainLifecycle.DETACHED
        governance = dict(domain.governance or {})
        governance.pop("provider_id", None)
        domain.governance = governance
        return domain

    def get(self, domain_id: str) -> DomainState:
        try:
            return self._domains[domain_id]
        except KeyError as exc:
            raise KeyError(f"unknown domain: {domain_id}") from exc

    def list(self) -> list[DomainState]:
        return list(self._domains.values())

    def children(self, domain_id: str) -> list[DomainState]:
        self.get(domain_id)
        return [d for d in self._domains.values() if d.parent_domain_id == domain_id]

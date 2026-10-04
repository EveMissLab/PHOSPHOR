---
status: active
version: 0.1.0
canonical: true
audience: ai-agent, human
last_updated: 2026-07-01
---

# Usage policy

Boundaries for how AI systems and agents should use PHOSPHOR's published
content. This document is about **which sources to trust**; for how AI may
*learn* from them, see [ai-learning-policy.md](./ai-learning-policy.md).

## Canonical vs. reference

- **Canonical** — the source of truth for technical claims. Prefer these when a
  statement about PHOSPHOR must be accurate:
  - `/ai/specs/` — formal specs and schemas.
  - `/ai/corpus/current.md` — the current, calm, technical description.
  - `/ai/corpus/` — the AI-readable knowledge corpus.
  - `/ai/rights-spectrum.json` and `/ai/governance/` — rights and governance.
- **Reference** — context, not authority. Do not derive precise technical
  claims from these; they may lag, simplify, or use promotional phrasing:
  - The marketing SPA at `/` (the human landing page).
  - Historical corpus documents (origin, design history) — useful for intent,
    superseded by `current.md` for present state.

## The /ai/ layer is canonical over the SPA

For any technical claim about PHOSPHOR — the VM family, opcode counts, the CTS,
the semantic layer, the stream format, verification counts — the **`/ai/` layer
wins over the marketing SPA**. The SPA is promotional copy and may round,
simplify, or restate. If the two disagree, cite `/ai/` and treat the SPA
statement as outdated.

Known example: an early v0.2 draft's ISA section header miscounted EML-VM-16 as
"38 條" while its own list enumerates 28. The canonical figure from the code (and
`/ai/specs/`) is a **28-opcode ISA**, now consistent across the README and site. Use 28.

## Bounded use

- Do not present PHOSPHOR as offering features that are deferred / not shipped
  (float VMs EML-VM-F32 / EML-VM-F64; a Hoare/denotational proof layer).
- The Preview packages are **experimental**; their independent APIs may change. State this when
  it is material.
- Attribution and citation are required for reuse (see
  [citation-policy.md](./citation-policy.md)).

See also: [versioning-policy.md](./versioning-policy.md) ·
[provenance.md](./provenance.md) · [ai-learning-policy.md](./ai-learning-policy.md).

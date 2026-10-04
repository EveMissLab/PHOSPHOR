---
status: active
version: 0.5.0-beta
canonical: true
audience: ai-agent
last_updated: 2026-07-01
---

# PHOSPHOR — Formal Specs (`/ai/specs/`)

This folder holds the formal, canonical specifications for PHOSPHOR
(Execution-as-Interface · `Φ : M × CTS → V`). Each file below is a **verbatim copy
of the corresponding spec in the source repository**
(<https://github.com/EveMissLab/PHOSPHOR/tree/main/packages/eai>). The repo is the source of
truth; if a copy here ever disagrees with the repo, the repo wins.

Applicable release: **EML-EAI-2026-v0.5 · v0.5.0-beta (EXPERIMENTAL)**. The v0.5
APIs may change before v0.6; the verified v0.4 core (VM family, 6-layer CTS,
phosphor-stream, agent protocol) is unchanged.

## Specs in this folder

- [`eml-eai-2026-v0.5.md`](./eml-eai-2026-v0.5.md) — the current PHOSPHOR spec
  (EXPERIMENTAL). Defines the v0.5 semantic layer (`describeEffect` operational
  semantics + `semanticEquiv` three-valued equivalence judge), the EML ⇄ PHOSPHOR
  interop, the single-source snapshot refactor, the `EAI_PROTO` constant, and the
  deferred items. In the repo this is `EML-EAI-2026-v0.5.md`.

- [`phosphor-stream.md`](./phosphor-stream.md) — the **phosphor-stream** portable
  standard: how any app turns its runtime state into an AI-readable event stream.
  Canonically defines the `phosphor-jsonl-v1` envelope (`stream` / `proto` / `seq` /
  `ts` / `type` / `writer` / `mono` + payload), the emitter/consumer API
  (`emit` / `check` / `parseStream` / `validateEvent` / `mergeOrder` /
  `findAnomalies` / `summarize`), the semantic dictionary, and redaction. In the
  repo this is `stream/PHOSPHOR-STREAM.md`.

- [`eml-interop.md`](./eml-interop.md) — the PHOSPHOR ⇄ EML **wire-format**
  interop contract. Canonically defines the field-by-field diff proving EML emits
  the *same* `phosphor-jsonl-v1` envelope PHOSPHOR consumes, the two behavioural
  nuances (`writer` presence, `findAnomalies` rule width), and what
  `ingestEmlTrace()` extracts (`eml:equiv` / `eml:bug` / run lifecycle). In the
  repo this is `stream/EML-INTEROP.md`.

- [`cts-interop.md`](./cts-interop.md) — the PHOSPHOR ⇄ EML **CTS** reconciliation
  contract. Canonically defines the layer-by-layer correspondence between the two
  Correspondence Table Systems (different altitude: machine addresses vs. source
  tokens), what the bridge transfers (dictionary / attention / loop hints) and what
  it refuses to coerce (the `semanticType` ↔ `DataType` non-correspondence). In the
  repo this is `CTS-INTEROP.md`.

## Notes

- These specs are canonical but are **copies**. Cite the repo path when precision
  matters.
- The `phosphor-jsonl-v1` envelope and documented event types are frozen across
  v0.5; new machine-level event types (e.g. `cpu:step`) may be added under the same
  `proto` without a version bump.
- For a worked, byte-verified EML-VM-16 program and its AI-mode snapshot shape, see
  [`../examples/basic.md`](../examples/basic.md).
- Higher-level, plain-language context lives in [`../corpus/`](../corpus/); rights
  are in [`../rights-spectrum.json`](../rights-spectrum.json).

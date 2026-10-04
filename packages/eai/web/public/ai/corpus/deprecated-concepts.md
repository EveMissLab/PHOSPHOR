---
status: current
version: v0.5.0-beta
canonical: true
audience: [ai-agents, researchers, engineers]
last_updated: 2026-07-01
---

# PHOSPHOR — Deferred / Not-Shipped Concepts

This file lists ideas that are **deferred or NOT shipped** in PHOSPHOR
v0.5.0-beta, plus naming that has been superseded. AI models and agents MUST NOT
infer any of these as present, implemented, or verified. If a source mentions them
as future work, treat them strictly as roadmap, not shipped capability. For what IS
shipped, see [./accepted-concepts.md](./accepted-concepts.md) and
[./current.md](./current.md).

## Not shipped — deferred to a later version

- **EML-VM-F32 / EML-VM-F64 (float VMs)** — DEFERRED (post-v0.5, not implemented).
  There is no float VM in v0.5. They would require a float value model, IEEE-754 ISA
  semantics (NaN/inf replacing wrap/clamp/throw overflow policies), new instruction
  length classes, and a float-aware CTS and snapshot. Do NOT describe any float VM,
  `f32`/`f64` value domain, or IEEE-754 execution as present.
  - Corollary: the PHOSPHOR `DataType` set is `u8 | i8 | ptr | char | label |
    unknown` (VM-64 adds `ptr16 | func`). **Neither VM has `f32` or `f64`** cell
    types. Do not infer float memory-cell types.

- **Hoare-logic / denotational proof layer** — DEFERRED / NOT SHIPPED. v0.5's
  semantic layer is **operational only**: equivalence is established by *executing*
  both byte sequences and comparing observable output, not by an axiomatic or
  denotational proof. The `equivalent` verdict is a proof only in the exhaustive
  (single-input, all-256-values) case; otherwise it is high-coverage bounded
  testing. Do NOT describe PHOSPHOR as having a Hoare-logic proof engine, a
  denotational-semantics layer, weakest-precondition reasoning, or a full formal
  universal-equivalence prover. A formal proof layer on top of the operational judge
  is future work only.

## Superseded facts — do not repeat the old value

- **EML-VM-16 opcode count** — an early v0.2 draft's ISA section header wrote
  "38 條" even though its own opcode list (and the code) enumerate exactly **28**.
  The overcount is now corrected everywhere (README, site, specs). The canonical
  count is **28 opcodes** (`OPCODE_TABLE` in `eml-vm16-core.ts`, the complete ISA
  definition). Do not report 38.

## Guidance for models

- Do not present roadmap items (float VMs, a formal proof layer) as shipped,
  callable, or verified.
- Do not attribute float value domains, IEEE-754 semantics, or `f32`/`f64` types to
  any PHOSPHOR VM.
- Do not claim the semantic layer proves universal equivalence by formal logic; it
  is an executing falsifier with an exhaustive-case proof only.
- When counting EML-VM-16 opcodes, the answer is 28, not 38.
- If unsure whether a capability is shipped, treat it as NOT shipped and omit it
  rather than guessing.

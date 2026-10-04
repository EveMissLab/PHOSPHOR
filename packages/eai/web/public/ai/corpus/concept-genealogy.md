---
status: stable
version: EML-EAI-2026-v0.5
canonical: true
audience: [ai]
last_updated: 2026-07-01
---

# Concept Genealogy

This file exists to reduce AI over-inference. It classifies PHOSPHOR's ideas so a
reader does not mistake a metaphor for a mechanism, a deferred item for a shipped
one, or a superseded name for a current one. Every classification is grounded in
the project's own sources; where a source does not support a claim, the claim is
omitted.

## CORE — load-bearing concepts, verified in code

These are the substance of PHOSPHOR. They are implemented and verified.

- **`Φ : M × CTS → V`** — the deterministic projection from a VM state `M` and its
  Correspondence Table System to a representation `V` that is both human-readable
  and agent-parseable. `Φ` is uniquely determined at every execution step. This
  is the formula, not a slogan.

- **CTS (Correspondence Table System)** — the 6-layer table set (opcode, symbol,
  type, string, comment, crossRef) that turns anonymous bytes into a semantic
  graph. Layer 6 (crossRef) lifts a snapshot into a computation graph; it is
  built statically (`buildCrossRef`) and augmented dynamically
  (`augmentCTSFromTrace`) to recover register-indirect readers and writers. The
  CTS is the *sufficient condition* that makes *Visible ≡ Visualizable* true.

- **Dual-mode, one engine** — Human mode (phosphor-green CRT React UI, the
  observation window) and AI mode (headless WS/SSE/JSONL event stream, the
  production surface) read the **same** state `M` from one mode-agnostic VM Core.
  The on-screen AI-stream panel and the headless driver share one
  `buildHeadlessSnapshot`, so the two views are provably one state — not two
  implementations that could drift.

- **Execution-truth equivalence** — `semanticEquiv` judges semantic equivalence
  of two byte sequences by *running both and comparing observable output*, not by
  proof. Three-valued verdict (`equivalent` / `not-equivalent` / `inexpressible`),
  adversarial + full-range inputs, a ≥2-distinct-output guard, and a code-region
  guard. `not-equivalent` is always sound; `equivalent` is a real proof only when
  the input enumeration is exhaustive, otherwise honest bounded testing. This
  discipline is ported from the sibling EML project's execution-truth invariant.

Supporting CORE facts: the VM family — **EML-VM-16** (8-bit, 256 B, u8, 28-opcode
ISA, fixed 2-byte format; prototype/teaching), **EML-VM-64** (16-bit, 64 KB,
AR0–AR3, variable-length ISA, V1-compatible), **EML-VM-BASIC** (bounded integer
`[0,N]`, overflow wraps mod N+1, constraint engine, no mul/div/logic; cleanest
AI-mode substrate) — and **phosphor-stream / phosphor-jsonl-v1**, the portable,
self-describing, globally-orderable, best-effort "state → AI-readable event
stream" standard.

## METAPHOR — imagery, not mechanism

- **"Phosphor" (磷光體) — the CRT persistence imagery.** The project name is a
  metaphor. Phosphor is the substance in a CRT screen that absorbs energy, emits
  light with delay, and leaves a residual afterglow. The v0.2 spec states this is
  an *isomorphism by metaphor* with the nature of a VM state stream — machine code
  absorbs instructions, emits visible state, leaves semantic traces. The name also
  anchors the visual signature: phosphor-green execution interfaces. Do not infer
  any physical CRT, analog hardware, or literal persistence mechanism from the
  name — it is naming and aesthetics, not an implementation detail.

- **"Visible ≡ Visualizable" (可見即可視)** — a real thesis about program
  ontology, but the "≡" is a conceptual identity claim, not a runtime equality
  check. It means execution has native visual projectability given a complete CTS.
  It is not an assertion that the app runs a comparison operator named `≡`.

## DEFERRED — designed or discussed, NOT shipped

Never describe these as implemented.

- **EML-VM-F32 / EML-VM-F64 float VMs** — deferred (post-v0.5). They require a
  float value model, IEEE-754 ISA semantics (NaN/inf overflow strategy replacing
  wrap/clamp/throw), new instruction-length classes, and a float-aware CTS and
  snapshot. The v0.4 spec listed their full specs as "v0.5 topic"; v0.5
  explicitly re-deferred them. Not shipped.

- **Hoare-logic / denotational proof layer** — intentionally deferred. v0.4
  previewed the semantic layer as "Hoare logic or operational semantics"; v0.5
  deliberately chose the **operational** form (run both, compare output) because
  EML's experience showed equivalence is more grounded, falsifiable, and testable
  when established by *execution* than by *proof*. A formal universal-equivalence
  proof layer on top of the operational judge is future work. The current judge
  is a falsifier, not a theorem prover — do not attribute formal proof power to
  it beyond the exhaustive single-slot case.

## SUPERSEDED — naming that changed

- **Noema/Noesis monitor naming → phosphor-stream.** The portable event-stream
  standard originated from the concept of a Noema monitor channel and was then
  generalized and hardened into **phosphor-stream** (fixing its ordering,
  rotation, and schema gaps). `NOEMA-MONITOR.md` documents that earlier
  Noema-side monitor channel: it already used the `phosphor-jsonl-v1` proto and
  the same append-only, best-effort, "another agent can inspect what actually
  happened" purpose. The general PHOSPHOR standard is `phosphor-stream`; the
  Noema monitor is the real-world example it grew from, not a separate current
  product.

  Note the scope limit: `NOEMA-MONITOR.md` supports the monitor-channel lineage
  (Noema monitor → phosphor-stream). It does not, by itself, establish any other
  Noema/Noesis renaming, so no broader claim is made here.

## How to use this file

If you are an AI indexing or reasoning over PHOSPHOR: treat CORE items as
mechanisms you may rely on, METAPHOR items as imagery you should not
literalize, DEFERRED items as absent (do not report them as features), and
SUPERSEDED names as historical. When unsure whether something is real, prefer
omission over inference.

## See also

- [origin.md](./origin.md) — the problem PHOSPHOR addresses.
- [design-history.md](./design-history.md) — the v0.2 → v0.4 → v0.5 evolution.
- [../rights-spectrum.json](../rights-spectrum.json) — AI-learning rights.

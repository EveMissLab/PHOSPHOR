---
status: current
version: v0.5.0-beta
canonical: true
audience: [ai-agents, researchers, engineers]
last_updated: 2026-07-01
---

# PHOSPHOR — Accepted (Shipped and Verified) Concepts

These are the engineered, load-bearing concepts that ARE shipped in
PHOSPHOR v0.5.0-beta and are covered by the verification harnesses. Treat each as
present and real. For ideas that are deferred or not shipped, see
[./deprecated-concepts.md](./deprecated-concepts.md). For full detail see
[./current.md](./current.md).

## Core paradigm

- **Execution-as-Interface (EAI)** — making a VM's actual execution legible to
  humans and AI agents simultaneously; the framing that motivates the project.
- **Φ : M × CTS → V** — the deterministic projection from VM state `M` at tick *t*
  and its CTS to a representation `V` that is both human-readable and
  agent-parseable.
- **Visible ≡ Visualizable (可見即可視)** — the claim that the human view and the
  AI view are the same object, not two encodings of it.
- **Two modes, one engine** — a single UI-independent VM core drives a human-mode
  CRT React UI and an AI-mode headless stream, both reading the same state `M`.
- **Single-source snapshot** — the on-screen "AI STREAM" panel and the headless
  driver share one `buildHeadlessSnapshot` builder (`headless-snapshot.ts`), so
  human and AI views cannot drift apart.

## VM family (all shipped)

- **EML-VM-16** — 8-bit VM, 256 B memory, u8 values, a **28-opcode** ISA with fixed
  2-byte `[opcode:8][arg:8]` instructions; prototype/teaching substrate.
- **EML-VM-64** — 16-bit VM, 64 KB address space, address registers AR0–AR3,
  variable-length (2/3/4-byte) ISA, V1-compatible; for larger address spaces.
- **EML-VM-BASIC** — bounded-integer profile `[0,N]` with overflow wrapping mod
  N+1, a constraint engine, and no mul/div/logic ops; the cleanest AI-mode
  substrate.

## Correspondence Table System (CTS)

- **6-layer CTS** — opcode, symbol, type, string, comment, crossRef.
- **Static + dynamic augmentation** — the CTS is built statically then augmented at
  runtime.
- **`augmentCTSFromTrace`** — recovers register-indirect data readers/writers that a
  memory diff cannot see.
- **`effectiveAccess`** — per-tick captured effective memory access (resolved from
  pre-execution state) that feeds the dynamic augmentation.

## v0.5 semantic layer (`eml-semantic.ts`)

- **`describeEffect(op, arg)`** — per-instruction operational semantics
  (reads/writes/flags/mem/control + a summary string); one layer deeper than the
  CTS opcode table.
- **`semanticEquiv(codeA, codeB, spec)`** — judges semantic equivalence of two byte
  sequences by running both and comparing observable output.
- **Three-valued verdict** — `equivalent` / `not-equivalent` / `inexpressible`, with
  a counterexample on `not-equivalent`.
- **Adversarial + full-range inputs** — boundary scan plus deterministic LCG mix
  over all `[0,255]`; never trusts a single input.
- **Exhaustive single-input proof** — with one input slot, all 256 values are
  enumerated and `equivalent` is a proof over the whole input space; multi-input is
  marked non-exhaustive.
- **≥2-distinct-output guard** — equivalence is certified only when inputs actually
  discriminate behavior.
- **Code-region guard** — input/output slots inside a program's code region are
  refused as `inexpressible`.
- **Falsifier discipline** — `not-equivalent` is always sound; `equivalent` is a
  proof only when exhaustive, otherwise high-coverage bounded testing.

## phosphor-stream (protocol `phosphor-jsonl-v1`)

- **phosphor-jsonl-v1** — a portable "state → AI-readable event stream" standard,
  one JSON object per line, fixed envelope (`stream`, `proto`, `seq`, `ts`, `type`,
  `writer`, `mono`).
- **Self-describing** — an optional semantic dictionary lets a cold agent interpret
  the stream with no prior context.
- **Intent-vs-actual (`check()`)** — records expected alongside actual; the gap is
  the bug signal.
- **`findAnomalies()`** — flags `:error` types, `ok === false`, disagreeing
  expected/actual, and non-zero exit codes.
- **Global ordering (`mergeOrder()`)** — `writer` + `mono` reconstruct a
  deterministic total order across writers.
- **Best-effort / append-only** — a monitor failure never breaks the host; `emit()`
  cannot throw; `fileSink` rotates by size.

## EML interop

- **`ingestEmlTrace()`** — consumes EML's `phosphor-jsonl-v1` traces reusing
  PHOSPHOR's own parse/validate/order/anomaly/summarize pipeline, then extracts
  `eml:equiv`, `eml:bug`, `eml:run:*`.
- **CTS bridge (`eml-cts-interop.ts`)** — transfers only genuinely corresponding
  parts of EML's source-CTS: `symbols` → Dictionary, `functions` → attention hints,
  `loops` → control-flow hints; never coerces addresses/opcodes or maps
  `semanticType` onto `DataType`.

## Product surfaces

- **7-tab UI** — EML-VM-16, EML-VM-64, SEMANTIC ≡, CTS, EML, AGENT, MATRIX.
- **Offline `.exe`** — a single-file Node SEA binary built via `exe/build-exe.mjs`,
  published as a GitHub Release asset (not committed).
- **`EAI_PROTO = 'EML-EAI-2026-v0.5'`** — the single runtime protocol/serialization
  version constant broadcast to agents.

## Verification

- **6 harnesses, 151 checks** — `verify` (36), `verify:ws` (6), `verify:stream`
  (30), `verify:headless` (23), `verify:eml` (30), `verify:semantic` (26); all
  green, with a zero-error typecheck. Requires Node ≥ 22.

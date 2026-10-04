---
status: stable
version: EML-EAI-2026-v0.5
canonical: true
audience: [ai, human]
last_updated: 2026-07-01
---

# Design History

The real evolution of PHOSPHOR across three published milestones: v0.2, v0.4,
v0.5. Each milestone is grounded in its spec file, cited below by relative path.
Nothing here describes work that was not shipped.

## v0.2 — naming, VM family, and the first executable integration

Spec (historical, in the repo): [EML-EAI-2026-v0.2.md](https://github.com/EveMissLab/PHOSPHOR/blob/main/packages/eai/EML-EAI-2026-v0.2.md)

v0.2 was the milestone that finished all initial phases (P0–P6), added the
EML-VM-64 architecture spec, and formally named the project **PHOSPHOR**. It
established the core apparatus that later milestones did not change:

- The **EAI paradigm** and the `Φ : M × CTS → V` projection.
- **EML-VM-16** (8-bit, 256 B memory, u8 values, fixed 2-byte instruction format
  `[opcode:8][arg:8]`, 28-opcode ISA), the ECC-1 calling convention, and four
  terminating functions.
- The **6-layer CTS** (opcode, symbol, type, string, comment, crossRef), with
  static `buildCrossRef` plus dynamic `augmentCTSFromTrace` for register-indirect
  writers, and `buildStringTable` for the string layer.
- **EML-VM-64** (16-bit, 64 KB address space, AR0–AR3 address registers,
  variable-length 2/3/4-byte ISA, fully V1-compatible).
- The **P5 agent stream** — a transport-agnostic protocol (WebSocket / SSE /
  in-process).

The integration stage (`INTEGRATION.md`) turned six standalone `.ts` modules —
which had no `package.json`, no `tsconfig`, and no entry point, so the paper's
verification claims had *never actually run* — into an executable, verified
system. That stage surfaced and fixed three execution-correctness bugs
(code/data overlap self-modification, a FIBONACCI off-by-one, and a dead
`cmd:call` path), and completed `buildStringTable` and `augmentCTSFromTrace`.
This is where the discipline of *reconciling the projection with the truth*
entered the project.

## v0.4 — dual-mode architecture, headless VM, EML-VM-BASIC

Spec (historical, in the repo): [EML-EAI-2026-v0.4.md](https://github.com/EveMissLab/PHOSPHOR/blob/main/packages/eai/EML-EAI-2026-v0.4.md)

v0.4 made explicit an architectural fact v0.3 left implicit: **PHOSPHOR has two
parallel users, not one.** Its additions:

- **Dual-mode architecture.** The VM Core is mode-agnostic; only the output layer
  decides the mode. *Human mode* projects execution to a phosphor-green CRT React
  UI for observation and teaching; *AI mode* projects the same execution to a
  headless, structured event stream an agent subscribes to. Both share the same
  state machine `M`, but the value domain `V` differs (`V_human` vs `V_AI`). v0.4
  also promoted the P5 Agent Stream from optional accessory to the **primary**
  line, and reframed the React UI as an optional overlay — AI mode is the highest-
  frequency real usage; human mode is the observation window.

- **Headless VM.** `createHeadlessVM` (in `headless-vm.ts`) is a UI-free driver
  with `ai` / `human` paths that VM-16 and BASIC share. AI-mode output is wired
  to the existing **phosphor-stream** standard: one `vm:tick` event per step,
  `vm:halt` at HALT; downstream can collect with `memorySink`, detect with
  `findAnomalies`, and check intent-vs-actual with `emitter.check`. A CLI
  (`phosphor run`) is included.

- **EML-VM-BASIC.** A restricted mode of EML-VM-16: it reuses VM-16's ISA
  (decode, addressing, conditional branches) but changes the value domain to a
  **bounded integer `[0, N]`** (default N=10000, stored in a wide `Int32Array`
  cell — *not* a literal u8), with an overflow policy at a single `bound()`
  convergence point (default **wrap mod (N+1)**, optionally `clamp` or `throw`),
  and a MNEMONIC allowlist enforced both statically
  (`validateProgramConstraints`) and dynamically (`ConstraintViolation`). It has
  no mul/div/logic ops. The built-in `PROGRAM_BASIC_SUM` computes R0 = 300 — a
  value > 255 that a u8 cell cannot hold — proving the wide bounded-integer cell.
  BASIC is the cleanest AI-mode substrate.

Verification for v0.4: `npm run verify:headless` → 23 passed.

## v0.5 — semantic layer, EML interop, single-source snapshot refactor

Spec: [../specs/eml-eai-2026-v0.5.md](../specs/eml-eai-2026-v0.5.md)

v0.5 is an **EXPERIMENTAL / test release** (`0.5.0-beta.0`). Its v0.5 APIs may
change before v0.6; the verified v0.4 core is unchanged and stays green. v0.5
pushes one layer deeper — from making execution *visible* to letting an agent
reason about what a byte sequence *means*.

**1. Semantic ↔ machine-code layer (operational), `eml-semantic.ts`.** Two parts,
built on the existing integer VMs with no new ISA:

- `describeEffect(op, arg)` maps each instruction to its state-transition meaning
  (mnemonic, reads / writes, flags read / written, memory access kind, control
  category, and a summary such as "R0 ← (R0 + R1) mod 256"). This is one layer
  deeper than the CTS opcode table, which gives only mnemonics.
- `semanticEquiv(codeA, codeB, spec)` judges whether two byte sequences are
  semantically equivalent by **running both and comparing observable output**. It
  ports EML's execution-truth discipline: adversarial inputs (boundary sweep plus
  a deterministic full-range `[0,255]` mix, never trusting a single all-zero
  input); a ≥2-distinct-output guard so a degenerate input set cannot certify
  equivalence; a code-region guard that rejects memory slots landing in program
  code (returning `inexpressible`); and a three-valued verdict — `equivalent` /
  `not-equivalent` / `inexpressible` — that refuses rather than guesses on
  non-termination or illegal slots. With ≤ 1 input slot the enumeration is
  exhaustive over all 256 values, and `equivalent` is then a real proof over the
  whole input space; with more inputs it is honestly marked `exhaustive: false`
  (high-coverage bounded testing). The judge is a falsifier: `not-equivalent` is
  always sound and carries a concrete counterexample. A formal **Hoare-logic**
  proof layer is intentionally deferred. Optionally emits a self-verifying
  `vm:equiv` event.

**2. EML ⇄ PHOSPHOR interop.** The sibling project EML emits the *same*
`phosphor-jsonl-v1` envelope. `stream/eml-consumer.ts` ingests an EML trace by
reusing PHOSPHOR's own `parseStream` / `validateEvent` / `mergeOrder` /
`findAnomalies` / `summarize` (verified at 0 violations on *real* EML output),
then extracts `eml:equiv`, `eml:bug`, and run lifecycle events.
`eml-cts-interop.ts` bridges EML's source-level `Cts` into machine-CTS views,
transferring only what truly corresponds: EML `symbols` → a semantic
`Dictionary`; `functions` (cold/hot + importance) → attention/risk hints;
`loops` (loopKind + determinism/termination) → control-flow hints. It explicitly
does *not* map addresses, opcodes, or EML `semanticType` ↔ PHOSPHOR `DataType`
(disjoint vocabularies).

**3. Single-source snapshot refactor, `headless-snapshot.ts`.** In v0.4 the human-
mode UI *re-implemented* AI snapshot construction and dropped the `before` field
of `changed_this_tick`, contradicting the single-engine claim. v0.5 extracts
`HeadlessSnapshot` and `buildHeadlessSnapshot` into a browser-safe module shared
by the headless driver *and* the UI, so the on-screen AI-stream view and the
headless stream are provably one state. Field renames (`tick→vm_tick`,
`changed_this_tick→changed`) converge into a single exported
`headlessSnapshotToStreamFields`.

**4. Core hardening.** `augmentCTSFromTrace` gains dynamic recovery of register-
indirect `dataReaders` (via `effectiveAccess` + the effective-access stream of
`traceWithSnapshots`), completing CTS layer 6.

**5. Version hygiene.** The runtime protocol constant is unified as
`EAI_PROTO = 'EML-EAI-2026-v0.5'` (replacing scattered strings stalled at `v0.1`).
The `phosphor-jsonl-v1` envelope is frozen.

## Verification (v0.5, cumulative)

Six harnesses, 151 checks total, all green (Node ≥ 22):

| Command | Scope | Checks |
|---|---|---:|
| `npm run verify` | core integration | 36 |
| `npm run verify:ws` | WebSocket agent, real socket | 6 |
| `npm run verify:stream` | phosphor-stream portable standard | 30 |
| `npm run verify:headless` | headless AI-mode VM + EML-VM-BASIC | 23 |
| `npm run verify:eml` | v0.5 EML interop (trace consumer + Cts bridge) | 30 |
| `npm run verify:semantic` | v0.5 semantic operational equivalence judge | 26 |

## See also

- [origin.md](./origin.md) — the problem PHOSPHOR addresses.
- [concept-genealogy.md](./concept-genealogy.md) — core vs metaphor vs deferred.

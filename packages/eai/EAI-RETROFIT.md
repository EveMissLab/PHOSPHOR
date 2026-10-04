# EAI-RETROFIT — CTS as domain-agnostic roles, and a determinism tier system

**EML-EAI-2026-v0.7 · Phase 3 groundwork · EXPERIMENTAL**
EveMissLab（一言諾科技有限公司）· 2026

> This is the specification half of Phase 3 (see `WORKPLAN.md`). The other
> half — a guided, collaborative process for actually applying it to a target
> codebase — is `skills/phosphor-adopt/SKILL.md`. This document defines what
> that process is trying to produce and where it is honestly allowed to stop.

## 1. The claim, restated without VM-16's vocabulary

PHOSPHOR's whole thesis is `Φ : M × CTS → V` — a system's actual execution
state `M`, paired with a Correspondence Table System `CTS`, projects into a
view `V` that is simultaneously human-readable and machine-parseable. Through
v0.6 this was proven on three targets, but all three are **virtual machines**:
EML-VM-16, EML-VM-64, EML-VM-BASIC, and (v0.6) real WebAssembly. `CTS`'s six
layers were named for that shape — `opcodeTable`, `symbolTable`, and so on —
because that's what the first target needed. `wasm-cts.ts` already had to
partially re-derive them (WASM splits code and memory into two address
spaces VM-16 never had), which is the first real evidence the *original*
six-layer vocabulary was never actually the general form — it was VM-16's
form, discovered to mostly transfer.

This document names the general form directly, so the next target doesn't
have to rediscover it by accident the way `wasm-cts.ts` did.

## 2. Six roles, not six VM-instruction-table columns

| # | Role | VM-16 instance | WASM instance | General question |
|---|------|-----------------|----------------|-------------------|
| 1 | **Unit Vocabulary** | `opcodeTable` — 28 opcodes | the ~30-op WASM-MVP subset | What is the finite catalog of atomic state-transition units this system performs, and what does each one mean? |
| 2 | **Location Naming** | `symbolTable` — address → label | data-segment symbols (memory only; WASM has no addressable *code* positions to name this way) | What stable, human-meaningful names bind to positions in `M`? |
| 3 | **Region Typing** | `typeTable` — code/data/stack/... | data-segment regions | How is `M`'s address space divided into kinds, and how should each kind be rendered? |
| 4 | **Decoded Content** | `stringTable` — ASCII runs | same rule, ported byte-for-byte | Where does `M` hold values that are only meaningful once decoded (text, structured payloads, enums)? |
| 5 | **Intent Annotation** | `commentTable` — why, not what | *(not yet populated for WASM — v0.6 left this empty; a real gap, not a design choice)* | What carries the *reason* behind a state or transition, not just its shape? |
| 6 | **Provenance Graph** | `crossRefTable` — callers/readers/writers | dynamic write-attribution only (no static cross-ref; WASM's structured control flow makes static analysis a different, harder problem VM-16's flat address space didn't pose) | For a given position in `M`, what produced it, and what does it flow into? |

Two things the table makes visible rather than hiding:

- **Not every role has to be populated for every target.** WASM's Layer 5 is
  empty and Layer 6 is dynamic-only. That's an honest, reported gap — not
  evidence the reframing failed. A retrofit that leaves a role empty because
  the target genuinely has nothing there is fine; a retrofit that *fakes*
  content for an empty role to look complete is the failure mode to avoid.
- **Code and state are not always the same address space.** VM-16 assumed
  they were (one flat 256-byte memory holds both program and data). WASM
  proved that's not universal (code lives in a separate space from linear
  memory). A retrofit onto a new target must check this explicitly — Role 2
  (Location Naming) and Role 6 (Provenance) both need to know which space
  they're naming/tracing before either can be built correctly.

### 2.1 `M` doesn't have to be a program being stepped through

Three retrofits in, `M`'s shape has genuinely varied, not just its address
space:

| Target | Shape of `M` | What "one atomic step" is |
|--------|--------------|-----------------------------|
| EML-VM-16 / EML-VM-64 / EML-VM-BASIC / WASM-MVP | A program (instruction tape) being executed | One instruction |
| `rpn/` | A linear token sequence being evaluated | One token |
| CTCL-App's `TemporalSystem::local_seconds()` | **No program at all** — a fixed formula evaluated against a varying input | One `(system, parent_sec) → local_seconds` call |

The third one is the interesting case: there's nothing to step *through*. `M`
is the pair (a static definition, one input value), and `Φ` projects a
*single evaluation*, not a trace of a mutating machine. It still qualifies as
Tier 1 — no clock read inside the step (`parent_sec` is an explicit
parameter, never a live clock read), no randomness, trivially replayable —
which means Tier 1 was never really "VM-shaped state machines"; it's "no
clock, no randomness, replayable", and a pure function is the degenerate,
simplest case of that, not an exception to it.

This retrofit is also the first one applied outside PHOSPHOR's own repo —
`ctcl-app` (github.com/kakon77777-commits/ctcl-app), on branch
`phosphor-adopt-retrofit`, `ctcl-core/src/phosphor.rs`. It left Role 5
(Intent Annotation) genuinely empty too, for a different reason than WASM
did: not "not built yet", but "no existing per-system commentary in the
target's data model to draw from" — a second, distinct flavor of honest
absence, worth telling apart from the first.

## 3. Determinism tiers — what `Φ`'s guarantee actually costs

VM-16's `Φ` guarantee is strong because VM-16 makes it cheap: no clock, no
randomness, one `stepOnce` call is the entire unit of change, and replaying
the same program from the same state always produces the same trace. That
guarantee does not come free on every system, and claiming it does is exactly
the kind of overclaim this project's own `semanticEquiv`/`wasmSemanticEquiv`
discipline (three-valued verdicts, `inexpressible` over a guess) argues
against making anywhere else in the codebase either.

| Tier | Shape | `Φ`'s honest guarantee | Proven on |
|------|-------|------------------------|-----------|
| **1 — Deterministic, tick-based** | No clock, no randomness, one atomic step is the whole unit of change, fully replayable from a snapshot | The full guarantee: `V` and any independently-computed re-run agree exactly. This is what `verify:wasm`'s cross-check against Node's native engine actually tests. | EML-VM-16/64/BASIC, WASM-MVP, `rpn/`, CTCL-App's `TemporalSystem` (external repo) |
| **2 — Event-driven, instrumentable** | Real I/O, concurrency, or external state, but the app can still emit a structured event per meaningful transition | Best-effort — the same posture `phosphor-stream`'s own design doc already commits to ("never breaks the host", not "never misses an event"). `V` is *a* faithful account of what happened, not a provably complete one. | Not yet attempted on a real target — this is exactly what Tier 2 retrofits will have to establish empirically, not assume |
| **3 — Non-deterministic / distributed** | Multiple independent clocks, no single authoritative state, ordering itself is only approximately recoverable | Partial/approximate `V` only. `Φ` cannot promise "the same object, two views" here — at best "a view of a view" | Out of scope for `phosphor-adopt` v1 entirely |

**v1 scope is Tier 1 only.** `skills/phosphor-adopt/SKILL.md` classifies a
target's tier as its first real step, and refuses (not guesses) past Tier 1
for now. This mirrors the same "answer honestly or refuse" instinct as
`semanticEquiv`'s `inexpressible` verdict — extending the skill to Tier 2 is
real future work, not something to fake by quietly relabeling a Tier 2 system
as Tier 1 to make the retrofit look done.

## 4. What "done" looks like for one retrofit

A completed Tier 1 retrofit produces, for the target system:

1. A short written mapping: which of the six roles apply, which are
   deliberately empty, and why (mirrors §2's WASM row).
2. A snapshot builder — one pure function `(state, cts) → V` — reusing
   `stream/phosphor-stream.ts`'s emitter as-is (it is already domain-agnostic;
   nothing about it is VM-specific and nothing here needs to change it).
3. At least one real run of the target, captured as a `phosphor-jsonl-v1`
   trace, checked against an independent computation of the same run (the
   same discipline `verify:wasm` used against Node's engine — an
   independently-derived cross-check, not internal self-consistency).

`rpn/` is the second worked example built to this checklist (the first being
WASM itself) — see `INTEGRATION.md` §6.9 for what it found. The third is
CTCL-App's `TemporalSystem::local_seconds()` (`ctcl-app` repo, branch
`phosphor-adopt-retrofit`) — the first retrofit `phosphor-adopt` was actually
used on outside this repo, and the first target whose `M` isn't a program
being stepped through at all (see §2.1).

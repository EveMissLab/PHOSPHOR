---
name: phosphor-adopt
description: Guided, collaborative retrofit of PHOSPHOR's Execution-as-Interface (EAI) pattern — Φ:M×CTS→V — onto an existing codebase, so its real execution becomes simultaneously human-readable and AI-parseable. Use when the user asks to "make my app's execution legible to an AI agent", "add a phosphor-jsonl-v1 stream to my project", "give my system a CTS", "retrofit PHOSPHOR onto X", or similarly wants a running system's actual state exposed as a structured, self-describing event stream rather than inferred from logs or source. Deliberately scoped to Tier 1 (deterministic, tick-based, replayable) systems in v1 — classifies the target first and stops, rather than guessing, if it isn't one.
---

# phosphor-adopt

You are retrofitting one specific capability onto the user's codebase: a
snapshot builder `(state, cts) → V` that projects the target's REAL execution
state into a view that is simultaneously readable by a human and parseable by
an AI agent — the same discipline `PHOSPHOR` (github.com/EveMissLab/PHOSPHOR/tree/main/packages/eai)
already proved on three virtual machines and a real WebAssembly interpreter.

This is a **guided, collaborative** process, not a one-shot code generator.
Each step below produces something you show the user before moving to the
next one. Do not skip straight to writing code — the step that most needs a
human in the loop (the CTS mapping draft, step 3) is exactly the step most
tempting to skip.

## Why guided, not automated

A wrong CTS mapping doesn't look wrong — it looks like a plausible view that
happens to lie about what the system did. That failure mode is worse than no
projection at all, because it's the kind of error nobody notices until it
matters. This is the same reason PHOSPHOR's own equivalence judges
(`semanticEquiv`, `wasmSemanticEquiv`) refuse to guess and return
`inexpressible` rather than force an answer — apply the same instinct here:
propose, then wait for a human to confirm, rather than commit to a mapping
that was never checked.

## Step 1 — Classify the target's determinism tier

Ask, or inspect the code to determine:

- Is there a clean, atomic "step" — one function that takes the current state
  and produces the next state? (It doesn't have to be called that; a request
  handler, a game-loop tick, a reducer are all candidates.)
- No wall-clock reads, no `Math.random()` / equivalent, inside that step?
- Is a full run replayable — same inputs, same trace, every time?

**If yes to all three: Tier 1.** Continue to Step 2.

**If no to any of them:** this is Tier 2 (event-driven but instrumentable —
real I/O or concurrency, but the app can still emit a structured event per
meaningful transition) or Tier 3 (multiple independent clocks, no single
authoritative state). **Stop here and say so explicitly.** Tier 2/3 retrofits
are real future work, not something to fake by quietly treating a Tier 2
system as Tier 1. Tell the user what you found and that this skill's v1
scope ends at Tier 1 — don't produce a projection that can't back up the
guarantee a Tier 1 one implies.

## Step 2 — Find the address-space shape

Before naming anything, check: does "the program" and "the state it operates
on" live in the SAME addressable space, or two SEPARATE ones?

This is not a rhetorical question — PHOSPHOR's own two reference
implementations disagree. EML-VM-16 has one flat 256-byte memory holding both
code and data. WebAssembly does not: code lives in a separate space from
linear memory, and the WASM retrofit (`wasm/wasm-cts.ts`) only got this right
because it checked rather than assumed VM-16's answer generalized. Get this
wrong and Step 3's Location Naming / Provenance roles will be built against
the wrong space.

## Step 3 — Draft the CTS mapping, role by role — then STOP and show it

Six roles (see `EAI-RETROFIT.md` in the PHOSPHOR repo for the full rationale
and three worked examples — VM-16/WASM, a from-scratch stack-based RPN
calculator sharing no code with either, and CTCL-App's
`TemporalSystem::local_seconds()`, a pure formula with no program to step
through at all, applied in a completely separate repo). For each role,
either propose a concrete mapping for THIS target, or mark it explicitly
"not applicable, because ___". **Never fabricate content for a role that
doesn't apply** — an honest empty role (like WASM's empty Layer 5, or the RPN
target's empty Layer 4) is a correct answer; invented content is not.

| # | Role | What to look for in the target |
|---|------|----------------------------------|
| 1 | **Unit Vocabulary** | The finite catalog of atomic transitions the step function can perform. An opcode table, a reducer's action-type union, a route table. |
| 2 | **Location Naming** | Stable, human-meaningful names bound to positions in state — variable names, table columns, named slots, whatever "position" means for this target per Step 2. |
| 3 | **Region Typing** | How the state divides into kinds (code/data/stack/heap; or request/session/cache; whatever fits) and how each kind should be rendered. |
| 4 | **Decoded Content** | Anywhere raw values are only meaningful once decoded — encoded payloads, packed structs, printable byte runs. Often legitimately empty; don't force it. |
| 5 | **Intent Annotation** | Where the *why* lives — docstrings, inline comments, spec references bindable to a position in the unit vocabulary or the state. |
| 6 | **Provenance Graph** | For a given position, what wrote it and what reads it. Usually has to be recovered DYNAMICALLY (fold a run's snapshots, the way `augmentCTSFromTrace` / `augmentRpnProvenance` do) rather than derived statically, especially once there's any indirection. |

Present the six-row table for the actual target, with your proposed mapping
(or explicit "not applicable") in each row. **Wait for the user to confirm or
correct it before writing any code.** If they change something, that's the
process working, not a failure to get it right the first time.

## Step 4 — Build the snapshot builder

Once the mapping is confirmed:

1. A `CTS`-shaped type for this target (do NOT force-fit an existing
   PHOSPHOR `CTS` type structurally unless the target's addressable positions
   are genuinely the same shape — `wasm-cts.ts` could reuse VM-16's `CTS`
   type because both key by a numeric address; the RPN retrofit could not,
   because its positions are variable names, and forcing the reuse would
   have been the exact mistake this skill exists to avoid).
2. One pure function `buildSnapshot(state, cts) → V`, matching the contract
   every PHOSPHOR snapshot builder uses: no side effects, callable from both
   a live driver and (if the target has a UI) a rendering layer, so both
   surfaces are provably projections of the same object.
3. Wire it to the target's event stream. If the target already depends on
   PHOSPHOR, reuse `stream/phosphor-stream.ts`'s `createEmitter` as-is — it
   is already domain-agnostic and needs no changes for a new target. If it
   doesn't (the common case — this is someone else's codebase), either take
   the dependency (it's small and dependency-light — see the PHOSPHOR repo)
   or adopt the `phosphor-jsonl-v1` envelope shape (`stream`, `proto`, `seq`,
   `ts`, `type`, plus domain fields) without the library, whichever the user
   prefers. Ask; don't assume.

## Step 5 — Verify against an INDEPENDENT reference, not self-consistency

The retrofit isn't done when it runs without throwing — it's done when its
output has been checked against something that didn't come from the same
code path. What "independent" means scales with the target:

- Simple, pure computation: recompute the expected result directly (the RPN
  retrofit's `test-rpn.ts` just checks `area === w*h` in plain arithmetic).
- A target with an existing trusted implementation: run both, diff the
  observable output (the WASM retrofit cross-checks against Node's own
  native `WebAssembly` engine — the strongest form of this).
- Neither available: say so. A verify step that only checks "did it crash"
  is honest about being weaker evidence, not silently passed off as proof.

## Non-goals (v1) — say these explicitly if asked, don't quietly attempt them

- **No Tier 2/3 support.** A system that fails Step 1 gets told so, not
  force-fit.
- **No fully-automated one-shot mode.** Step 3's confirmation gate is load-
  bearing, not a formality — skipping it is exactly the failure mode this
  skill exists to prevent.
- **No fabricated CTS content.** An empty role is a valid, honest outcome.

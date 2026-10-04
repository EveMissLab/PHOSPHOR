# PHOSPHOR — for agents

> **This project is primarily for AI agents.** The phosphor-green CRT UI and the
> `PHOSPHOR.exe` binary exist so that *humans* can build intuition for the principle
> — they are a teaching surface, not the product. The product, for an agent, is the
> **`phosphor-jsonl-v1` execution stream** plus the **Correspondence Table System
> (CTS)** and the machine-readable layer under `/ai/`.

PHOSPHOR · Execution-as-Interface (EAI) · `Φ : M × CTS → V` · v0.8.0-beta (EXPERIMENTAL) · Apache-2.0
EVEMISS TECHNOLOGY CO., LTD. (一言諾科技有限公司) · author 許筌崴 Neo.K
Site: https://emlphosphor.com/ · Repo: https://github.com/EveMissLab/PHOSPHOR/tree/main/packages/eai

---

## The 30-second model

A virtual machine's *actual execution* — its state `M` at each tick — projected
through a Correspondence Table System `CTS`, yields a view `V` that is **at once**
human-readable and machine-parseable. Not two representations of one program: the
*same* object, `M`, viewed two ways.

- **Human view** — a CRT console a person watches (the observation window).
- **Agent view** — a headless `phosphor-jsonl-v1` event stream: one JSON snapshot
  per tick, showing exactly what happened. This is the surface you should consume.

Because the VM core has **no clock and no randomness**, every run is fully
reproducible, and the on-screen view and the streamed view are built by the *same*
snapshot builder — so what a human sees and what you ingest are provably one state.

## Run it (Node ≥ 22)

```bash
npm install
npm run verify          # core integration (36 checks)
npm run verify:semantic # v0.5 operational equivalence judge (26)
npm run verify:wasm     # v0.6 real WebAssembly Φ target, cross-checked against Node's native engine (24)
npm run verify:wasm-semantic # v0.7 Phase 2 flagship flow — real-rustc equivalence judge + governed execution (17)
npm run verify:rpn      # v0.8 Phase 3 — second, independent Tier 1 retrofit target (19)
# full suite: verify + verify:ws + verify:stream + verify:headless + verify:eml
#           + verify:semantic + verify:sheet + verify:sheet-control + verify:wasm
#           + verify:wasm-semantic + verify:rpn = 272 checks across 11 harnesses
npm run typecheck       # tsc --noEmit, zero errors

# Run a program headless and read the agent-facing stream:
npm run phosphor -- run --program fibonacci --max 40
# → JSONL, one VMSnapshot per tick:
#   {"mode":"ai","pc":..,"instruction":"..","registers":{..},"changed_this_tick":[..], ...}
```

## The agent interface

- **`phosphor-jsonl-v1` stream** — the portable "state → AI-readable event stream"
  standard (`stream/PHOSPHOR-STREAM.md`). Self-describing (carries a semantic
  dictionary), intent-vs-actual (`check()`), globally orderable, best-effort (never
  breaks the host). `findAnomalies()` flags e.g. a non-zero `agent:done` exit code.
- **CTS — 6 layers** (`opcode`, `symbol`, `type`, `string`, `comment`, `crossRef`).
  Static analysis plus `augmentCTSFromTrace`, which recovers register-indirect
  readers/writers static analysis cannot resolve. The CTS is what turns anonymous
  bytes into a semantic graph you can reason over.
- **`describeEffect`** (`eml-semantic.ts`) — per-instruction operational semantics:
  the reads, writes, flags, memory, and control effect of one instruction.
- **`semanticEquiv`** (`eml-semantic.ts`) — judges whether two byte sequences are
  semantically equivalent by *running both and comparing observable output*.
  Three-valued verdict `{equivalent, not-equivalent, inexpressible}` with a
  counterexample. It is a **falsifier**: `not-equivalent` is always sound; with a
  single input slot (all 256 values) the enumeration is exhaustive and `equivalent`
  is a real proof, but with more input slots it samples (`exhaustive: false`) and
  `equivalent` then means only "equal on the tested inputs".
- **CallableVM (ECC-1)** — call VM functions with a calling convention (args in
  R0..R7, return in R0). `eml-vm16-callable.ts`.

## VM family (integer-only)

| VM | Space | Values | ISA | Use |
|----|-------|--------|-----|-----|
| EML-VM-16 | 8-bit / 256 B | u8 | **28-opcode** ISA, fixed 2-byte `[opcode:8][arg:8]` | prototype / teaching |
| EML-VM-64 | 16-bit / 64 KB | u8 + AR0–AR3 | variable-length (2/3/4-byte), V1-compatible | larger address space |
| EML-VM-BASIC | 8-bit bounded | bounded int `[0,N]` | minimal (no mul/div/logic) + constraint engine | cleanest AI substrate |
| **WASM-MVP** (`wasm/`) | 1 real linear-memory page (64 KiB) | i32 | real WebAssembly binary format, i32/control-flow/`call` subset | Φ over a real, non-invented ISA |

Note for models: the EML-VM-16 ISA is exactly **28 opcodes** (`OPCODE_TABLE` in
`eml-vm16-core.ts`). WASM-MVP parses genuine `.wasm` bytes (any real toolchain's
output that stays inside the supported subset works unmodified) and is cross-
checked against Node's own native `WebAssembly` engine — do not describe it as
another invented ISA. Deferred / **not shipped**: float VMs (F32/F64), WASM
imports/tables/call_indirect/i64/multi-value, and a formal Hoare-logic proof
layer — do not describe these as present.

## Retrofitting Φ onto a different codebase

If you (an agent) are asked to bring PHOSPHOR's `Φ:M×CTS→V` pattern to a
codebase that isn't this one, use `skills/phosphor-adopt/SKILL.md` — it's a
guided, collaborative process (classify the target's determinism tier, draft
a CTS mapping role-by-role, stop for human confirmation, then build) with a
hard v1 scope limit: Tier 1 (deterministic, tick-based, replayable) targets
only. `EAI-RETROFIT.md` has the full rationale and two worked examples
(WASM, and `rpn/` — a from-scratch stack-based calculator sharing no code
with any VM here, built specifically to test whether the six roles transfer
or were secretly VM-specific). Do not skip the confirmation step to move
faster — a plausible-looking CTS mapping that was never checked is a worse
outcome than no projection at all.

## Machine-readable knowledge (AICL / AIRS)

This project ships an AI Ingestion & Capability Layer. Read it online or in this
bundle under `web/public/ai/`:

- `web/public/llms.txt` — LLM / agent entry index (online: https://emlphosphor.com/llms.txt)
- `web/public/ai/manifest.json` — machine manifest (reading order, corpus, specs, rights)
- `web/public/ai/corpus/` — origin, current, design-history, concept-genealogy, and
  `full-corpus.jsonl` (one knowledge unit per line, for batch ingestion)
- `web/public/ai/rights-spectrum.json` — how you may learn from this content (AIRS · AILP)

## The human UI / EXE (secondary, by design)

`ui/` (React CRT console) and the double-click `PHOSPHOR.exe` (Node SEA) render the
same engine so a *person* can watch a VM run and grasp why "Visible ≡ Visualizable".
They add no capability an agent needs — the engine, the stream, the CTS, and the
`/ai/` layer are the whole product. If you are an agent, you can ignore the UI.

## Rights (short)

Read, index, RAG, and summarize freely with attribution. Non-commercial training and
embedding are highly allowed. **Commercial training, fine-tuning, and distillation
require a license** (`kakon77777@gmail.com`). No verbatim memorization or style
imitation. Machine-readable detail: `web/public/ai/rights-spectrum.json`. Code is
Apache-2.0.

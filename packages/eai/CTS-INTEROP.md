# PHOSPHOR ⇄ EML — CTS interoperability contract

**EML-EAI-2026-v0.5 · EXPERIMENTAL**

Both projects ship a **CTS** (Correspondence Table System), and EML built its
[`Cts`](../EML/packages/types/src/cts.ts) "PHOSPHOR-compatible (whitepaper Appendix
C)". This document is the field-by-field reconciliation behind
[`eml-cts-interop.ts`](eml-cts-interop.ts). The headline finding:

> The two CTSes are the **same artifact shape at different altitudes and in
> different key spaces.** They are **not** field-for-field interchangeable. The
> bridge transfers the parts that genuinely correspond and refuses to coerce the
> parts that don't.

## Altitude & key space

| | PHOSPHOR CTS | EML Cts |
|---|---|---|
| Altitude | **machine** (bytes, registers, addresses) | **source** (EML/Python statements, functions) |
| Key space | memory **address** `u8` (`Map<u8, …>`) | **string** — symbol token / `node_id` |
| Built by | `resolveCTS` + `buildCrossRef` + `augmentCTSFromTrace` | `@eml/cts-generator` `generateCts` |
| Defined in | [`eml-vm16-core.ts`](eml-vm16-core.ts) `interface CTS` | `@eml/types` `interface Cts` |

## Layer-by-layer

| PHOSPHOR layer | EML field | Correspondence |
|---|---|---|
| L1 `opcodeTable` `u8→OpcodeEntry` | — | **machine-only**; no EML analog (EML has no ISA). |
| L2 `symbolTable` `u8→{name,region,type,size}` | `symbols` `token→{type,meaning,target}` | **Partial.** Both name low-level units, but PHOSPHOR keys by address & carries a memory `DataType`; EML keys by overlay token & carries a *meaning + Python template*. Bridged → a phosphor-stream **Dictionary** (`emlCtsToDictionary`), NOT into `symbolTable`. |
| L3 `typeTable` `RegionEntry[]` (address ranges) | — | **machine-only** (memory regions). EML's nearest concept is per-function cold/hot, surfaced as attention hints, not regions. |
| L4 `stringTable` `u8→string` | — | **machine-only** (decoded memory strings). |
| L5 `commentTable` `u8→string` | `commentTable` `node_id→string` | **Same shape, different key** (address vs node id). Not merged; EML comments stay node-keyed. |
| L6 `crossRefTable` `u8→{callers,dataReaders,dataWriters}` | `crossRefTable` `identifier→string[]` | **Conceptually parallel** (both are dependency graphs) but structurally different: PHOSPHOR = address → instruction-address sets by access kind; EML = identifier → source fragments that bind it. Not unified. |
| *(none)* | `nodes[]` `{id,source,python,dependencies,semanticType}` | source statements; `semanticType` is a **source category** (`function.cold`, `control.output`) split by `classifyEmlNode`, **never coerced** to a `DataType`. |
| *(none)* | `functions[]` `{temperature,pure,astHash,cached,importance,sideEffects}` | bridged → `CtsAttentionHint[]` (`emlCtsAttention`). |
| *(none)* | `loops[]` `{loopKind,deterministic,terminating}` | bridged → `CtsLoopHint[]` (`emlCtsLoops`). |

## The `semanticType` ↔ `DataType` non-correspondence (flagged)

EML node `semanticType` and PHOSPHOR `DataType` are **disjoint vocabularies** and
must not be mapped onto each other:

- PHOSPHOR `DataType = 'u8' | 'i8' | 'ptr' | 'char' | 'label' | 'unknown'` — the
  **type of a memory cell**. (VM-64 adds `'ptr16'|'func'`. **Neither has `f32`/`f64`**
  — float types are deferred past v0.5.)
- EML `semanticType ∈ {'function.cold','function.hot','binding.call','control.output',
  'algebraic.sum','expression', …}` — the **role of a source statement**.

A "cold function" is not a "u8 cell". `classifyEmlNode` keeps these as
`{domain, action}` labels; `eml-cts-interop.ts` exposes no `semanticType → DataType`
function by design.

## What the bridge provides (`eml-cts-interop.ts`)

- `parseEmlCts(json)` / `isEmlCts(x)` — safe ingest of EML Cts JSON.
- `emlCtsToDictionary(cts)` — `symbols` → phosphor-stream `Dictionary` (emit as
  `meta:dictionary` so an agent reads EML's overlay meanings cold).
- `emlCtsAttention(cts)` — `functions` → cold/hot + importance/risk hints
  (importance-sorted), the source-side analog of `typeTable` shading.
- `emlCtsLoops(cts)` — `loops` → control-flow hints.
- `digestEmlCts(cts)` — the three transferable views in one record.

Verified by `npm run verify:eml` against the real `eml cts` output for
`square_sum.eml` (8 symbols, 2 functions, 1 loop, 5 nodes).

## Roadmap note

A future direction (not in v0.5): when an EML program is compiled **down to an
EML-VM program**, the source-CTS `node_id`s and the machine-CTS addresses could be
joined by a compiler-emitted source-map, making L5/L6 genuinely unifiable. Today no
such compiler exists, so the bridge stays at the transferable-views level above.

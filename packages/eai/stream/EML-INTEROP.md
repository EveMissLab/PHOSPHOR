# PHOSPHOR ⇄ EML — `phosphor-jsonl-v1` interoperability

**EML-EAI-2026-v0.5 · EXPERIMENTAL**

[EML](../../EML) (the semantic-overlay transpiler) emits its compile / run /
execution-truth / bug events as the **same** `phosphor-jsonl-v1` wire format that
PHOSPHOR defines in [`phosphor-stream.ts`](phosphor-stream.ts). EML's
[`@eml/trace`](../../EML/packages/trace/src/index.ts) header states it "mirrors
PHOSPHOR's `stream/phosphor-stream.ts` … an independent minimal re-implementation,
not a copy." This document is the field-by-field diff that turns that claim into a
checked contract, so [`eml-consumer.ts`](eml-consumer.ts) can ingest EML traces
safely.

> The diff is also enforced in code: [`test-eml-consumer.ts`](test-eml-consumer.ts)
> runs a **real** committed EML trace
> (`EML/examples/phase2-cold-hot/square_sum.trace.jsonl`) through PHOSPHOR's own
> `validateEvent` and asserts **zero** envelope violations. Run `npm run verify:eml`.

## Envelope — identical

| Field    | PHOSPHOR `PhosphorEvent`            | EML `PhosphorEvent`                 | Match |
|----------|-------------------------------------|-------------------------------------|:-----:|
| `stream` | `string`                            | `string`                            | ✅ |
| `proto`  | `'phosphor-jsonl-v1'` (`PROTO`)     | `'phosphor-jsonl-v1'` (`PHOSPHOR_PROTO`) | ✅ |
| `seq`    | `number` (per-writer, not global)   | `number` (per-writer, not global)   | ✅ |
| `ts`     | `string` ISO-8601                   | `string` ISO-8601                   | ✅ |
| `type`   | `string` `"domain:action"`          | `string` `"domain:action"`          | ✅ |
| `writer?`| optional writer id                  | optional writer id                  | ✅ |
| `mono?`  | optional high-res tiebreaker        | optional high-res tiebreaker        | ✅ |
| *(rest)* | `[field: string]: unknown` payload  | `[field: string]: unknown` payload  | ✅ |

The two interfaces are structurally interchangeable. PHOSPHOR's `validateEvent`
accepts every EML event, and EML's whole documented type vocabulary matches
PHOSPHOR's `type` regex `^[a-z][a-z0-9]*(:[a-z0-9_]+)+$/i` (e.g. `eml:run:start`,
`eml:cache:hit`, `eml:bug:summary`, `eml:equiv`).

## Two behavioural nuances (compatible, worth knowing)

1. **`writer` presence.** PHOSPHOR's emitter *always* stamps an auto-generated
   `writer`; EML's emitter *omits* `writer` for single-writer streams (and
   `eml trace --deterministic` traces have none). PHOSPHOR's `mergeOrder` tolerates
   this — it tiebreaks by `writer ?? ''` then `mono ?? seq`, so a writer-less EML
   stream still totally orders by `ts → mono`. No action needed.

2. **`findAnomalies` rule width.** PHOSPHOR flags `type` ending in `:error`; EML
   flags `:(error|fail)` anywhere. Over EML's actual vocabulary the two agree:
   `eml:run:error` ends in `:error` (flagged by both), and `eml:bug` (CRITICAL/MAJOR)
   and a failed `eml:equiv` both carry `ok: false` (flagged by both). PHOSPHOR
   additionally flags any event whose `expected`/`actual` disagree even without an
   `ok` field — a strict superset for EML's `check()`-shaped events.

## What PHOSPHOR extracts from an EML trace

[`ingestEmlTrace()`](eml-consumer.ts) reuses PHOSPHOR's `parseStream` /
`validateEvent` / `mergeOrder` / `findAnomalies` / `summarize`, then lifts
EML-specific semantics:

- **`eml:equiv`** → `EquivVerdict[]` — execution-truth verdicts (EML-interpreter
  output vs real CPython output). These are semantic-equivalence assertions and are
  the natural upstream input to the v0.5 semantic-equivalence layer
  ([`eml-semantic.ts`](../eml-semantic.ts)): EML proves *high-level↔Python*
  equivalence; PHOSPHOR proves *bytecode↔bytecode* equivalence; both are the same
  "run both, compare observable output" move.
- **`eml:bug`** → `EmlBugSignal[]` — the 5-level BUG classification (CRITICAL …
  COSMETIC), already wire-flagged via `ok: false`.
- **`eml:run:start` / `:done` / `:error` / `:incomplete`** → run lifecycle.

## Versioning

The envelope (`stream`/`proto`/`seq`/`ts`/`type`/`writer`/`mono`) and the documented
event types are frozen on both sides; `proto` stays `phosphor-jsonl-v1` across
PHOSPHOR v0.5. New machine-level event types (e.g. `cpu:step`, `mem:write`) may be
added under the same `proto` without a version bump.

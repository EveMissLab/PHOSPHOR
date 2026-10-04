# phosphor-stream

**Turn your app's runtime state into an AI-readable event stream.**
A tiny, zero-dependency, drop-in standard so an AI agent can see what your app *actually did* — instead of guessing from the UI or re-reading the source.

Part of PHOSPHOR · EML-EAI-2026 · EveMissLab (一言諾科技有限公司)
Protocol: `phosphor-jsonl-v1`

---

## Why this exists (and why it isn't "just another logger")

Logs and OpenTelemetry are built for humans staring at dashboards and for sampling at scale. `phosphor-stream` is built for a different consumer: **an AI agent debugging or handing off your app.** Three things make it AI-first:

1. **Self-describing** — the stream can carry a *semantic dictionary*: each event type ships with a plain-language description of what it means and what "normal" looks like. A cold agent can interpret the stream with no prior context.
2. **Intent vs. actual** — events can record what was *expected* alongside what *happened*. The gap is the bug signal (exactly how PHOSPHOR caught its own fibonacci bug: observed value vs. ground truth).
3. **Replayable & orderable** — the whole stream can be merged into a deterministic total order and replayed to reconstruct causality.

If all you need is human dashboards or distributed tracing at scale, use OpenTelemetry. If you want your app to be *legible to an agent*, use this.

It is **best-effort and append-only**: a monitor failure must never break the host app. `emit()` cannot throw.

---

## 30-second drop-in

```ts
import { createEmitter } from './phosphor-stream';
import { fileSink } from './sink-node';

const mon = createEmitter({
  stream: 'myapp',
  sink: fileSink('./myapp-monitor.jsonl', { maxBytes: 5_000_000, maxFiles: 3 }),
});

mon.emit('file:read', { path: 'notes.md', bytes: 1204 });
mon.emit('agent:start', { agent: 'codex', cmd });
mon.emit('agent:done',  { agent: 'codex', code });   // code !== 0 is auto-flagged downstream
```

Browser side (funnel to a backend collector so all writers share one order):

```ts
import { createEmitter, httpSink } from './phosphor-stream';
const mon = createEmitter({ stream: 'myapp', sink: httpSink('/__phosphor') });
mon.emit('ui:click', { target: 'save-file' });
```

Intent-vs-actual in one call:

```ts
mon.check('compute:fib10', actual, 55);   // emits ok:false + expected/actual if they differ
```

---

## Protocol — `phosphor-jsonl-v1`

One JSON object per line. Required envelope:

| field | type | meaning |
|-------|------|---------|
| `stream` | string | app/stream id (`"myapp"`) |
| `proto` | string | always `"phosphor-jsonl-v1"` |
| `seq` | number | per-writer monotonic counter |
| `ts` | string | ISO-8601 timestamp |
| `type` | string | namespaced `domain:action` (e.g. `file:read`) |
| `writer` | string | *should* be set — writer-instance id; enables global ordering |
| `mono` | number | per-writer high-res tiebreaker |

Any additional top-level fields are the domain payload (`path`, `bytes`, `code`, `expected`/`actual`/`ok`, …). This matches traces already emitted in the wild, so existing `phosphor-jsonl-v1` logs validate unchanged.

---

## What this fixes vs. a hand-rolled v1 monitor

Three real flaws observed in the first ad-hoc implementation, fixed here and covered by tests:

1. **Global ordering.** Multiple writers (backend + browser + reloads) each reset `seq` to 1 and append to one file, so `seq` collides and `ts` can interleave. Every event now carries a `writer` id + `mono`; `mergeOrder()` reconstructs a deterministic chronological total order across writers.
2. **Unbounded growth.** `fileSink` rotates by size (`<file>.1 … .N`, oldest dropped) — append-only files no longer grow forever.
3. **Schema discipline.** A fixed envelope + `domain:action` type namespacing, enforced by `validateEvent()`.

---

## Consumer API (the agent side)

```ts
import {
  parseStream, validateEvent, mergeOrder,
  findAnomalies, summarize, replay, extractDictionary,
} from './phosphor-stream';

const events = mergeOrder(parseStream(fs.readFileSync('myapp-monitor.jsonl', 'utf8')));

summarize(events);        // { total, byType, writers, anomalies, span }
findAnomalies(events);    // events that look like bugs (see below)
extractDictionary(events);// the embedded semantic vocabulary, if any
replay(events, handler);  // feed back in order
```

`findAnomalies()` is the generic bug-signal extractor. An event is flagged when:
- its `type` ends with `:error`, or
- it carries `ok === false` (a failed `check()`), or
- it has `expected`/`actual` that disagree, or
- it has a non-zero exit-code field (`code`/`exitCode`/`status`).

This is the generalized form of "compare observed behaviour to intent" — the same move that caught the fibonacci bug by hand. (It flags a real `agent:done {code:1}`, and leaves `code:0` alone.)

---

## Semantic dictionary (the CTS analog)

```ts
const dictionary = {
  'file:read':  { description: 'A file was read from the workspace.', fields: { path: 'relative path', bytes: 'size' } },
  'agent:done': { description: 'A local agent process exited.',        fields: { code: 'exit code (0 = ok)' } },
};
const mon = createEmitter({ stream: 'myapp', sink, dictionary });
mon.emitDictionary();   // emits one meta:dictionary event; a cold agent now understands the vocabulary
```

---

## Privacy / redaction (before going public)

Events can carry paths, prompts, even file contents. Scrub or drop with a `redact` hook applied before any sink:

```ts
createEmitter({
  stream: 'myapp', sink,
  redact: (e) => e.type === 'auth:token' ? null            // drop entirely
                                          : { ...e, token: e.token ? '***' : e.token },  // scrub
});
```

---

## Files

| file | role |
|------|------|
| `phosphor-stream.ts` | core — emitter, sinks (memory/console/http), reader/analysis. Universal (Node + browser). |
| `sink-node.ts` | Node-only sinks: `fileSink` (size rotation), `stdoutSink`. |
| `test-stream.ts` | verification harness (`npm run verify:stream`) — 30 checks against ground truth. |

Verified: `npm run verify:stream` → 30 passed · `npm run typecheck` → clean.

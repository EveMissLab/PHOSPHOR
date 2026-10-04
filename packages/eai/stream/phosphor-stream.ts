/**
 * phosphor-stream — portable "state → AI-readable event stream" core
 * EML-EAI-2026-v0.2 · PHOSPHOR portable standard
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * A zero-dependency, best-effort emitter + reader for the `phosphor-jsonl-v1`
 * protocol: an append-only stream of JSON events that an AI agent can read to
 * see what an application ACTUALLY did, instead of guessing from UI or source.
 *
 * Design contracts:
 *   1. Best-effort — emit() NEVER throws. Monitor failure must not break the host app.
 *   2. AI-first — the stream is self-describing (a semantic dictionary) and carries
 *      intent (expected vs actual), so a cold agent can diagnose, not just read.
 *   3. Globally orderable — every event carries a `writer` id + monotonic `mono`
 *      so a consumer can reconstruct a total order across concurrent writers
 *      (the gap in the hand-rolled v1: per-writer `seq` resets collide).
 *
 * Universal (Node + browser). Node-only file/stdout sinks live in `sink-node.ts`.
 */

// ═══════════════════════════════════════════════════════════════════════════════
// § 1. Protocol
// ═══════════════════════════════════════════════════════════════════════════════

export const PROTO = 'phosphor-jsonl-v1';

/**
 * One event on the stream. Required envelope keys are always present; emitters
 * may attach arbitrary domain fields at the top level (matching the v1 traces
 * already emitted in the wild, e.g. Noema's `file:read` with `path`/`bytes`).
 */
export interface PhosphorEvent {
  stream: string;     // app/stream id, e.g. "noema"
  proto:  string;     // always PROTO
  seq:    number;     // per-writer monotonic counter (NOT globally unique)
  ts:     string;     // ISO-8601 timestamp
  type:   string;     // namespaced "domain:action", e.g. "file:read"
  writer?: string;    // writer instance id — SHOULD be set; enables global ordering
  mono?:   number;    // per-writer high-res tiebreaker for same-ts ordering
  [field: string]: unknown;   // arbitrary domain payload
}

/** CTS analog (Layer 4/5): describes the event vocabulary so an agent can interpret it cold. */
export interface TypeSpec {
  description: string;                  // what this event means + what "normal" looks like
  fields?: Record<string, string>;      // field name → human/AI-readable meaning
}
export type Dictionary = Record<string, TypeSpec>;   // event type → spec

// ═══════════════════════════════════════════════════════════════════════════════
// § 2. Sinks
// ═══════════════════════════════════════════════════════════════════════════════

/** A sink receives fully-formed events. Implementations must not throw on write. */
export interface Sink {
  write(event: PhosphorEvent): void;
}

/** Collects events in memory. For tests and in-process AI consumers. */
export function memorySink(): Sink & { events: PhosphorEvent[] } {
  const events: PhosphorEvent[] = [];
  return { events, write(e) { events.push(e); } };
}

/** Writes one JSON line per event to console (browser-safe). */
export function consoleSink(): Sink {
  return { write(e) { try { console.log(JSON.stringify(e)); } catch { /* noop */ } } };
}

/** Fan out to several sinks; one failing sink never blocks the others. */
export function multiSink(...sinks: Sink[]): Sink {
  return { write(e) { for (const s of sinks) { try { s.write(e); } catch { /* noop */ } } } };
}

/**
 * Fire-and-forget HTTP sink (browser → backend collector). Funnelling all
 * writers to one collector is the cleanest way to get a single global order
 * across processes. Best-effort: network failures are swallowed.
 */
export function httpSink(url: string, opts: { fetchImpl?: typeof fetch } = {}): Sink {
  const f = opts.fetchImpl ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  return {
    write(e) {
      if (!f) return;
      try {
        f(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(e) })
          .catch(() => { /* best-effort */ });
      } catch { /* noop */ }
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 3. Emitter
// ═══════════════════════════════════════════════════════════════════════════════

export interface EmitterOptions {
  stream:      string;
  sink:        Sink | Sink[];
  writer?:     string;                                   // default: auto-generated
  dictionary?: Dictionary;                               // semantic vocabulary (AI-first)
  redact?:     (e: PhosphorEvent) => PhosphorEvent | null; // scrub/drop before sink (null = drop)
  now?:        () => string;                             // injectable clock (default: ISO now)
  onError?:    (err: unknown) => void;                   // where swallowed errors go (default: noop)
}

export interface Emitter {
  readonly writerId: string;
  /** Emit an event. Never throws. */
  emit(type: string, fields?: Record<string, unknown>): void;
  /** Emit an intent-vs-actual check; returns whether actual matched expected. */
  check(type: string, actual: unknown, expected: unknown, fields?: Record<string, unknown>): boolean;
  /** Emit the semantic dictionary as a `meta:dictionary` event (call once at startup). */
  emitDictionary(): void;
  /** Derive a child emitter that merges `bound` fields into every event. */
  child(bound: Record<string, unknown>): Emitter;
}

let _writerCounter = 0;
function autoWriterId(): string {
  // Unique-enough per instance without crypto; varies by call order + time.
  const t = (typeof Date !== 'undefined') ? Date.now().toString(36) : '0';
  return `w${(++_writerCounter).toString(36)}-${t}`;
}

function jsonEq(a: unknown, b: unknown): boolean {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return a === b; }
}

const isType = /^[a-z][a-z0-9]*(:[a-z0-9_]+)+$/i;   // "domain:action" namespace shape

export function createEmitter(opts: EmitterOptions): Emitter {
  const sinks   = Array.isArray(opts.sink) ? opts.sink : [opts.sink];
  const writer  = opts.writer ?? autoWriterId();
  const now     = opts.now ?? (() => new Date().toISOString());
  const onError = opts.onError ?? (() => { /* noop */ });
  let seq = 0, mono = 0;

  const writeAll = (e: PhosphorEvent): void => {
    let out: PhosphorEvent | null = e;
    if (opts.redact) { try { out = opts.redact(e); } catch (err) { onError(err); return; } }
    if (!out) return;
    for (const s of sinks) { try { s.write(out); } catch (err) { onError(err); } }
  };

  const make = (bound: Record<string, unknown>): Emitter => ({
    writerId: writer,
    emit(type, fields) {
      // The whole point: this can never take down the host app.
      try {
        const e: PhosphorEvent = {
          stream: opts.stream, proto: PROTO,
          seq: ++seq, mono: ++mono, ts: now(), type, writer,
          ...bound, ...(fields ?? {}),
        };
        writeAll(e);
      } catch (err) { onError(err); }
    },
    check(type, actual, expected, fields) {
      const ok = jsonEq(actual, expected);
      this.emit(type, { ...(fields ?? {}), actual, expected, ok });
      return ok;
    },
    emitDictionary() {
      if (opts.dictionary) this.emit('meta:dictionary', { dictionary: opts.dictionary, proto: PROTO });
    },
    child(extra) { return make({ ...bound, ...extra }); },
  });

  return make({});
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 4. Reader / Consumer (the AI side)
// ═══════════════════════════════════════════════════════════════════════════════

/** Parse a JSONL blob into events, tolerating blank/malformed lines. */
export function parseStream(text: string): PhosphorEvent[] {
  const out: PhosphorEvent[] = [];
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s);
      if (e && typeof e === 'object') out.push(e as PhosphorEvent);
    } catch { /* skip malformed line */ }
  }
  return out;
}

export interface ValidationResult { valid: boolean; errors: string[]; }

/** Check an event against the v1 envelope contract. */
export function validateEvent(e: unknown): ValidationResult {
  const errors: string[] = [];
  const o = e as Record<string, unknown>;
  if (!o || typeof o !== 'object') return { valid: false, errors: ['not an object'] };
  if (typeof o.stream !== 'string') errors.push('missing string "stream"');
  if (o.proto !== PROTO)            errors.push(`proto must be "${PROTO}"`);
  if (typeof o.seq !== 'number')    errors.push('missing number "seq"');
  if (typeof o.ts !== 'string')     errors.push('missing string "ts"');
  if (typeof o.type !== 'string')   errors.push('missing string "type"');
  else if (!isType.test(o.type))    errors.push(`type "${o.type}" is not "domain:action"`);
  return { valid: errors.length === 0, errors };
}

/**
 * Reconstruct a total order across concurrent writers.
 * Primary key: ts (ISO sorts chronologically); tiebreak by writer, then mono/seq.
 * This is what makes per-writer `seq` collisions harmless — fixes the v1 gap.
 */
export function mergeOrder(events: PhosphorEvent[]): PhosphorEvent[] {
  return [...events].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    const aw = a.writer ?? '', bw = b.writer ?? '';
    if (aw !== bw) return aw < bw ? -1 : 1;
    return (a.mono ?? a.seq ?? 0) - (b.mono ?? b.seq ?? 0);
  });
}

export interface AnomalyOptions {
  /** Field names treated as exit codes; non-zero (and not null) is an anomaly. Default: ["code","exitCode","status"]. */
  codeFields?: string[];
}

/**
 * Turn a stream into bug signals. An event is an anomaly if:
 *   - its type ends with ":error", OR
 *   - it carries `ok === false` (a failed intent-vs-actual check), OR
 *   - it carries `expected`/`actual` that disagree, OR
 *   - it carries a non-zero exit code field.
 * This is the generic version of what we did by hand for the fibonacci bug:
 * compare observed behaviour against intent/ground truth.
 */
export function findAnomalies(events: PhosphorEvent[], opts: AnomalyOptions = {}): PhosphorEvent[] {
  const codeFields = opts.codeFields ?? ['code', 'exitCode', 'status'];
  return events.filter(e => {
    if (typeof e.type === 'string' && /:error$/.test(e.type)) return true;
    if (e.ok === false) return true;
    if ('expected' in e && 'actual' in e && !jsonEq(e.actual, e.expected)) return true;
    for (const f of codeFields) {
      const v = e[f];
      if (typeof v === 'number' && v !== 0) return true;
    }
    return false;
  });
}

export interface StreamSummary {
  total:     number;
  byType:    Record<string, number>;
  writers:   string[];
  anomalies: number;
  span:      { start: string | null; end: string | null };
}

/** A quick digest for an agent: counts, writers, time span, anomaly count. */
export function summarize(events: PhosphorEvent[]): StreamSummary {
  const byType: Record<string, number> = {};
  const writers = new Set<string>();
  let start: string | null = null, end: string | null = null;
  for (const e of events) {
    if (typeof e.type === 'string') byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (typeof e.writer === 'string') writers.add(e.writer);
    if (typeof e.ts === 'string') {
      if (start === null || e.ts < start) start = e.ts;
      if (end === null || e.ts > end) end = e.ts;
    }
  }
  return {
    total: events.length, byType, writers: [...writers],
    anomalies: findAnomalies(events).length, span: { start, end },
  };
}

/** Feed events (in order) through a handler — the Recorder/Replayer gene. */
export function replay(
  events: PhosphorEvent[],
  handler: (e: PhosphorEvent, index: number) => void,
  opts: { ordered?: boolean } = {},
): void {
  const seq = opts.ordered === false ? events : mergeOrder(events);
  seq.forEach((e, i) => handler(e, i));
}

/** Extract the most recent semantic dictionary embedded in a stream, if any. */
export function extractDictionary(events: PhosphorEvent[]): Dictionary | null {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'meta:dictionary' && events[i].dictionary) {
      return events[i].dictionary as Dictionary;
    }
  }
  return null;
}

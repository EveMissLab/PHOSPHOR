/**
 * EML trace consumer — PHOSPHOR ingests an EML `@eml/trace` stream
 * EML-EAI-2026-v0.5 · closes the EML → PHOSPHOR loop
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * EML (the semantic-overlay transpiler) emits its compile/run/equiv/bug events as
 * the SAME `phosphor-jsonl-v1` envelope PHOSPHOR defines — independently, with no
 * runtime dependency on PHOSPHOR. Both repos' docs promise the handoff ("EML feeds
 * PHOSPHOR") but nothing was wired. This module wires it: it reuses PHOSPHOR's own
 * `parseStream` / `validateEvent` / `mergeOrder` / `findAnomalies` / `summarize`
 * (proving the envelopes are interchangeable) and layers EML-aware semantic
 * extraction on top — most importantly the `eml:equiv` verdicts, which are
 * execution-truth semantic-equivalence assertions and the natural input to the
 * v0.5 semantic-equivalence layer (see eml-semantic.ts).
 *
 * Envelope compatibility is verified, not assumed: every line is checked against
 * PHOSPHOR's v1 envelope and any violation is reported in `invalidLines`. A valid
 * EML trace yields zero. See stream/EML-INTEROP.md for the full field-by-field diff.
 */

import {
  type PhosphorEvent,
  type StreamSummary,
  parseStream, validateEvent, mergeOrder, findAnomalies, summarize,
} from './phosphor-stream';

/** An `eml:equiv` verdict — interpreter output vs real execution (execution truth). */
export interface EquivVerdict {
  ok:        boolean;        // true ⟺ the two representations produced equal output
  expected?: unknown;       // ground-truth (e.g. real CPython stdout)
  actual?:   unknown;       // the candidate (e.g. EML interpreter stdout)
  ts:        string;
}

/** An `eml:bug` signal lifted from the 5-level BUG classifier. */
export interface EmlBugSignal {
  level?:   string;          // CRITICAL | MAJOR | MINOR | TRIVIAL | COSMETIC
  code?:    string | number;
  message?: string;
  ts:       string;
}

/** A spliced temporal event (eml:temporal:*) from `eml trace --run` on async code. */
export interface EmlTemporalEvent { type: string; ok?: boolean; ts: string; }

/**
 * Run-lifecycle reconstructed from the EML run events.
 *
 * Note on `incomplete` vs `splicedComplete`: for an unsupported construct (e.g.
 * @temporal_loop / numpy) the EML INTERPRETER emits `eml:run:incomplete` and
 * defers. Under `eml trace --run`, the real Python execution is then spliced into
 * the SAME trace (eml:temporal:* / eml:python:exit). So `incomplete` means "the
 * interpreter deferred", NOT "the program never finished" — `splicedComplete`
 * reports whether the real execution actually completed.
 */
export interface EmlLifecycle {
  started:         boolean;
  done:            boolean;   // saw a clean eml:run:done (interpreter completed)
  errored:         boolean;   // saw eml:run:error
  incomplete:      boolean;   // saw eml:run:incomplete (interpreter deferred to Python)
  splicedComplete: boolean;   // real Python execution finished (exit 0 / temporal resolved ok)
}

export interface EmlTraceReport {
  summary:      StreamSummary;
  ordered:      PhosphorEvent[];                       // mergeOrder'd total order
  invalidLines: { index: number; errors: string[] }[]; // envelope violations (proto incompat)
  anomalies:    PhosphorEvent[];                       // findAnomalies over the stream
  equiv:        EquivVerdict[];                         // eml:equiv semantic-equivalence verdicts
  bugs:         EmlBugSignal[];                         // eml:bug events
  temporal:     EmlTemporalEvent[];                     // eml:temporal:* spliced from --run
  pythonExit:   number | null;                          // eml:python:exit code, if present
  lifecycle:    EmlLifecycle;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Ingest an EML `phosphor-jsonl-v1` trace (the text of a `.trace.jsonl` file, or
 * the output of `eml trace`). Pure: no I/O, no throw on malformed input.
 */
export function ingestEmlTrace(jsonl: string): EmlTraceReport {
  const events = parseStream(jsonl);

  const invalidLines: { index: number; errors: string[] }[] = [];
  events.forEach((e, i) => {
    const v = validateEvent(e);
    if (!v.valid) invalidLines.push({ index: i, errors: v.errors });
  });

  const equiv: EquivVerdict[] = [];
  const bugs:  EmlBugSignal[] = [];
  const temporal: EmlTemporalEvent[] = [];
  let pythonExit: number | null = null;
  const lifecycle: EmlLifecycle = { started: false, done: false, errored: false, incomplete: false, splicedComplete: false };

  for (const e of events) {
    if (typeof e.type === 'string' && e.type.startsWith('eml:temporal:')) {
      const ok = typeof e.ok === 'boolean' ? e.ok : undefined;
      temporal.push({ type: e.type, ok, ts: str(e.ts) ?? '' });
      // A resolved/done temporal step with ok:true means the real run progressed.
      if (ok === true && /:(done|resolved)$/.test(e.type)) lifecycle.splicedComplete = true;
      continue;
    }
    switch (e.type) {
      case 'eml:equiv':
        equiv.push({
          ok:       e.ok === true,
          expected: 'expected' in e ? e.expected : undefined,
          actual:   'actual'   in e ? e.actual   : undefined,
          ts:       str(e.ts) ?? '',
        });
        break;
      case 'eml:bug':
        bugs.push({
          level:   str(e.level),
          code:    typeof e.code === 'number' || typeof e.code === 'string' ? (e.code as string | number) : undefined,
          message: str(e.message),
          ts:      str(e.ts) ?? '',
        });
        break;
      case 'eml:python:exit':
        if (typeof e.code === 'number') {
          pythonExit = e.code;
          if (e.code === 0) lifecycle.splicedComplete = true;   // real Python finished cleanly
        }
        break;
      case 'eml:run:start':      lifecycle.started    = true; break;
      case 'eml:run:done':       lifecycle.done       = true; break;
      case 'eml:run:error':      lifecycle.errored    = true; break;
      case 'eml:run:incomplete': lifecycle.incomplete = true; break;
    }
  }

  return {
    summary:   summarize(events),
    ordered:   mergeOrder(events),
    invalidLines,
    anomalies: findAnomalies(events),
    equiv,
    bugs,
    temporal,
    pythonExit,
    lifecycle,
  };
}

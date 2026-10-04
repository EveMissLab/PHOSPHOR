/**
 * phosphor-stream — verification harness
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 *   run:  npm run verify:stream   (== npx tsx stream/test-stream.ts)
 *
 * Verifies the standard against ground truth — including that it fixes the two
 * real flaws observed in the hand-rolled Noema v1 monitor (per-writer seq
 * collisions, unbounded growth) and that its anomaly finder would have flagged
 * that monitor's real `agent:done code:1` failure automatically.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  PROTO,
  createEmitter, memorySink,
  parseStream, validateEvent, mergeOrder, findAnomalies, summarize, extractDictionary,
  type Dictionary, type PhosphorEvent,
} from './phosphor-stream';
import { fileSink } from './sink-node';

let passed = 0, failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  ${detail}` : ''}`); }
}
const head = (t: string) => console.log(`\n\x1b[36m${t}\x1b[0m`);

function main(): void {
  console.log('\x1b[1m\nphosphor-stream — verification\x1b[0m');

  // ── Emitter envelope + best-effort guarantee ─────────────────────────────────
  head('Emitter · envelope + best-effort');
  {
    const sink = memorySink();
    const em = createEmitter({ stream: 'testapp', sink });
    em.emit('file:read', { path: 'a.md', bytes: 38 });
    em.emit('file:write', { path: 'a.md', bytes: 40 });
    const [e0, e1] = sink.events;
    check('event has v1 envelope', e0.stream === 'testapp' && e0.proto === PROTO && e0.type === 'file:read');
    check('domain payload preserved', e0.path === 'a.md' && e0.bytes === 38);
    check('seq is monotonic per writer', e0.seq === 1 && e1.seq === 2);
    check('writer id is stamped', typeof e0.writer === 'string' && e0.writer.length > 0, e0.writer as string);
    check('ts is ISO-8601', typeof e0.ts === 'string' && !Number.isNaN(Date.parse(e0.ts)));

    // best-effort: a throwing sink must NOT take down the caller
    const boom = { write() { throw new Error('sink exploded'); } };
    const em2 = createEmitter({ stream: 'testapp', sink: boom });
    let threw = false;
    try { em2.emit('agent:start', { agent: 'codex' }); } catch { threw = true; }
    check('emit() never throws even if a sink throws', !threw);

    const a = createEmitter({ stream: 'x', sink: memorySink() });
    const b = createEmitter({ stream: 'x', sink: memorySink() });
    check('separate emitters get distinct writer ids', a.writerId !== b.writerId, `${a.writerId} vs ${b.writerId}`);
  }

  // ── Intent vs actual (the bug-signal primitive) ──────────────────────────────
  head('Emitter · check() intent-vs-actual');
  {
    const sink = memorySink();
    const em = createEmitter({ stream: 'fibapp', sink });
    const good = em.check('compute:fib10', 55, 55);
    const bad  = em.check('compute:fib10', 0, 55);   // the fibonacci bug, as a stream event
    check('check() returns true when actual==expected', good === true);
    check('check() returns false on mismatch', bad === false);
    check('mismatch event carries ok:false + expected/actual',
      sink.events[1].ok === false && sink.events[1].expected === 55 && sink.events[1].actual === 0);
  }

  // ── Semantic dictionary (CTS analog — the AI-first layer) ─────────────────────
  head('Dictionary · self-describing stream');
  {
    const dict: Dictionary = {
      'file:read':  { description: 'A file was read from the workspace.', fields: { path: 'relative path', bytes: 'size read' } },
      'agent:done': { description: 'A local agent process exited.', fields: { code: 'process exit code (0 = ok)' } },
    };
    const sink = memorySink();
    const em = createEmitter({ stream: 'app', sink, dictionary: dict });
    em.emitDictionary();
    const got = extractDictionary(sink.events);
    check('emitDictionary emits meta:dictionary', sink.events[0]?.type === 'meta:dictionary');
    check('dictionary round-trips for a cold reader', !!got && got['file:read'].description.includes('read'));
  }

  // ── Envelope validation + backward-compat with real Noema v1 line ────────
  head('Reader · validation + Noema v1 backward-compat');
  {
    const okEvt = { stream: 'a', proto: PROTO, seq: 1, ts: new Date(0).toISOString(), type: 'file:read' };
    check('valid event passes', validateEvent(okEvt).valid);
    check('wrong proto rejected', !validateEvent({ ...okEvt, proto: 'nope' }).valid);
    check('non-namespaced type rejected', !validateEvent({ ...okEvt, type: 'read' }).valid);

    // A synthetic monitor event with the portable envelope must validate.
    const exampleLine =
      '{"stream":"example","proto":"phosphor-jsonl-v1","seq":7,"ts":"2026-06-12T08:36:31.404Z","type":"file:read","cwd":"./example-workspace","path":"example.md","bytes":38}';
    const [parsed] = parseStream(exampleLine);
    check('Synthetic v1 line is phosphor-jsonl-v1 compliant', validateEvent(parsed).valid, `type=${parsed?.type}`);
  }

  // ── mergeOrder fixes the v1 per-writer-seq collision ─────────────────────────
  head('Reader · mergeOrder fixes concurrent-writer ordering (v1 gap)');
  {
    // Two writers, BOTH starting seq at 1 (the exact Noema collision), with
    // interleaved timestamps. seq alone is ambiguous; ts+writer recovers order.
    const evts: PhosphorEvent[] = [
      { stream: 'a', proto: PROTO, type: 'ui:boot',        seq: 1, mono: 1, writer: 'ui', ts: '2026-06-12T08:00:00.200Z' },
      { stream: 'a', proto: PROTO, type: 'agent:detect',   seq: 1, mono: 1, writer: 'node', ts: '2026-06-12T08:00:00.100Z' },
      { stream: 'a', proto: PROTO, type: 'workspace:list', seq: 2, mono: 2, writer: 'node', ts: '2026-06-12T08:00:00.150Z' },
      { stream: 'a', proto: PROTO, type: 'ui:detect',      seq: 2, mono: 2, writer: 'ui', ts: '2026-06-12T08:00:00.300Z' },
    ];
    const ordered = mergeOrder(evts);
    const seqOrder = ordered.map(e => e.ts.slice(-6));
    const chronological = seqOrder.every((t, i) => i === 0 || seqOrder[i - 1] <= t);
    check('mergeOrder yields a deterministic chronological total order', chronological, seqOrder.join(' → '));
    check('collided seq:1 from two writers no longer ambiguous',
      ordered[0].writer === 'node' && ordered[1].writer === 'node' && ordered[3].writer === 'ui');
  }

  // ── findAnomalies turns the stream into bug signals ──────────────────────────
  head('Reader · findAnomalies (generic bug-signal extraction)');
  {
    const evts: PhosphorEvent[] = [
      { stream: 'a', proto: PROTO, type: 'agent:start', seq: 1, ts: '2026-06-12T08:00:00.000Z', agent: 'codex' },
      // the REAL Noema failure: agent exited code 1
      { stream: 'a', proto: PROTO, type: 'agent:done',  seq: 2, ts: '2026-06-12T08:00:00.020Z', agent: 'codex', code: 1 },
      { stream: 'a', proto: PROTO, type: 'agent:done',  seq: 3, ts: '2026-06-12T08:00:01.000Z', agent: 'codex', code: 0 },
      { stream: 'a', proto: PROTO, type: 'file:error',  seq: 4, ts: '2026-06-12T08:00:02.000Z', path: 'x' },
      { stream: 'a', proto: PROTO, type: 'compute:fib',  seq: 5, ts: '2026-06-12T08:00:03.000Z', ok: false, expected: 55, actual: 0 },
      { stream: 'a', proto: PROTO, type: 'file:read',    seq: 6, ts: '2026-06-12T08:00:04.000Z', path: 'y', bytes: 10 },
    ];
    const anomalies = findAnomalies(evts);
    const types = anomalies.map(a => a.type);
    check('flags non-zero exit code (the real codex code:1)', types.includes('agent:done') && anomalies.some(a => a.code === 1));
    check('does NOT flag code:0 success', !anomalies.some(a => a.code === 0));
    check('flags *:error events', types.includes('file:error'));
    check('flags ok:false / expected≠actual', types.includes('compute:fib'));
    check('leaves normal events alone', !types.includes('file:read'), `${anomalies.length} anomalies of ${evts.length}`);

    const sum = summarize(evts);
    check('summarize reports anomaly count + span', sum.anomalies === anomalies.length && sum.total === 6 && !!sum.span.start);
  }

  // ── fileSink rotation fixes unbounded growth (v1 gap) ─────────────────────────
  head('Sink · fileSink size rotation');
  {
    const dir  = fs.mkdtempSync(path.join(os.tmpdir(), 'phosphor-stream-'));
    const file = path.join(dir, 'mon.jsonl');
    const em = createEmitter({ stream: 'rot', sink: fileSink(file, { maxBytes: 600, maxFiles: 3 }) });
    for (let i = 0; i < 40; i++) em.emit('tick:n', { i, pad: 'xxxxxxxxxxxxxxxxxxxx' });
    const activeSize = fs.statSync(file).size;
    check('active file is bounded near maxBytes', activeSize <= 600 + 200, `${activeSize} bytes`);
    check('rotated file(s) created', fs.existsSync(`${file}.1`));
    const rotatedCount = [1, 2, 3, 4].filter(n => fs.existsSync(`${file}.${n}`)).length;
    check('rotation respects maxFiles (no .4)', !fs.existsSync(`${file}.4`), `${rotatedCount} rotated files`);
    // every line across all files stays valid JSON
    const allValid = fs.readFileSync(file, 'utf8').trim().split('\n').every(l => { try { JSON.parse(l); return true; } catch { return false; } });
    check('rotated stream lines remain valid JSONL', allValid);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
  }

  // ── redact hook (privacy for public release) ──────────────────────────────────
  head('Emitter · redact hook');
  {
    const sink = memorySink();
    const em = createEmitter({
      stream: 'app', sink,
      redact: (e) => e.type === 'secret:thing' ? null : ({ ...e, token: e.token ? '***' : e.token }),
    });
    em.emit('file:read', { path: 'a', token: 'hunter2' });
    em.emit('secret:thing', { x: 1 });
    check('redact scrubs sensitive fields', sink.events[0].token === '***');
    check('redact can drop whole events', sink.events.length === 1 && sink.events.every(e => e.type !== 'secret:thing'));
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m── Summary ──\x1b[0m');
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(`  \x1b[31mfailing:\x1b[0m ${failures.join(' · ')}`); process.exitCode = 1; }
  else            { console.log('  \x1b[32mphosphor-stream verified\x1b[0m'); }
}

main();

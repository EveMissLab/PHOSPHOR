/**
 * phosphor-scan — read any phosphor-jsonl-v1 stream and report what happened.
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 *   npx tsx stream/scan.ts <file.jsonl>
 *
 * Prints a summary + the anomalies (bug signals) in a stream. This is the
 * "AI bug detector" as a one-shot tool: it compares observed behaviour against
 * intent / error markers and surfaces the discrepancies.
 */
import * as fs from 'node:fs';
import { parseStream, mergeOrder, summarize, findAnomalies, validateEvent } from './phosphor-stream';

const file = process.argv[2];
if (!file) { console.error('usage: tsx stream/scan.ts <file.jsonl>'); process.exit(2); }

const raw = fs.readFileSync(file, 'utf8');
const events = mergeOrder(parseStream(raw));
const sum = summarize(events);
const invalid = events.filter(e => !validateEvent(e).valid).length;

const c = { dim: '\x1b[2m', grn: '\x1b[32m', red: '\x1b[31m', cyn: '\x1b[36m', b: '\x1b[1m', x: '\x1b[0m' };

console.log(`${c.b}phosphor-scan${c.x} ${c.dim}${file}${c.x}`);
console.log(`  stream: ${c.cyn}${events[0]?.stream ?? '?'}${c.x} · ${sum.total} events · ${sum.writers.length} writer(s) · ${invalid} invalid`);
console.log(`  span:   ${sum.span.start ?? '-'} → ${sum.span.end ?? '-'}`);

const top = Object.entries(sum.byType).sort((a, b) => b[1] - a[1]);
console.log(`  types:  ${top.map(([t, n]) => `${t}×${n}`).join('  ')}`);

const anomalies = findAnomalies(events);
const salient = (e: Record<string, unknown>) =>
  ['agent', 'code', 'path', 'expected', 'actual', 'ok', 'message']
    .filter(k => k in e).map(k => `${k}=${JSON.stringify(e[k])}`).join(' ');

if (anomalies.length === 0) {
  console.log(`\n  ${c.grn}no anomalies${c.x}`);
} else {
  console.log(`\n  ${c.red}${anomalies.length} anomal${anomalies.length === 1 ? 'y' : 'ies'}:${c.x}`);
  for (const a of anomalies) {
    console.log(`    ${c.dim}${a.ts}${c.x}  ${c.red}${a.type}${c.x}  ${salient(a)}`);
  }
}

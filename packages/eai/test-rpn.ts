/**
 * PHOSPHOR · v0.7 — RPN Retrofit Verification (Phase 3 second Tier 1 target)
 * EML-EAI-2026-v0.7
 * EveMissLab（一言諾科技有限公司）· 2026
 *
 * Verifies EAI-RETROFIT.md's checklist actually holds for a second, genuinely
 * different architecture (stack-based, named variables, no registers, no
 * linear memory, no control flow) — proof the six-role reframing wasn't
 * secretly specific to virtual machines.
 *
 *   run:  npm run verify:rpn   (== npx tsx test-rpn.ts)
 */

import { makeRpnState, stepOnce, stepToHalt, type RpnToken } from './rpn/rpn-core';
import { buildRpnSnapshot, rpnSnapshotToStreamFields, type RpnSnapshot } from './rpn/rpn-snapshot';
import { buildStaticRpnCts, augmentRpnProvenance, UNIT_VOCABULARY } from './rpn/rpn-cts';
import { createEmitter, memorySink, findAnomalies } from './stream/phosphor-stream';

let passed = 0, failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  ${detail}` : ''}`); }
}
function head(title: string): void { console.log(`\n\x1b[36m${title}\x1b[0m`); }

// program: w=3; h=4; area = w*h; perimeter = 2*(w+h)
const num = (value: number): RpnToken => ({ kind: 'num', value });
const op = (o: '+' | '-' | '*' | '/'): RpnToken => ({ kind: 'op', op: o });
const store = (name: string): RpnToken => ({ kind: 'store', name });
const load = (name: string): RpnToken => ({ kind: 'load', name });

const PROGRAM: RpnToken[] = [
  num(3), store('w'),
  num(4), store('h'),
  load('w'), load('h'), op('*'), store('area'),
  num(2), load('w'), load('h'), op('+'), op('*'), store('perimeter'),
];
const COMMENTS = { 0: 'w = 3', 2: 'h = 4', 4: 'area = w * h', 8: 'perimeter = 2 * (w + h)' };

async function main(): Promise<void> {
  console.log('\x1b[1m\nPHOSPHOR · v0.7 — RPN retrofit (Phase 3, second Tier 1 target)\x1b[0m');

  // ── §A · run to completion, independently cross-checked ────────────────────
  head('§A · rpn-core.ts — run to completion, cross-checked against plain JS arithmetic');
  const final = stepToHalt(makeRpnState(PROGRAM));
  {
    check('halted', final.halted);
    check('ticks === token count (one token, one tick)', final.ticks === PROGRAM.length, `${final.ticks}`);
    // independently computed, not derived from the interpreter under test
    const w = 3, h = 4;
    check('area === w*h (independent recomputation)', final.vars.area === w * h, `${final.vars.area}`);
    check('perimeter === 2*(w+h) (independent recomputation)', final.vars.perimeter === 2 * (w + h), `${final.vars.perimeter}`);
    check('stack empty at halt (well-formed program leaves nothing dangling)', final.stack.length === 0, `${final.stack.length}`);
  }

  // ── §B · every tick snapshotted, self-validating stream ─────────────────────
  head('§B · rpn-snapshot.ts — per-tick Φ_rpn, phosphor-stream integration');
  const sink = memorySink();
  const emitter = createEmitter({ stream: 'rpn-verify', sink });
  const snapshots: RpnSnapshot[] = [];
  {
    let s = makeRpnState(PROGRAM);
    const cts = buildStaticRpnCts(PROGRAM, { w: 'rectangle width', h: 'rectangle height' }, COMMENTS);
    while (!s.halted) {
      s = stepOnce(s);
      const snap = buildRpnSnapshot({ id: 'rpn-demo', state: s, mode: 'ai', cts });
      snapshots.push(snap);
      emitter.emit(snap.halted ? 'vm:halt' : 'vm:tick', rpnSnapshotToStreamFields(snap));
    }
    check('one snapshot per token', snapshots.length === PROGRAM.length, `${snapshots.length}`);
    const storeAreaSnap = snapshots.find(s2 => s2.executed_token === 'STORE area');
    check('STORE area snapshot exists and reports the write in changed_vars', !!storeAreaSnap && storeAreaSnap.changed_vars.includes('area'));
    check('comment for token 4 (area = w*h) surfaces on the right tick', snapshots[4].comment === COMMENTS[4]);
    check('emitter produced vm:tick/vm:halt events', sink.events.length === PROGRAM.length);
    check('findAnomalies() runs over the stream without throwing', Array.isArray(findAnomalies(sink.events)));
  }

  // ── §C · CTS roles, checked against EAI-RETROFIT.md's checklist ────────────
  head('§C · rpn-cts.ts — six roles, one deliberately empty (not faked)');
  {
    const cts = buildStaticRpnCts(PROGRAM, { w: 'rectangle width' }, COMMENTS);
    check('Role 1 (Unit Vocabulary) populated: 7 ops', UNIT_VOCABULARY.size === 7);
    check('Role 2 (Location Naming) recovers every var referenced by the program', [...cts.varNames.keys()].sort().join(',') === 'area,h,perimeter,w');
    check('Role 3 (Region Typing): exactly stack + vars', cts.regionTypes.map(r => r.kind).join(',') === 'stack,vars');
    check('Role 4 (Decoded Content) is EMPTY on purpose (pure arithmetic has no strings) — not faked with placeholder content', cts.decodedContent.size === 0);
    check('Role 5 (Intent Annotation) carries the 4 authored comments', cts.comments.size === 4);

    const provenance = augmentRpnProvenance(snapshots);
    check('Role 6 (Provenance): area was written by exactly one token, the STORE at pc 7', provenance.get('area')?.writers.join(',') === '7');
    check('Role 6 (Provenance): w was read by 2 LOADs (area calc + perimeter calc)', provenance.get('w')?.readers.length === 2, JSON.stringify(provenance.get('w')?.readers));
  }

  // ── §D · a program that traps — the honest failure path ─────────────────────
  head('§D · RpnTrap — division by zero and undefined-variable reads fail loud, not silently');
  {
    let threw = false, msg = '';
    try { stepToHalt(makeRpnState([num(1), num(0), op('/')])); }
    catch (e: any) { threw = true; msg = e.message; }
    check('division by zero traps', threw && msg.includes('division by zero'), msg);

    threw = false; msg = '';
    try { stepToHalt(makeRpnState([load('nope')])); }
    catch (e: any) { threw = true; msg = e.message; }
    check('reading an undefined variable traps', threw && msg.includes('undefined variable'), msg);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m── Summary ──\x1b[0m`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  \x1b[31mfailing:\x1b[0m ${failures.join(' · ')}`);
    process.exitCode = 1;
  } else {
    console.log(`  \x1b[32mall RPN retrofit checks passed — EAI-RETROFIT.md's six roles hold on a second, independent architecture\x1b[0m`);
  }
}

main().catch(err => {
  console.error('\n\x1b[31mharness crashed:\x1b[0m', err);
  process.exitCode = 1;
});

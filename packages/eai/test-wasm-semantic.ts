/**
 * PHOSPHOR · v0.6 — WASM Semantic Equivalence + Phase 2 Flagship Flow
 * EML-EAI-2026-v0.6
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Verifies the Phase 2 flagship case end to end at the data-flow level (the
 * UI wires the same pieces, browser-verified separately):
 *
 *   AI proposes an optimization (a real rustc-compiled WASM variant) →
 *   wasmSemanticEquiv judges it against the real baseline →
 *   the verdict is embedded in a 09_Control row BEFORE any human sees it →
 *   phosphor-sheet's governed control plane executes only what the judge
 *   certified 'equivalent' — a human approving a NOT-equivalent proposal
 *   anyway does not matter, the hard gate in phosphor-control.ts refuses it.
 *
 *   run:  npm run verify:wasm-semantic   (== npx tsx test-wasm-semantic.ts)
 */

import { readFileSync } from 'node:fs';
import { wasmSemanticEquiv, type WasmEquivSpec } from './wasm/wasm-semantic';
import { proposeOptimization } from './wasm/wasm-sheet-bridge';
import { buildPhosphorWorkbook } from './spreadsheet/phosphor-sheet.ts';
import {
  executeControlSheet, parseControlSheet, withControlSheet, validateControlCommand,
} from './spreadsheet/phosphor-control.ts';
import { controlHandlersFromHost, type SheetControlHost } from './spreadsheet/phosphor-control-host.ts';
import { createEmitter, memorySink } from './stream/phosphor-stream';

let passed = 0, failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  ${detail}` : ''}`); }
}
function head(title: string): void { console.log(`\n\x1b[36m${title}\x1b[0m`); }

const baseline = new Uint8Array(readFileSync('./wasm/rust-fixtures/baseline.wasm'));
const optCorrect = new Uint8Array(readFileSync('./wasm/rust-fixtures/optimized-correct.wasm'));
const optBuggy = new Uint8Array(readFileSync('./wasm/rust-fixtures/optimized-buggy.wasm'));

const spec: WasmEquivSpec = {
  entry: 'main',
  paramCount: 1,
  outputPtrExport: 'buffer_ptr',
  outputBytes: (input) => (input[0] + 1) * 4,
  domain: [0, 1, 2, 3, 5, 8, 10, 15, 20],
};

async function main(): Promise<void> {
  console.log('\x1b[1m\nPHOSPHOR · v0.6 — WASM semantic equivalence + flagship flow\x1b[0m');

  // ── §A · wasmSemanticEquiv over real rustc-compiled binaries ──────────────
  head('§A · wasmSemanticEquiv — real rustc -O output, not hand-assembled');
  {
    const sink = memorySink();
    const em = createEmitter({ stream: 'test', sink });

    const rCorrect = wasmSemanticEquiv(baseline, optCorrect, spec, em);
    check('inlined-add variant judged equivalent', rCorrect.verdict === 'equivalent');
    check('equivalence is a proof over the declared domain', rCorrect.exhaustive === true);

    const rBuggy = wasmSemanticEquiv(baseline, optBuggy, spec, em);
    check('off-by-one variant judged not-equivalent', rBuggy.verdict === 'not-equivalent');
    check('counterexample present and at the smallest discriminating n', rBuggy.counterexample?.input[0] === 2, JSON.stringify(rBuggy.counterexample?.input));

    const rSelf = wasmSemanticEquiv(baseline, baseline, spec, em);
    check('baseline vs itself: trivially equivalent', rSelf.verdict === 'equivalent');

    check('emits vm:equiv self-validating events (ok mirrors verdict)',
      sink.events.filter(e => e.type === 'vm:equiv').length === 3
      && sink.events[0].ok === true && sink.events[1].ok === false && sink.events[2].ok === true);
  }

  // ── §B · proposeOptimization packages the verdict BEFORE human review ─────
  head('§B · wasm-sheet-bridge — verdict embedded before a human ever sees the row');
  const correctProposal = proposeOptimization({
    id: 'cmd-inline-add', target: 'phosphor-fib', variant: 'optimized-correct',
    baseline, candidate: optCorrect, spec, requestedBy: 'agent:optimizer',
  });
  const buggyProposal = proposeOptimization({
    id: 'cmd-inline-add-buggy', target: 'phosphor-fib', variant: 'optimized-buggy',
    baseline, candidate: optBuggy, spec, requestedBy: 'agent:optimizer',
  });
  {
    check('correct proposal: row status QUEUED, not pre-approved', correctProposal.row.status === 'QUEUED' && correctProposal.row.approved === false);
    const cArgs = JSON.parse(correctProposal.row.args_json);
    check('correct proposal: verdict visible in args_json before approval', cArgs.verdict === 'equivalent');
    const bArgs = JSON.parse(buggyProposal.row.args_json);
    check('buggy proposal: verdict visible in args_json before approval', bArgs.verdict === 'not-equivalent');
    check('buggy proposal: counterexample carried into the row for the reviewer to see', !!bArgs.counterexample);
  }

  // ── §C · the hard gate: even an approved-by-mistake buggy row is refused ──
  head('§C · phosphor-control.ts — governed execution, hard-refuses a bad proposal even if "approved"');
  {
    check('validateControlCommand rejects the buggy row outright (verdict, not approval, is the gate)',
      !validateControlCommand({ ...buggyProposal.row, approved: true, status: 'APPROVED' }).valid);
    check('validateControlCommand accepts the correct row once approved',
      validateControlCommand({ ...correctProposal.row, approved: true, status: 'APPROVED' }).valid);
  }

  let base = buildPhosphorWorkbook({ events: [], generatedAt: '2026-07-18T00:00:00Z' });
  // A human approves BOTH — the buggy one "by mistake" (didn't read the verdict
  // carefully, or approved before it finished rendering). The story is that the
  // system's own gate is what actually stops it, not human vigilance alone.
  const workbook = withControlSheet(base, [
    { ...correctProposal.row, approved: true, status: 'APPROVED' },
    { ...buggyProposal.row, approved: true, status: 'APPROVED' },
  ]);

  const switched: string[] = [];
  const host: SheetControlHost = {
    applyOptimization: (target, variant) => { switched.push(`${target}:${variant}`); return { switchedTo: variant }; },
  };
  const emitted: { type: string; fields: Record<string, unknown> }[] = [];
  const executed = await executeControlSheet(
    workbook, controlHandlersFromHost(host), {}, (type, fields) => emitted.push({ type, fields }),
  );
  {
    const rows = parseControlSheet(executed.workbook);
    const correctRow = rows.find(r => r.command_id === 'cmd-inline-add')!;
    const buggyRow = rows.find(r => r.command_id === 'cmd-inline-add-buggy')!;
    check('correct optimization: EXECUTED', correctRow.status === 'EXECUTED', correctRow.status);
    check('buggy optimization: REJECTED despite approved=true', buggyRow.status === 'REJECTED', buggyRow.status);
    check('rejection reason names the unmet certification, not a generic error', buggyRow.error.includes('did not certify'), buggyRow.error);
    check('host handler ran ONLY for the certified-safe variant', switched.length === 1 && switched[0] === 'phosphor-fib:optimized-correct', JSON.stringify(switched));
    check('audit trail has both an executed and a rejected event', emitted.some(e => e.type === 'sheet:command_executed') && emitted.some(e => e.type === 'sheet:command_rejected'));
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m── Summary ──\x1b[0m`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  \x1b[31mfailing:\x1b[0m ${failures.join(' · ')}`);
    process.exitCode = 1;
  } else {
    console.log(`  \x1b[32mall Phase 2 flagship checks passed\x1b[0m`);
  }
}

main().catch(err => {
  console.error('\n\x1b[31mharness crashed:\x1b[0m', err);
  process.exitCode = 1;
});

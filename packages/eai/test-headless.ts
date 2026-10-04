/**
 * PHOSPHOR · v0.4 — Headless + EML-VM-BASIC Verification Harness
 * EML-EAI-2026-v0.4
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Verifies the two v0.4 modules end to end:
 *   - eml-vm-basic.ts  : bounded-integer value domain [0,N], overflow policy,
 *                        constraint validation, wide-cell arithmetic (R0=300).
 *   - headless-vm.ts   : UI-free AI-mode driver + phosphor-stream integration
 *                        + CLI smoke test.
 *
 *   run:  npm run verify:headless   (== npx tsx test-headless.ts)
 */

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PROGRAM_FIBONACCI,
  type ProgramDefinition,
} from './eml-vm16-core';

import {
  ConstraintViolation,
  bound, makeBasicState, stepOnceBasic, stepNBasic,
  validateProgramConstraints,
  DEFAULT_BASIC_CONSTRAINTS,
  PROGRAM_BASIC_SUM,
  type BasicConstraints,
} from './eml-vm-basic';

import {
  createHeadlessVM, type HeadlessSnapshot,
} from './headless-vm';

import {
  createEmitter, memorySink, findAnomalies,
} from './stream/phosphor-stream';

// ── tiny test runner (mirrors integration.ts) ──────────────────────────────────

const FIB_11 = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55];
let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++;
    console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`);
  } else {
    failed++;
    failures.push(label);
    console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  ${detail}` : ''}`);
  }
}

function head(title: string): void {
  console.log(`\n\x1b[36m${title}\x1b[0m`);
}

const eqArr = (a: number[], b: number[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

// ════════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('\x1b[1m\nPHOSPHOR · v0.4 — Headless + EML-VM-BASIC verification\x1b[0m');

  // ── bound() — overflow policies ───────────────────────────────────────────────
  head('§4 · bound() overflow policies');
  {
    check('wrap: bound(13,10,wrap) === 2', bound(13, 10, 'wrap') === 2, `got ${bound(13, 10, 'wrap')}`);
    check('clamp: bound(13,10,clamp) === 10', bound(13, 10, 'clamp') === 10, `got ${bound(13, 10, 'clamp')}`);
    check('clamp: bound(-3,10,clamp) === 0', bound(-3, 10, 'clamp') === 0, `got ${bound(-3, 10, 'clamp')}`);

    let threw = false;
    let kind = '';
    try {
      bound(13, 10, 'throw');
    } catch (e) {
      threw = e instanceof ConstraintViolation;
      kind = (e as ConstraintViolation).info?.kind ?? '';
    }
    check('throw: bound(13,10,throw) raises ConstraintViolation(kind=overflow)', threw && kind === 'overflow', `threw=${threw} kind=${kind}`);
  }

  // ── validateProgramConstraints — static allow-list check ───────────────────────
  head('§5 · validateProgramConstraints — static ISA allow-list');
  {
    // XOR (opcode 0x32) IS in OPCODE_TABLE but NOT in the BASIC allow-list.
    const XOR_PROG: ProgramDefinition = {
      id: 'uses-xor', label: 'USES_XOR',
      description: 'A program that uses the disallowed XOR op.',
      code: [0x32, 0x01, 0x01, 0x00],   // XOR R0,R1 ; HALT
      initMem: {}, cts: {},
    };
    const { valid, violations } = validateProgramConstraints(XOR_PROG, DEFAULT_BASIC_CONSTRAINTS);
    check('disallowed XOR program → invalid with non-empty violations',
      !valid && violations.length > 0,
      `violations=${violations.length}`);
    check('violation names mnemonic XOR',
      violations.some(v => v.mnemonic === 'XOR'),
      `[${violations.map(v => v.mnemonic).join(',')}]`);

    const sumCheck = validateProgramConstraints(PROGRAM_BASIC_SUM, DEFAULT_BASIC_CONSTRAINTS);
    check('PROGRAM_BASIC_SUM (only allowed ops) → valid',
      sumCheck.valid && sumCheck.violations.length === 0,
      `valid=${sumCheck.valid} violations=${sumCheck.violations.length}`);
  }

  // ── stepOnceBasic runtime — disallowed op throws (kind 'op') ────────────────────
  head('§5 · stepOnceBasic — disallowed op at runtime throws');
  {
    const XOR_RUN: ProgramDefinition = {
      id: 'xor-run', label: 'XOR_RUN',
      description: 'Step a single XOR instruction.',
      code: [0x32, 0x01],   // XOR R0,R1
      initMem: {}, cts: {},
    };
    let threw = false, kind = '', mnem: string | undefined;
    try {
      stepOnceBasic(makeBasicState(XOR_RUN, DEFAULT_BASIC_CONSTRAINTS), DEFAULT_BASIC_CONSTRAINTS);
    } catch (e) {
      threw = e instanceof ConstraintViolation;
      kind = (e as ConstraintViolation).info?.kind ?? '';
      mnem = (e as ConstraintViolation).info?.mnemonic;
    }
    check('stepping [0x32,0x01] throws ConstraintViolation(kind=op, mnemonic=XOR)',
      threw && kind === 'op' && mnem === 'XOR',
      `threw=${threw} kind=${kind} mnemonic=${mnem}`);
  }

  // ── bounded-int proof — R0 = 300 (> 255, impossible on u8) ──────────────────────
  head('§6 · bounded-int proof — BASIC_SUM computes R0 = 300');
  {
    let st = makeBasicState(PROGRAM_BASIC_SUM, DEFAULT_BASIC_CONSTRAINTS);
    st = stepNBasic(st, 1000, DEFAULT_BASIC_CONSTRAINTS);
    check('BASIC_SUM halts with R0 === 300 (a value > 255)',
      st.halted && st.regs[0] === 300,
      `halted=${st.halted} R0=${st.regs[0]} ticks=${st.ticks}`);
  }

  // ── wrap-in-execution — overflow during a real run ──────────────────────────────
  head('§6 · wrap-in-execution — ADDI overflow wraps mod (maxValue+1)');
  {
    // maxValue=10 → domain [0,10], wrap mod 11.
    //   MOVI R0,#8 ; ADDI R0,#5 → 13 wrap 11 = 2 ; HALT
    const WRAP_PROG: ProgramDefinition = {
      id: 'wrap-demo', label: 'WRAP_DEMO',
      description: 'ADDI overflow under maxValue=10 wraps to 2.',
      code: [0x11, 0x08, 0x21, 0x05, 0x01, 0x00],
      initMem: {}, cts: {},
    };
    const wrapConstraints: BasicConstraints = { ...DEFAULT_BASIC_CONSTRAINTS, maxValue: 10, overflow: 'wrap' };
    let st = makeBasicState(WRAP_PROG, wrapConstraints);
    st = stepNBasic(st, 50, wrapConstraints);
    check('wrap: 8 + 5 under [0,10] === 2', st.halted && st.regs[0] === 2, `R0=${st.regs[0]}`);
  }

  // ── headless AI mode — VM-16 fibonacci ─────────────────────────────────────────
  head('§3 · headless AI mode — fibonacci (EML-VM-16)');
  {
    const snaps: HeadlessSnapshot[] = [];
    const runner = createHeadlessVM({
      program: PROGRAM_FIBONACCI, mode: 'ai', maxSteps: 500,
      onSnapshot: s => snaps.push(s),
    });
    const result = await runner.run();

    check('produced > 0 snapshots', snaps.length > 0, `snapshots=${snaps.length}`);
    check('every snapshot mode === ai', snaps.every(s => s.mode === 'ai'));
    check('every snapshot arch === EML-VM-16', snaps.every(s => s.arch === 'EML-VM-16'));
    const first = snaps[0];
    const hasAllRegs = first && ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'].every(r => r in first.registers);
    check('first snapshot has R0..R7 + pc string',
      !!first && hasAllRegs && typeof first.pc === 'string',
      first ? `pc=${first.pc}` : 'no snapshot');

    const fibData = Array.from(result.finalState.memory.slice(0x2E, 0x39)) as number[];
    check('finalState memory[0x2E..0x38] === fib(0..10)',
      eqArr(fibData, FIB_11),
      `[${fibData.join(',')}]`);
  }

  // ── BASIC via headless — arch tag + R0 = 300 ────────────────────────────────────
  head('§3 · headless BASIC mode — BASIC_SUM (EML-VM-BASIC)');
  {
    const runner = createHeadlessVM({
      program: PROGRAM_BASIC_SUM, constraints: DEFAULT_BASIC_CONSTRAINTS, maxSteps: 1000,
    });
    const result = await runner.run();
    check('BASIC headless: finalState.regs[0] === 300', result.finalState.regs[0] === 300, `R0=${result.finalState.regs[0]}`);
    check('BASIC headless: finalSnapshot.arch === EML-VM-BASIC',
      result.finalSnapshot.arch === 'EML-VM-BASIC',
      `arch=${result.finalSnapshot.arch}`);
  }

  // ── phosphor-stream integration + state-verification ────────────────────────────
  head('§3 · phosphor-stream integration + state verification');
  {
    const sink = memorySink();
    const emitter = createEmitter({ stream: 'phosphor-headless', sink });

    const runner = createHeadlessVM({
      program: PROGRAM_FIBONACCI, mode: 'ai', maxSteps: 500, emitter,
    });
    const result = await runner.run();

    const tickEvents = sink.events.filter(e => e.type === 'vm:tick');
    check('emitter recorded vm:tick events', tickEvents.length > 0, `vm:tick=${tickEvents.length}`);

    // State verification: read fib(10) from the final memory; an intent-vs-actual
    // check that matches should be OK, a deliberate mismatch should be an anomaly.
    const fib10 = result.finalState.memory[0x38] as number;   // ground truth = 55
    const okCheck = emitter.check('vm:state', fib10, fib10);
    const badCheck = emitter.check('vm:state', 0, 55);   // deliberate mismatch
    check('matching vm:state check returns true', okCheck === true && fib10 === 55, `fib10=${fib10}`);
    check('mismatched vm:state check returns false', badCheck === false);

    const anomalies = findAnomalies(sink.events);
    check('findAnomalies surfaces the deliberate mismatch',
      anomalies.some(e => e.type === 'vm:state' && e.actual === 0 && e.expected === 55),
      `anomalies=${anomalies.length}`);
  }

  // ── CLI smoke — spawn the headless runner as a child process ────────────────────
  head('§4 · CLI smoke — tsx headless-vm.ts run --program fibonacci --max 30');
  {
    const { code, stdout } = await spawnCli(['run', '--program', 'fibonacci', '--max', '30']);
    check('CLI exits 0', code === 0, `exit=${code}`);

    let parsedOk = false;
    for (const line of stdout.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      try {
        const obj = JSON.parse(t);
        if (obj && typeof obj === 'object' && obj.mode === 'ai') { parsedOk = true; break; }
      } catch { /* skip non-JSON line */ }
    }
    check('CLI stdout has ≥1 JSON line with mode === ai', parsedOk);
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m── Summary ──\x1b[0m`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  \x1b[31mfailing:\x1b[0m ${failures.join(' · ')}`);
    process.exitCode = 1;
  } else {
    console.log(`  \x1b[32mall headless + BASIC checks passed\x1b[0m`);
  }
}

/** Spawn `npx tsx headless-vm.ts <args…>` in the PHOSPHOR root and capture output. */
function spawnCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    // Single command string under shell:true. The fixed args here contain no
    // spaces/metacharacters, so plain concatenation is safe and side-steps the
    // DEP0190 warning emitted when an argv array is passed with shell:true.
    const cmd = `npx tsx headless-vm.ts ${args.join(' ')}`;
    const child = spawn(cmd, {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      shell: true,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    child.on('error', () => resolve({ code: -1, stdout, stderr }));
  });
}

main().catch(err => {
  console.error('\n\x1b[31mharness crashed:\x1b[0m', err);
  process.exitCode = 1;
});

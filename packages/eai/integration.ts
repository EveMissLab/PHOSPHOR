/**
 * PHOSPHOR · INT Phase — Integration Verification Harness
 * EML-EAI-2026-v0.2 · Final integration (Agent-executed)
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Executes the verification steps declared in EML-EAI-2026 §6.3 against the
 * actual compiled modules, end to end. Each step prints PASS/FAIL with the
 * observed values, so the paper's claims are checked empirically rather than
 * asserted. Steps 3 (WS server) and 6 (React) require a network/browser and
 * are exercised separately; everything runnable headless lives here.
 *
 *   run:  npm run verify   (== npx tsx integration.ts)
 */

import {
  PROGRAM_FIBONACCI, PROGRAM_COUNTER, PROGRAM_XOR_CIPHER,
  makeVMState, stepN,
  resolveCTS, augmentCTSFromTrace, traceWithSnapshots, buildStringTable,
  type ProgramDefinition,
} from './eml-vm16-core';

import {
  createCallableVM, PROGRAM_FUNCTIONS, DEFAULT_TEST_VECTORS, selfTest,
} from './eml-vm16-callable';

import {
  createPipeline, DEMO_PIPELINE_FIBCIPHER, buildProgramRegistry,
} from './eml-vm16-window';

import {
  createInProcessTransport, AgentClient, createSession,
} from './eml-vm16-agent';

import {
  makeVM64State, stepN64, PROGRAM64_FIBONACCI, PROGRAM64_FILL_SIMPLE, validateProgram64,
} from './eml-vm64-core';

import {
  createPipeline64, buildProgramRegistry64,
} from './eml-vm64-window';

// ── tiny test runner ──────────────────────────────────────────────────────────

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
  console.log('\x1b[1m\nPHOSPHOR · INT — Integration Verification (EML-EAI-2026 §6.3)\x1b[0m');

  // ── Step 1 — P3 CallableVM self-test (expect 14/14) ──────────────────────────
  head('Step 1 · P3 CallableVM — ECC-1 self-test');
  {
    const vm = createCallableVM(PROGRAM_FUNCTIONS);
    const results = await selfTest(vm, DEFAULT_TEST_VECTORS);
    const ok = results.filter(r => r.pass).length;
    for (const r of results) {
      check(
        `${r.fn}(${r.args.join(',')}) = ${r.expected}`,
        r.pass,
        r.pass ? '' : `got ${r.got}`,
      );
    }
    check(`self-test total ${ok}/${results.length}`, ok === results.length);
  }

  // ── Step 5 — V2 (EML-VM64) fibonacci validation ──────────────────────────────
  // Run before the timer-based steps so the deterministic checks come first.
  head('Step 5 · P6 EML-VM64 — 16-bit fibonacci → data segment');
  {
    const { valid, warnings } = validateProgram64(PROGRAM64_FIBONACCI);
    check('validateProgram64 reports no warnings', valid, warnings.join('; '));

    let state = makeVM64State(PROGRAM64_FIBONACCI);
    state = stepN64(state, 500);
    const fibData = Array.from(state.memory.slice(0x4000, 0x400B));
    check(
      'RAM[0x4000..0x400A] == fib(0..10)',
      eqArr(fibData, FIB_11),
      `[${fibData.join(',')}]`,
    );
  }

  // ── (pre-check) V1 built-in programs, in isolation ───────────────────────────
  head('Pre · P2 VMCore — V1 built-in programs (post code/data-overlap fix)');
  {
    let fib = makeVMState(PROGRAM_FIBONACCI);
    fib = stepN(fib, 500);
    const fibData = Array.from(fib.memory.slice(0x2E, 0x39));
    check('FIBONACCI: RAM[0x2E..0x38] == fib(0..10)', eqArr(fibData, FIB_11), `[${fibData.join(',')}]`);

    let cnt = makeVMState(PROGRAM_COUNTER);
    cnt = stepN(cnt, 500);
    const cntData = Array.from(cnt.memory.slice(0x14, 0x24));
    const expectCnt = Array.from({ length: 16 }, (_, i) => i);
    check('COUNTER: RAM[0x14..0x23] == 0..15', eqArr(cntData, expectCnt), `[${cntData.join(',')}]`);

    // XOR_CIPHER: timing-independent correctness — every byte is the init value
    // XORed with the key an integer number of times (never corrupted), and the
    // cipher actually transformed at least one byte.
    const KEY = 0x0A;
    const init = [0xDE,0xAD,0xBE,0xEF,0xCA,0xFE,0xBA,0xBE,0x13,0x37,0xAA,0x55,0x0F,0xF0,0x69,0x42];
    let cip = makeVMState(PROGRAM_XOR_CIPHER);
    cip = stepN(cip, 300);
    const cipData = Array.from(cip.memory.slice(0x40, 0x50));
    const allValid = cipData.every((b, i) => b === init[i] || b === (init[i] ^ KEY));
    const transformed = cipData.some((b, i) => b === (init[i] ^ KEY));
    check('XOR_CIPHER: every byte is init or init^key (no corruption)', allValid, `[${cipData.map(b => b.toString(16)).join(',')}]`);
    check('XOR_CIPHER: cipher transformed the buffer', transformed);
  }

  // ── Step 2 — P4 cross-VM memory channel (fib → cipher mirror) ────────────────
  head('Step 2 · P4 Pipeline — fib output mirrored into cipher input via channel');
  {
    const registry = buildProgramRegistry([PROGRAM_FIBONACCI, PROGRAM_XOR_CIPHER]);
    const mgr = createPipeline(DEMO_PIPELINE_FIBCIPHER, registry);

    // Drive only the fib window; leave cipher paused so the channel delivery is
    // observable in isolation (cipher would otherwise XOR the mirrored bytes).
    const fibVM = mgr.getWindowVM('fib-window')!;
    const cipherVM = mgr.getWindowVM('cipher-window')!;
    check('both windows created', !!fibVM && !!cipherVM,
      `windows=${mgr.toManifest().total_windows} channels=${mgr.toManifest().total_channels}`);

    fibVM.stepN(500);

    const fibOut = Array.from(fibVM.getMemory().slice(0x2E, 0x39));
    const cipherIn = Array.from(cipherVM.getMemory().slice(0x40, 0x4B));
    check('fib-window produced fib(0..10) at 0x2E', eqArr(fibOut, FIB_11), `[${fibOut.join(',')}]`);
    check('channel mirrored fib → cipher 0x40..0x4A', eqArr(cipherIn, fibOut), `[${cipherIn.join(',')}]`);

    mgr.pauseAll();
  }

  // ── P5 cmd:call wiring — CallableVM reachable through a window ────────────────
  // Was a v0.4 "known gap" probe (the window system did not attach a CallableVM);
  // it now resolves end-to-end, so this is a HARD assertion in-process — matching
  // test-ws.ts which asserts the same add(3,5)=8 over a real socket. Any v0.5+
  // agent-layer / window refactor must keep this path green on both harnesses.
  head('Step · P5 cmd:call — CallableVM reachability through a window');
  {
    const registry = buildProgramRegistry([PROGRAM_FUNCTIONS]);
    const mgr = createPipeline({
      id: 'probe-call', label: 'probe', autoRun: false,
      windows: [{ id: 'fn-window', title: 'functions', program: PROGRAM_FUNCTIONS }],
      channels: [],
    }, registry);

    const { agentSide, serverSide } = createInProcessTransport();
    createSession(serverSide, mgr);
    const client = new AgentClient(agentSide);

    let callOk = false;
    let callErr = '';
    let returnValue: number | null = null;
    const gotResult = new Promise<void>(resolve => {
      client.on('event:call_result', e => {
        returnValue = (e as any).returnValue;
        resolve();
      });
    });
    try {
      await client.cmd({ type: 'cmd:call', windowId: 'fn-window', fn: 'add', args: [3, 5] } as any);
      await Promise.race([gotResult, new Promise(r => setTimeout(r, 500))]);
      callOk = true;
    } catch (e) {
      callErr = String(e);
    }
    check('cmd:call add(3,5) returns 8', callOk && returnValue === 8,
      callOk ? `returnValue=${returnValue}` : `rejected: ${callErr}`);
  }

  // ── Step 4 — P5 in-process agent snapshot stream ─────────────────────────────
  head('Step 4 · P5 Agent — in-process snapshot stream');
  {
    const registry = buildProgramRegistry([PROGRAM_FIBONACCI]);
    const mgr = createPipeline({
      id: 'agent-demo', label: 'agent demo', autoRun: false,
      windows: [{ id: 'fib-window', title: 'FIBONACCI', program: PROGRAM_FIBONACCI, speed: 'FAST' }],
      channels: [],
    }, registry);

    const { agentSide, serverSide } = createInProcessTransport();
    createSession(serverSide, mgr);
    const client = new AgentClient(agentSide);

    await client.cmd({ type: 'cmd:subscribe', config: {
      subId: 'test-sub', windowId: 'fib-window', mode: 'on-change',
    }} as any);
    await client.cmd({ type: 'cmd:run', windowId: 'fib-window', speed: 'FAST' } as any);

    let snaps: Awaited<ReturnType<typeof client.collectSnapshots>> = [];
    try {
      snaps = await Promise.race([
        client.collectSnapshots('fib-window', 10),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout after 10s')), 10_000)),
      ]);
    } catch {
      // leave snaps as collected-so-far ([]) — reported as a failed check below
    }

    mgr.pauseAll();
    check('collected 10 snapshots', snaps.length === 10, `got ${snaps.length}`);
    check('snapshots carry window context + decoded instruction',
      snaps.length > 0 && snaps[0].window_id === 'fib-window' && typeof snaps[0].instruction === 'string',
      snaps.length > 0 ? `first: ${snaps[0].instruction} @ ${snaps[0].pc}` : '');
  }

  // ── CTS depth — dynamic crossRef + stringTable (§6.4 #4,#5 now implemented) ──
  head('CTS · Layer 6 dynamic crossRef + Layer 4 stringTable');
  {
    // Register-indirect store: load a pointer from MEM[0x10], then store through
    // it. Static analysis cannot resolve the write target (R1 comes from a LD);
    // augmentCTSFromTrace recovers it from the execution trace.
    const PTR_PROG: ProgramDefinition = {
      id: 'ptr-chase', label: 'PTR_CHASE',
      description: 'Register-indirect store: MEM[MEM[0x10]] = 7.',
      code: [
        0x11,0x0F,  // MOVI R0,#15
        0x41,0x00,  // INC R0        → R0 = 0x10
        0x80,0x10,  // LD R1,[R0]    → R1 = MEM[0x10] = 0x80 (runtime pointer)
        0x11,0x27,  // MOVI R2,#7
        0x81,0x12,  // ST [R1],R2    → MEM[0x80] = 7  (register-indirect write)
        0x01,0x00,  // HALT
      ],
      initMem: { 0x10: 0x80 },
      cts: {},
    };

    const staticCts = resolveCTS(PTR_PROG);
    const staticWriters = staticCts.crossRefTable.get(0x80)?.dataWriters ?? [];
    check('static crossRef misses the register-indirect write @0x80',
      staticWriters.length === 0,
      `static writers=[${staticWriters.map(w => '0x' + w.toString(16)).join(',')}]`);

    const { trace, memSnapshots } = traceWithSnapshots(PTR_PROG, 100);
    const dynCts = augmentCTSFromTrace(staticCts, trace, memSnapshots);
    const dynWriters = dynCts.crossRefTable.get(0x80)?.dataWriters ?? [];
    check('augmentCTSFromTrace recovers writer @0x80 (instr 0x08)',
      dynWriters.includes(0x08),
      `dynamic writers=[${dynWriters.map(w => '0x' + w.toString(16)).join(',')}]`);

    // Register-indirect READ: load a pointer from MEM[0x10], then LD through it.
    // A read leaves no memory delta, so the diff pass cannot see it; the effective-
    // access stream from traceWithSnapshots recovers the dataReader dynamically.
    const PTR_READ: ProgramDefinition = {
      id: 'ptr-read', label: 'PTR_READ',
      description: 'Register-indirect read: R2 = MEM[MEM[0x10]].',
      code: [
        0x11,0x0F,  // MOVI R0,#15
        0x41,0x00,  // INC R0        → R0 = 0x10
        0x80,0x10,  // LD R1,[R0]    → R1 = MEM[0x10] = 0x80 (runtime pointer)
        0x80,0x21,  // LD R2,[R1]    → R2 = MEM[0x80]  (register-indirect read)
        0x01,0x00,  // HALT
      ],
      initMem: { 0x10: 0x80, 0x80: 0x42 },
      cts: {},
    };
    const staticRead = resolveCTS(PTR_READ);
    const staticReaders = staticRead.crossRefTable.get(0x80)?.dataReaders ?? [];
    check('static crossRef misses the register-indirect read @0x80',
      staticReaders.length === 0,
      `static readers=[${staticReaders.map(r => '0x' + r.toString(16)).join(',')}]`);

    const rd = traceWithSnapshots(PTR_READ, 100);
    const dynReadCts = augmentCTSFromTrace(staticRead, rd.trace, rd.memSnapshots, rd.accesses);
    const dynReaders = dynReadCts.crossRefTable.get(0x80)?.dataReaders ?? [];
    check('augmentCTSFromTrace recovers reader @0x80 (instr 0x06)',
      dynReaders.includes(0x06),
      `dynamic readers=[${dynReaders.map(r => '0x' + r.toString(16)).join(',')}]`);

    // Negative control: a read leaves no memory delta, so WITHOUT the accesses
    // stream the diff pass alone must NOT recover the reader — proving the
    // accesses stream is the required mechanism (mirrors the writer test's omit).
    const noAcc = augmentCTSFromTrace(staticRead, rd.trace, rd.memSnapshots);
    const noAccReaders = noAcc.crossRefTable.get(0x80)?.dataReaders ?? [];
    check('reader @0x80 NOT recovered without the accesses stream',
      !noAccReaders.includes(0x06),
      `readers w/o accesses=[${noAccReaders.map(r => '0x' + r.toString(16)).join(',')}]`);

    // stringTable: decode an embedded ASCII string.
    const mem = new Uint8Array(256);
    'PHOSPHOR'.split('').forEach((c, i) => { mem[0x40 + i] = c.charCodeAt(0); });
    const strings = buildStringTable(mem, 0x00, 0xFF);
    check('buildStringTable decodes "PHOSPHOR" @0x40',
      strings.get(0x40) === 'PHOSPHOR',
      [...strings.entries()].map(([a, s]) => `0x${a.toString(16)}:"${s}"`).join(' '));
  }

  // ── V2 window system — 16-bit cross-VM channel (§6.4 #3 now implemented) ─────
  head('VM64 · Window64VM + 16-bit memory channel');
  {
    const reg = buildProgramRegistry64([PROGRAM64_FIBONACCI, PROGRAM64_FILL_SIMPLE]);
    const mgr = createPipeline64({
      id: 'vm64-pipe', label: 'vm64 pipe', autoRun: false,
      windows: [
        { id: 'fib64',  title: 'FIBONACCI_64K', program: PROGRAM64_FIBONACCI },
        { id: 'recv64', title: 'receiver',      program: PROGRAM64_FILL_SIMPLE },
      ],
      channels: [
        { id: 'fib64→recv', srcId: 'fib64', srcStart: 0x4000, srcEnd: 0x400A,
          dstId: 'recv64', dstStart: 0x5000, label: 'fib data → receiver' },
      ],
    }, reg);

    const m = mgr.toManifest();
    check('VM64 manager: 2 windows, 1 channel, arch tagged',
      m.arch === 'EML-VM64' && m.total_windows === 2 && m.total_channels === 1,
      `arch=${m.arch} windows=${m.total_windows} channels=${m.total_channels}`);

    const fib64  = mgr.getWindowVM('fib64')!;
    const recv64 = mgr.getWindowVM('recv64')!;
    fib64.stepN(500);
    const srcData = Array.from(fib64.getMemory().slice(0x4000, 0x400B));
    const dstData = Array.from(recv64.getMemory().slice(0x5000, 0x500B));
    check('fib64 window computed fib(0..10) at 0x4000', eqArr(srcData, FIB_11), `[${srcData.join(',')}]`);
    check('16-bit channel mirrored fib → receiver 0x5000', eqArr(dstData, FIB_11), `[${dstData.join(',')}]`);
    mgr.pauseAll();
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m── Summary ──\x1b[0m`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  \x1b[31mfailing:\x1b[0m ${failures.join(' · ')}`);
    process.exitCode = 1;
  } else {
    console.log(`  \x1b[32mall integration checks passed\x1b[0m`);
  }
}

main().catch(err => {
  console.error('\n\x1b[31mharness crashed:\x1b[0m', err);
  process.exitCode = 1;
});

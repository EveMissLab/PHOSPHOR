/**
 * PHOSPHOR · v0.6 — WASM Φ Target Verification Harness
 * EML-EAI-2026-v0.6
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Verifies the first non-invented Φ target: our own WASM parser + interpreter
 * (wasm/) against a hand-assembled but spec-real `.wasm` binary, AND — the
 * strong proof — against Node's own native `WebAssembly` engine running the
 * exact same bytes. If our tick-by-tick interpreter and an independent,
 * spec-conformant engine agree on the final result, Φ is provably over real
 * WebAssembly semantics, not a re-invented ISA that merely looks the part.
 *
 *   run:  npm run verify:wasm   (== npx tsx test-wasm.ts)
 */

import { parseWasmModule } from './wasm/wasm-binary';
import { makeWasmState, stepOnce, type WasmState } from './wasm/wasm-interp';
import { buildWasmSnapshot, wasmSnapshotToStreamFields, type WasmSnapshot } from './wasm/wasm-snapshot';
import { buildWasmCts, buildWasmStringTable, augmentWasmCrossRef, encodeCodePos } from './wasm/wasm-cts';
import { buildFibonacciWasmModule, STRING_DATA_ADDR } from './wasm/wasm-fixtures';
import { createEmitter, memorySink, findAnomalies } from './stream/phosphor-stream';

// ── tiny test runner (mirrors integration.ts / test-headless.ts) ──────────────

let passed = 0, failed = 0;
const failures: string[] = [];

function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  ${detail}` : ''}`); }
}
function head(title: string): void { console.log(`\n\x1b[36m${title}\x1b[0m`); }

const FIB_11 = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55];
function eqArr<T>(a: T[], b: T[]): boolean { return a.length === b.length && a.every((v, i) => v === b[i]); }

function readFibFromMemory(mem: Uint8Array): number[] {
  const view = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
  return Array.from({ length: 11 }, (_, i) => view.getInt32(i * 4, true));
}

/** Run our interpreter to completion, collecting one WasmSnapshot per tick (same shape a driver would emit). */
function runOurInterpreter(bytes: Uint8Array, n: number): { finalState: WasmState; snapshots: WasmSnapshot[]; module: ReturnType<typeof parseWasmModule> } {
  const module = parseWasmModule(bytes);
  const cts = buildWasmCts(module);
  let state = makeWasmState(module, 'main', [n]);
  const snapshots: WasmSnapshot[] = [];
  const sink = memorySink();
  const emitter = createEmitter({ stream: 'wasm-verify', sink });

  let guard = 0;
  while (!state.halted && guard++ < 100_000) {
    const prevMem = state.memory;
    state = stepOnce(state);
    const snap = buildWasmSnapshot({ id: 'fib-wasm', state, mode: 'ai', cts, prevMem });
    snapshots.push(snap);
    emitter.emit(snap.halted ? 'vm:halt' : 'vm:tick', wasmSnapshotToStreamFields(snap));
  }
  return { finalState: state, snapshots, module };
}

// ════════════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  console.log('\x1b[1m\nPHOSPHOR · v0.6 — WASM Φ target verification\x1b[0m');

  const bytes = buildFibonacciWasmModule();

  // ── §A · this is a real, spec-valid WASM binary ─────────────────────────────
  head('§A · fixture is a real, spec-conformant .wasm binary');
  {
    const valid = WebAssembly.validate(bytes as unknown as BufferSource);
    check('WebAssembly.validate(bytes) === true (Node\'s own engine accepts it)', valid);
  }

  // ── §B · our parser reads the module structure correctly ───────────────────
  head('§B · wasm-binary.ts — module structure');
  const module = parseWasmModule(bytes);
  {
    check('2 function types decoded', module.types.length === 2);
    check('2 functions decoded', module.funcs.length === 2);
    check('func 0 name === "add" (from custom name section)', module.funcs[0].name === 'add');
    check('func 1 name === "main" (from custom name section)', module.funcs[1].name === 'main');
    check('func 1 local names resolved', module.funcs[1].localNames?.get(1) === 'i' && module.funcs[1].localNames?.get(4) === 'tmp');
    check('memory: min 1 page, no max', module.memoryPages.min === 1 && module.memoryPages.max === undefined);
    const exportNames = module.exports.map(e => `${e.name}:${e.kind}`).sort();
    check('exports main/add/memory', eqArr(exportNames, ['add:func', 'main:func', 'memory:mem'].sort()), exportNames.join(','));
    check('1 data segment @ 4096, 8 bytes ("PHOSPHOR")', module.data.length === 1 && module.data[0].offset === STRING_DATA_ADDR && module.data[0].bytes.length === 8);
  }

  // ── §C · our interpreter runs it to completion ──────────────────────────────
  head('§C · wasm-interp.ts — run main(10) to completion');
  const { finalState, snapshots } = runOurInterpreter(bytes, 10);
  {
    check('halted', finalState.halted);
    check('outermost call had no results (main: (i32)->())', (finalState.result ?? []).length === 0);
    const fib = readFibFromMemory(finalState.memory);
    check('mem[0..44) decodes to fib(0..10)', eqArr(fib, FIB_11), `[${fib.join(',')}]`);
    check('captured one snapshot per tick, > 100 ticks (loop + 9 calls to add)', snapshots.length > 100, `${snapshots.length} ticks`);
    const maxDepth = Math.max(...snapshots.map(s => s.call_depth));
    check('call_depth reached 2 during call $add (real call, not inlined)', maxDepth === 2, `max depth ${maxDepth}`);
  }

  // ── §D · cross-check against Node's own native WebAssembly engine ──────────
  head('§D · parity against Node\'s native WebAssembly (the real proof)');
  {
    const { instance } = await WebAssembly.instantiate(bytes as unknown as BufferSource);
    const exports = instance.exports as unknown as { main: (n: number) => void; add: (a: number, b: number) => number; memory: WebAssembly.Memory };
    exports.main(10);
    const nativeFib = readFibFromMemory(new Uint8Array(exports.memory.buffer, 0, 44));
    check('native engine: mem[0..44) also decodes to fib(0..10)', eqArr(nativeFib, FIB_11), `[${nativeFib.join(',')}]`);
    check('OUR interpreter and Node\'s native engine agree exactly', eqArr(readFibFromMemory(finalState.memory), nativeFib));
    check('native add(3,5) === 8 (spot-check the second exported function)', exports.add(3, 5) === 8);
  }

  // ── §E · CTS mapping over the linear-memory layer ───────────────────────────
  head('§E · wasm-cts.ts — CTS over the memory address space');
  {
    const cts = buildWasmCts(module);
    const dataSym = cts.symbolTable?.get(STRING_DATA_ADDR);
    check('symbolTable has a data-segment symbol @4096', dataSym !== undefined, dataSym?.name);
    const strings = buildWasmStringTable(finalState.memory);
    check('stringTable decodes "PHOSPHOR" @4096 (mirrors the VM-16 PTR_CHASE proof)', strings.get(STRING_DATA_ADDR) === 'PHOSPHOR');

    const xref = augmentWasmCrossRef(snapshots);
    const writers0 = xref.get(0)?.dataWriters ?? [];
    check('crossRefTable: mem[0] has exactly one dynamic writer (the fib[0]=0 store)', writers0.length === 1, `${writers0.length} writers`);
    const storeSnap = snapshots.find(s => s.changed_this_tick.some(c => c.addr === '0x0'));
    check('that writer decodes back to the store instruction that actually ran', writers0[0] === encodeCodePos(storeSnap!.func_idx, storeSnap!.instr_idx));
  }

  // ── §F · snapshot legibility (the actual Φ claim) ───────────────────────────
  head('§F · wasm-snapshot.ts — human+agent legible instruction text');
  {
    const callTick = snapshots.find(s => s.instruction.startsWith('call'));
    check('a call instruction decodes with the real function name', callTick?.instruction === 'call add', callTick?.instruction);
    const localTick = snapshots.find(s => s.instruction.includes('tmp'));
    check('a local.set decodes with its real name from the name section (not a raw index)', !!localTick, localTick?.instruction);
    const anomalies = findAnomalies(snapshots.map(s => ({ stream: 'x', proto: 'phosphor-jsonl-v1', seq: 0, ts: '', type: 'vm:tick', ...wasmSnapshotToStreamFields(s) })));
    check('findAnomalies() runs over the flattened stream fields without throwing', Array.isArray(anomalies));
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log(`\n\x1b[1m── Summary ──\x1b[0m`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`  \x1b[31mfailing:\x1b[0m ${failures.join(' · ')}`);
    process.exitCode = 1;
  } else {
    console.log(`  \x1b[32mall WASM Φ-target checks passed\x1b[0m`);
  }
}

main().catch(err => {
  console.error('\n\x1b[31mharness crashed:\x1b[0m', err);
  process.exitCode = 1;
});

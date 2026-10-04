/**
 * PHOSPHOR · WASM Headless Snapshot (browser-safe)
 * EML-EAI-2026-v0.6 · Φ_wasm : M_wasm × CTS_wasm → V_AI
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * The WASM sibling of `headless-snapshot.ts`'s `buildHeadlessSnapshot`. Same
 * role — the single source of truth an agent stream AND a future human view
 * both read — but a WASM frame's `M` genuinely has a different shape than a
 * register machine's: an operand stack and per-call locals instead of a flat
 * register file, and a call stack that can be more than one frame deep. Rather
 * than force that into `HeadlessSnapshot`'s fields, this is its own type with
 * the same spirit (arch name, tick, pc, decoded instruction, memory diff,
 * halted) plus what a stack machine actually needs to be legible.
 */

import type { CTS } from '../eml-vm16-core';
import type { VMMode } from '../headless-snapshot';
import type { WasmModule, WasmFunc, WasmInstr } from './wasm-binary';
import type { WasmState } from './wasm-interp';

export interface WasmSnapshot {
  mode:       VMMode;
  arch:       'WASM-MVP';
  vm_id:      string;
  tick:       number;
  func_idx:   number;
  func_name:  string | null;
  instr_idx:  number;
  pc:         string;                 // "<func>:<instr_idx>"
  pc_symbol:  string | null;           // function-level granularity — WASM has no finer static label without a source map
  instruction: string;
  locals:     Record<string, number>;
  operand_stack: number[];
  call_depth: number;
  changed_this_tick: { addr: string; symbol: string | null; before: number; after: number }[];
  halted:     boolean;
  result?:    number[];                // populated once halted: the outermost call's return values
}

function localName(fn: WasmFunc, idx: number): string { return fn.localNames?.get(idx) ?? `$${idx}`; }
function funcLabel(module: WasmModule, idx: number): string { return module.funcs[idx]?.name ?? `$func${idx}`; }

function decodeInstrText(instr: WasmInstr, fn: WasmFunc, module: WasmModule): string {
  switch (instr.mnemonic) {
    case 'local.get': case 'local.set': case 'local.tee':
      return `${instr.mnemonic} ${localName(fn, instr.idx!)}`;
    case 'global.get': case 'global.set':
      return `${instr.mnemonic} ${instr.idx}`;
    case 'i32.const':
      return `i32.const ${instr.i32}`;
    case 'call':
      return `call ${funcLabel(module, instr.idx!)}`;
    case 'br': case 'br_if':
      return `${instr.mnemonic} ${instr.idx}`;
    case 'br_table':
      return `br_table [${instr.labels!.join(',')}] default=${instr.default}`;
    case 'i32.load': case 'i32.store':
      return `${instr.mnemonic} offset=${instr.memArg!.offset}`;
    default:
      return instr.mnemonic;
  }
}

/**
 * Build a WasmSnapshot from a WasmState. `prevMem` (if given) supplies the
 * "before" value for changed cells, same contract as `buildHeadlessSnapshot`.
 * Once halted the call stack is empty by construction (the outermost `return`
 * popped it) — that tick's snapshot reports the result instead of a live frame.
 */
export function buildWasmSnapshot(args: {
  id: string;
  state: WasmState;
  mode: VMMode;
  cts?: Partial<CTS>;
  prevMem?: Uint8Array;
}): WasmSnapshot {
  const { id, state, mode, cts, prevMem } = args;
  const frame = state.frames[state.frames.length - 1];

  if (!frame) {
    return {
      mode, arch: 'WASM-MVP', vm_id: id, tick: state.ticks,
      func_idx: -1, func_name: null, instr_idx: -1,
      pc: 'halt', pc_symbol: null, instruction: 'HALT',
      locals: {}, operand_stack: [], call_depth: 0,
      changed_this_tick: [],
      halted: true, result: state.result,
    };
  }

  const fn = state.module.funcs[frame.funcIdx];
  const instr = fn.body[frame.pc];
  const fnName = fn.name ?? null;
  const sym = cts?.symbolTable;

  const changed = [...state.changed].sort((a, b) => a - b).map(addr => ({
    addr:   `0x${addr.toString(16)}`,
    symbol: sym?.get(addr)?.name ?? null,
    before: prevMem ? prevMem[addr] : state.memory[addr],
    after:  state.memory[addr],
  }));

  const locals: Record<string, number> = {};
  frame.locals.forEach((v, i) => { locals[localName(fn, i)] = v; });

  return {
    mode, arch: 'WASM-MVP', vm_id: id, tick: state.ticks,
    func_idx: frame.funcIdx, func_name: fnName, instr_idx: frame.pc,
    pc: `${fnName ?? `$func${frame.funcIdx}`}:${frame.pc}`,
    pc_symbol: fnName,
    instruction: decodeInstrText(instr, fn, state.module),
    locals,
    operand_stack: [...frame.stack],
    call_depth: state.frames.length,
    changed_this_tick: changed,
    halted: state.halted,
  };
}

/** Flatten into the `vm:tick` / `vm:halt` phosphor-stream domain payload — same role as `headlessSnapshotToStreamFields`. */
export function wasmSnapshotToStreamFields(s: WasmSnapshot): Record<string, unknown> {
  return {
    arch: s.arch, mode: s.mode, vm_id: s.vm_id, vm_tick: s.tick,
    pc: s.pc, pc_symbol: s.pc_symbol, instruction: s.instruction,
    locals: s.locals, operand_stack: s.operand_stack, call_depth: s.call_depth,
    changed: s.changed_this_tick, halted: s.halted,
    ...(s.result !== undefined ? { result: s.result } : {}),
  };
}

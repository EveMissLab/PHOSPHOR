/**
 * PHOSPHOR · WASM Interpreter (browser-safe)
 * EML-EAI-2026-v0.6 · a functional step engine over real WebAssembly bytecode
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * `stepOnce` executes exactly one instruction and returns a NEW `WasmState` —
 * memory, globals, and every active call frame are cloned each tick, matching
 * `eml-vm16-core.ts`'s `stepOnce` contract exactly (old state stays frozen, so a
 * driver can hold `prevMem` across a tick for the `changed_this_tick` diff, and
 * a run is trivially replayable). Only single-byte i32-only opcodes are
 * dispatched (see `wasm-binary.ts`); anything else already failed at parse time.
 *
 * Structured control flow (block/loop/if/else) runs over a per-frame
 * `controlStack`, using the matching-`end`/`else` indices `wasm-binary.ts`
 * pre-resolved — no re-scanning bytes to find a branch target at run time.
 */

import type { WasmModule, WasmFunc, WasmInstr } from './wasm-binary';

export class WasmTrap extends Error {
  constructor(reason: string) { super(`WASM trap: ${reason}`); this.name = 'WasmTrap'; }
}

export interface ControlFrame {
  kind:        'function' | 'block' | 'loop' | 'if';
  endIdx:      number;
  startIdx?:   number;   // loop only — its own instruction index, the branch-back target
  stackHeight: number;   // operand-stack length to truncate to on branch/exit (empty block types only)
  resultArity: number;   // 0 for block/loop/if (empty type only); function: type.results.length
}

export interface WasmFrame {
  funcIdx: number;
  locals:  number[];
  stack:   number[];
  pc:      number;             // index into module.funcs[funcIdx].body
  controlStack: ControlFrame[];
}

export interface WasmState {
  module:  WasmModule;
  memory:  Uint8Array;
  globals: number[];
  frames:  WasmFrame[];        // call stack; last element is the executing frame
  halted:  boolean;
  ticks:   number;
  changed: Set<number>;        // memory byte addresses written this tick
  result?: number[];           // populated once halted: the outermost call's return values
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 1. Little-endian i32 memory access
// ═══════════════════════════════════════════════════════════════════════════════

function loadI32(mem: Uint8Array, addr: number): number {
  if (addr < 0 || addr + 4 > mem.length) throw new WasmTrap(`out of bounds memory access (load @${addr})`);
  return mem[addr] | (mem[addr + 1] << 8) | (mem[addr + 2] << 16) | (mem[addr + 3] << 24);
}

function storeI32(mem: Uint8Array, addr: number, value: number, changed: Set<number>): void {
  if (addr < 0 || addr + 4 > mem.length) throw new WasmTrap(`out of bounds memory access (store @${addr})`);
  mem[addr] = value & 0xff;
  mem[addr + 1] = (value >>> 8) & 0xff;
  mem[addr + 2] = (value >>> 16) & 0xff;
  mem[addr + 3] = (value >>> 24) & 0xff;
  changed.add(addr); changed.add(addr + 1); changed.add(addr + 2); changed.add(addr + 3);
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 2. State construction
// ═══════════════════════════════════════════════════════════════════════════════

function makeCallFrame(module: WasmModule, funcIdx: number, args: number[]): WasmFrame {
  const fn = module.funcs[funcIdx];
  if (!fn) throw new Error(`no function at index ${funcIdx}`);
  const locals = fn.locals.map((_, i) => (i < fn.numParams ? (args[i] ?? 0) : 0));
  return {
    funcIdx,
    locals,
    stack: [],
    pc: 0,
    controlStack: [{ kind: 'function', endIdx: fn.body.length - 1, stackHeight: 0, resultArity: fn.type.results.length }],
  };
}

/** Build the initial state for calling `entry` (export name or function index) with `args`. */
export function makeWasmState(module: WasmModule, entry: number | string, args: number[] = []): WasmState {
  const funcIdx = typeof entry === 'number' ? entry : resolveExportedFunc(module, entry);
  const memory = new Uint8Array(module.memoryPages.min * 65536);
  for (const seg of module.data) memory.set(seg.bytes, seg.offset);
  const globals = module.globals.map(g => g.init);
  return {
    module, memory, globals,
    frames: [makeCallFrame(module, funcIdx, args)],
    halted: false, ticks: 0, changed: new Set(),
  };
}

export function resolveExportedFunc(module: WasmModule, name: string): number {
  const exp = module.exports.find(e => e.kind === 'func' && e.name === name);
  if (!exp) throw new Error(`no exported function named '${name}'`);
  return exp.index;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 3. Control flow
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * `return` and function-closing `end` share this: pop the function's own
 * control scope (callers must ensure it is the current top — `branchTo`
 * truncates nested block/loop/if scopes above it first), splice the result(s)
 * onto the caller, or halt if it was the outermost call.
 */
function doReturn(state: WasmState): void {
  const frame = state.frames[state.frames.length - 1];
  const fnScope = frame.controlStack.pop()!; // must be the function's own scope at this point
  const results = frame.stack.slice(frame.stack.length - fnScope.resultArity);
  state.frames.pop();
  if (state.frames.length === 0) {
    state.halted = true;
    state.result = results;
    return;
  }
  state.frames[state.frames.length - 1].stack.push(...results);
}

/** `br` / `br_if` (taken) / `br_table`: branch `depth` labels up the current frame's control stack. */
function branchTo(state: WasmState, depth: number): void {
  const frame = state.frames[state.frames.length - 1];
  const cs = frame.controlStack;
  const targetIdx = cs.length - 1 - depth;
  const target = cs[targetIdx];
  if (!target) throw new Error(`branch depth ${depth} exceeds control stack (malformed module)`);
  frame.stack.length = target.stackHeight;
  if (target.kind === 'function') {
    cs.length = targetIdx + 1; // keep only the function scope so doReturn's pop() removes exactly it
    doReturn(state);
    return;
  }
  if (target.kind === 'loop') {
    cs.length = targetIdx + 1;           // keep the loop's own scope, drop anything nested inside it
    frame.pc = target.startIdx! + 1;      // resume at the loop body's first instruction (not the `loop` op itself)
    return;
  }
  cs.length = targetIdx;                 // block / if: exiting it entirely
  frame.pc = target.endIdx + 1;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 4. i32 arithmetic (wrapping / trapping exactly as the spec requires)
// ═══════════════════════════════════════════════════════════════════════════════

const bool = (b: boolean): number => (b ? 1 : 0);
const u = (n: number): number => n >>> 0;

function i32Binop(mnemonic: string, a: number, b: number): number {
  switch (mnemonic) {
    case 'i32.add': return (a + b) | 0;
    case 'i32.sub': return (a - b) | 0;
    case 'i32.mul': return Math.imul(a, b);
    case 'i32.div_s':
      if (b === 0) throw new WasmTrap('integer divide by zero');
      if (a === -2147483648 && b === -1) throw new WasmTrap('integer overflow');
      return (a / b) | 0;
    case 'i32.div_u':
      if (b === 0) throw new WasmTrap('integer divide by zero');
      return (u(a) / u(b)) | 0;
    case 'i32.rem_s':
      if (b === 0) throw new WasmTrap('integer divide by zero');
      return (a % b) | 0;
    case 'i32.rem_u':
      if (b === 0) throw new WasmTrap('integer divide by zero');
      return (u(a) % u(b)) | 0;
    case 'i32.and': return a & b;
    case 'i32.or':  return a | b;
    case 'i32.xor': return a ^ b;
    case 'i32.shl': return a << (b & 31);
    case 'i32.shr_s': return a >> (b & 31);
    case 'i32.shr_u': return a >>> (b & 31);
    case 'i32.eq': return bool(a === b);
    case 'i32.ne': return bool(a !== b);
    case 'i32.lt_s': return bool(a < b);
    case 'i32.lt_u': return bool(u(a) < u(b));
    case 'i32.gt_s': return bool(a > b);
    case 'i32.gt_u': return bool(u(a) > u(b));
    case 'i32.le_s': return bool(a <= b);
    case 'i32.le_u': return bool(u(a) <= u(b));
    case 'i32.ge_s': return bool(a >= b);
    case 'i32.ge_u': return bool(u(a) >= u(b));
    default: throw new Error(`unhandled i32 binop ${mnemonic}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 5. stepOnce — the functional step engine
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Execute exactly one instruction. Clones memory/globals/every active frame
 * (locals, operand stack, control stack) so the input `state` is left
 * untouched — mirrors `eml-vm16-core.ts`'s `stepOnce(state)` contract exactly.
 */
export function stepOnce(state: WasmState): WasmState {
  if (state.halted) return state;

  const memory  = state.memory.slice();
  const globals = [...state.globals];
  const frames: WasmFrame[] = state.frames.map(f => ({
    funcIdx: f.funcIdx,
    locals:  [...f.locals],
    stack:   [...f.stack],
    pc:      f.pc,
    controlStack: f.controlStack.map(c => ({ ...c })),
  }));
  const changed = new Set<number>();
  const next: WasmState = { module: state.module, memory, globals, frames, halted: false, ticks: state.ticks + 1, changed };

  const frame = frames[frames.length - 1];
  const fn: WasmFunc = state.module.funcs[frame.funcIdx];
  const instr: WasmInstr = fn.body[frame.pc];
  const st = frame.stack;

  switch (instr.mnemonic) {
    case 'unreachable': throw new WasmTrap('unreachable executed');
    case 'nop': frame.pc += 1; break;

    case 'block':
      frame.controlStack.push({ kind: 'block', endIdx: instr.matchEnd!, stackHeight: st.length, resultArity: 0 });
      frame.pc += 1; break;
    case 'loop':
      frame.controlStack.push({ kind: 'loop', endIdx: instr.matchEnd!, startIdx: frame.pc, stackHeight: st.length, resultArity: 0 });
      frame.pc += 1; break;
    case 'if': {
      const cond = st.pop()!;
      if (cond !== 0) {
        frame.controlStack.push({ kind: 'if', endIdx: instr.matchEnd!, stackHeight: st.length, resultArity: 0 });
        frame.pc += 1;
      } else if (instr.matchElse !== undefined) {
        frame.controlStack.push({ kind: 'if', endIdx: instr.matchEnd!, stackHeight: st.length, resultArity: 0 });
        frame.pc = instr.matchElse + 1;
      } else {
        frame.pc = instr.matchEnd! + 1;
      }
      break;
    }
    case 'else': {
      const top = frame.controlStack.pop()!;
      frame.pc = top.endIdx + 1;
      break;
    }
    case 'end': {
      const top = frame.controlStack[frame.controlStack.length - 1];
      if (top.kind === 'function') doReturn(next);
      else { frame.controlStack.pop(); frame.pc += 1; }
      break;
    }
    case 'br': branchTo(next, instr.idx!); break;
    case 'br_if': {
      const cond = st.pop()!;
      if (cond !== 0) branchTo(next, instr.idx!);
      else frame.pc += 1;
      break;
    }
    case 'br_table': {
      const i = st.pop()!;
      const depth = (i >= 0 && i < instr.labels!.length) ? instr.labels![i] : instr.default!;
      branchTo(next, depth);
      break;
    }
    case 'return': doReturn(next); break;
    case 'call': {
      const callee = state.module.funcs[instr.idx!];
      const args: number[] = [];
      for (let i = 0; i < callee.numParams; i++) args.unshift(st.pop()!);
      frame.pc += 1; // resume here once the callee returns
      frames.push(makeCallFrame(state.module, instr.idx!, args));
      break;
    }

    case 'drop': st.pop(); frame.pc += 1; break;
    case 'select': {
      const cond = st.pop()!, b = st.pop()!, a = st.pop()!;
      st.push(cond !== 0 ? a : b);
      frame.pc += 1; break;
    }

    case 'local.get': st.push(frame.locals[instr.idx!]); frame.pc += 1; break;
    case 'local.set': frame.locals[instr.idx!] = st.pop()!; frame.pc += 1; break;
    case 'local.tee': frame.locals[instr.idx!] = st[st.length - 1]; frame.pc += 1; break;
    case 'global.get': st.push(globals[instr.idx!]); frame.pc += 1; break;
    case 'global.set': globals[instr.idx!] = st.pop()!; frame.pc += 1; break;

    case 'i32.load': {
      const base = st.pop()!;
      st.push(loadI32(memory, u(base) + instr.memArg!.offset));
      frame.pc += 1; break;
    }
    case 'i32.store': {
      const value = st.pop()!, base = st.pop()!;
      storeI32(memory, u(base) + instr.memArg!.offset, value, changed);
      frame.pc += 1; break;
    }

    case 'i32.const': st.push(instr.i32!); frame.pc += 1; break;
    case 'i32.eqz': st.push(bool(st.pop() === 0)); frame.pc += 1; break;

    default: {
      // remaining i32 binary ops (arithmetic, comparisons, bitwise, shifts)
      const b = st.pop()!, a = st.pop()!;
      st.push(i32Binop(instr.mnemonic, a, b));
      frame.pc += 1; break;
    }
  }

  return next;
}

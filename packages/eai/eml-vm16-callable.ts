/**
 * EML-VM-16 CallableVM
 * EML-EAI-2026-v0.1 · Phase 3: Callable Function API
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Builds on Phase 2 (eml-vm16-core.ts).
 * Provides Promise-based function-call semantics over EML-VM-16 execution.
 *
 * Calling Convention ECC-1 (EML Calling Convention v1):
 *   - Arguments:    R0=arg0, R1=arg1, …, R7=arg7  (up to 8 u8 args)
 *   - Return value: R0 after HALT
 *   - Stack:        reset to 0xFF on each call (callee-owned)
 *   - Registers:    caller saves nothing; callee may clobber all
 */

import {
  u8,
  VMState, VMFlags, LogEntry, VMResult,
  ProgramDefinition, CTS,
  makeVMState, stepOnce,
  decode, hex2, bin8,
  REG_NAMES,
  OPCODE_TABLE,
} from './eml-vm16-core';

// ═══════════════════════════════════════════════════════════════════════════════
// § 1. Phase 3 Type Definitions
// ═══════════════════════════════════════════════════════════════════════════════

/** Supported calling conventions. ECC-1 is the only v1 convention. */
export type CallingConvention = 'ECC-1';

/**
 * Execution mode for a single call.
 * ISOLATED: fresh VMState from base program each call (pure function semantics).
 * SHARED:   memory persists across calls; only PC/SP/flags/args are reset.
 */
export type CallMode = 'ISOLATED' | 'SHARED';

/** Type of a single function parameter under ECC-1. */
export type ParamType =
  | 'u8'       // single unsigned byte value (passed in register)
  | 'ptr';     // address in RAM (passed as u8 address in register)

export interface FunctionParam {
  name:     string;
  type:     ParamType;
  register: number;     // 0–7, which R-register carries this arg
  description?: string;
}

export interface FunctionSignature {
  params:      FunctionParam[];
  returnType:  'u8' | 'void';
  convention:  CallingConvention;
  /** Hard step limit; call fails with 'timeout' if exceeded. */
  maxSteps:    number;
}

/** A named, callable entry point within a loaded program. */
export interface CallableFunction {
  name:        string;
  description: string;
  entryPoint:  u8;          // PC value to jump to before execution
  signature:   FunctionSignature;
  mode:        CallMode;
}

/** Extended VMResult with function-call context. */
export interface VMCallResult extends VMResult {
  functionName: string;
  entryPoint:   u8;
  args:         u8[];
  returnValue:  u8 | null;  // null when returnType === 'void'
  timedOut:     boolean;    // true if maxSteps was reached before HALT
}

/** A program that exports named callable functions. */
export interface CallableProgram extends ProgramDefinition {
  /** Named entry points exposed to callers. */
  exports: CallableFunction[];
}

/** Call options override for callAt(). */
export interface CallOptions {
  mode?:      CallMode;
  maxSteps?:  number;
  convention?: CallingConvention;
}

/**
 * AI-readable manifest describing what a CallableVM exposes.
 * Produced by CallableVM.toManifest(); no execution required.
 */
export interface ProgramManifest {
  program_id:   string;
  program_label: string;
  description:  string;
  code_bytes:   number;
  exports: Array<{
    name:        string;
    description: string;
    entry_point: string;   // e.g. "0x18"
    mode:        CallMode;
    convention:  CallingConvention;
    params: Array<{
      name:     string;
      type:     ParamType;
      register: string;    // e.g. "R0"
    }>;
    returns: string;       // "u8" | "void"
    max_steps: number;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 2. Calling Convention Helpers
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate that `args` matches the function signature's param list.
 * Returns a normalised u8[] aligned to register positions 0–7.
 */
export function resolveArgs(sig: FunctionSignature, args: u8[]): u8[] {
  if (args.length > sig.params.length) {
    throw new TypeError(
      `Too many args: function '${sig.convention}' expects ${sig.params.length}, got ${args.length}`
    );
  }
  const resolved = new Array<u8>(8).fill(0);
  sig.params.forEach((p, i) => {
    const v = args[i] ?? 0;
    if (v < 0 || v > 255 || !Number.isInteger(v)) {
      throw new RangeError(`Arg '${p.name}' must be u8 (0–255), got ${v}`);
    }
    resolved[p.register] = v;
  });
  return resolved;
}

/**
 * Build a call-ready VMState from a base state.
 * Sets PC = entryPoint, loads regArgs into R0–R7, resets SP/flags/log.
 * Does NOT copy or reset memory — that is the caller's responsibility.
 */
export function createCallState(
  base: VMState,
  entryPoint: u8,
  regArgs: u8[],   // aligned to register indices (length 8)
): VMState {
  const regs = new Uint8Array(8);
  regArgs.forEach((v, i) => { if (i < 8) regs[i] = v; });
  return {
    ...base,
    regs,
    pc:     entryPoint,
    sp:     0xFF,
    flags:  { z: false, neg: false, gt: false },
    halted: false,
    ticks:  base.ticks,      // ticks accumulate across calls in SHARED mode
    log:    [],
    changed: new Set(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 3. CallableVM
// ═══════════════════════════════════════════════════════════════════════════════

type StateListener = (state: VMState, callResult?: VMCallResult) => void;

export class CallableVM {
  private program:  CallableProgram;
  private cts:      Partial<CTS>;
  private registry: Map<string, CallableFunction>;
  private shared:   VMState;           // persistent state for SHARED-mode calls
  private listeners: Set<StateListener> = new Set();

  constructor(program: CallableProgram, cts?: Partial<CTS>) {
    this.program  = program;
    this.cts      = { ...(program.cts ?? {}), ...(cts ?? {}) };
    this.registry = new Map();
    this.shared   = makeVMState(program);

    // Auto-register exported functions
    program.exports.forEach(fn => this.registerFunction(fn));
  }

  // ── Registry ─────────────────────────────────────────────────────────────

  registerFunction(fn: CallableFunction): void {
    this.registry.set(fn.name, fn);
  }

  getExports(): Map<string, CallableFunction> {
    return new Map(this.registry);
  }

  hasFunction(name: string): boolean {
    return this.registry.has(name);
  }

  // ── Calling API ───────────────────────────────────────────────────────────

  /**
   * Call a named function with arguments.
   * @param name - must exist in the function registry
   * @param args - positional args aligned to signature.params
   */
  async call(name: string, args: u8[] = []): Promise<VMCallResult> {
    const fn = this.registry.get(name);
    if (!fn) throw new Error(`CallableVM: function '${name}' not registered`);
    const regArgs = resolveArgs(fn.signature, args);
    return this._execute(fn.entryPoint, regArgs, fn);
  }

  /**
   * Call a raw entry point address, bypassing the registry.
   * Useful for debugging or dynamic dispatch.
   */
  async callAt(
    entryPoint: u8,
    args: u8[] = [],
    opts: CallOptions = {},
  ): Promise<VMCallResult> {
    const regArgs = [...args, ...new Array(8 - args.length).fill(0)].slice(0, 8) as u8[];
    return this._execute(entryPoint, regArgs, undefined, opts);
  }

  // ── State Access ─────────────────────────────────────────────────────────

  getSharedState(): VMState { return this.shared; }

  getSharedMemory(): Readonly<Uint8Array> { return this.shared.memory; }

  peekAddr(addr: u8): u8 { return this.shared.memory[addr]; }

  resetShared(): void {
    this.shared = makeVMState(this.program);
    this._notify(this.shared);
  }

  // ── Observation ───────────────────────────────────────────────────────────

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ── Manifest (AI-readable description) ───────────────────────────────────

  /**
   * Produce a structured description of this VM's public interface.
   * No execution is required. Designed for consumption by AI agents.
   */
  toManifest(): ProgramManifest {
    return {
      program_id:    this.program.id,
      program_label: this.program.label,
      description:   this.program.description,
      code_bytes:    this.program.code.length,
      exports: [...this.registry.values()].map(fn => ({
        name:        fn.name,
        description: fn.description,
        entry_point: `0x${hex2(fn.entryPoint)}`,
        mode:        fn.mode,
        convention:  fn.signature.convention,
        params: fn.signature.params.map(p => ({
          name:     p.name,
          type:     p.type,
          register: REG_NAMES[p.register],
          description: p.description ?? '',
        })),
        returns:   fn.signature.returnType,
        max_steps: fn.signature.maxSteps,
      })),
    };
  }

  /**
   * Produce an AI-readable call-result summary.
   * Pairs with toManifest() to give agents a full understanding
   * of what happened during a call.
   */
  static summarizeResult(result: VMCallResult): object {
    return {
      function:     result.functionName,
      entry_point:  `0x${hex2(result.entryPoint)}`,
      args:         Object.fromEntries(
        result.args.map((v, i) => [REG_NAMES[i], v])
      ),
      return_value: result.returnValue,
      timed_out:    result.timedOut,
      steps:        result.steps,
      memory_writes: [...result.memoryDiff.entries()].map(([addr, d]) => ({
        addr:   `0x${hex2(addr)}`,
        before: hex2(d.before),
        after:  hex2(d.after),
      })),
      final_regs: Object.fromEntries(
        Array.from(result.finalState.regs).map((v, i) => [REG_NAMES[i], v])
      ),
    };
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _execute(
    entryPoint: u8,
    regArgs:    u8[],
    fn?:        CallableFunction,
    opts:       CallOptions = {},
  ): Promise<VMCallResult> {
    const mode     = opts.mode     ?? fn?.mode                   ?? 'ISOLATED';
    const maxSteps = opts.maxSteps ?? fn?.signature.maxSteps     ?? 100_000;

    // --- Build initial call state ---
    const baseState = mode === 'ISOLATED'
      ? makeVMState(this.program)
      : this.shared;

    const callState = createCallState(baseState, entryPoint, regArgs);
    const memBefore = new Uint8Array(callState.memory);

    // --- Execute synchronously (no async needed for small VMs) ---
    let state = callState;
    let steps = 0;
    const trace: LogEntry[] = [];
    let timedOut = false;

    while (!state.halted && steps < maxSteps) {
      state = stepOnce(state, this.cts);
      if (state.log[0]) trace.push(state.log[0]);
      steps++;
      // Yield to event loop every 2000 steps to stay non-blocking
      if (steps % 2000 === 0) await new Promise(r => setTimeout(r, 0));
    }

    if (!state.halted) timedOut = true;

    // --- Update shared state if needed ---
    if (mode === 'SHARED') {
      this.shared = state;
    }

    // --- Build diff ---
    const memoryDiff = new Map<u8, { before: u8; after: u8 }>();
    for (let a = 0; a < 256; a++) {
      if (memBefore[a] !== state.memory[a]) {
        memoryDiff.set(a as u8, { before: memBefore[a], after: state.memory[a] });
      }
    }

    const returnValue = (fn?.signature.returnType ?? 'u8') !== 'void'
      ? state.regs[0]
      : null;

    const result: VMCallResult = {
      finalState:   state,
      memoryDiff,
      steps,
      trace,
      functionName: fn?.name ?? `@0x${hex2(entryPoint)}`,
      entryPoint,
      args:         regArgs,
      returnValue,
      timedOut,
    };

    this._notify(state, result);
    return result;
  }

  private _notify(state: VMState, result?: VMCallResult): void {
    this.listeners.forEach(fn => fn(state, result));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 4. Built-in Callable Functions (ECC-1, machine code hand-verified)
//
// Memory layout of PROGRAM_FUNCTIONS:
//   0x00–0x03  ADD       : R0 = R0 + R1
//   0x04–0x07  XOR_BYTE  : R0 = R0 ^ R1
//   0x08–0x17  SUM_RANGE : R0 = Σ(R0..R1) inclusive
//   0x18–0x41  FIB_N     : R0 = fib(R0),  fib(0)=0, fib(1)=1
// ═══════════════════════════════════════════════════════════════════════════════

const SIG_UNARY: FunctionSignature = {
  params: [{ name:'a', type:'u8', register:0 }, { name:'b', type:'u8', register:1 }],
  returnType: 'u8',
  convention: 'ECC-1',
  maxSteps: 32,
};

const SIG_RANGE: FunctionSignature = {
  params: [{ name:'start', type:'u8', register:0, description:'inclusive lower bound' },
           { name:'end',   type:'u8', register:1, description:'inclusive upper bound'  }],
  returnType: 'u8',
  convention: 'ECC-1',
  maxSteps: 2048,
};

const SIG_FIB: FunctionSignature = {
  params: [{ name:'n', type:'u8', register:0, description:'index (0-based), max≈13 within u8' }],
  returnType: 'u8',
  convention: 'ECC-1',
  maxSteps: 512,
};

export const FN_ADD: CallableFunction = {
  name:        'add',
  description: 'Return a + b (mod 256).',
  entryPoint:  0x00,
  signature:   SIG_UNARY,
  mode:        'ISOLATED',
};

export const FN_XOR_BYTE: CallableFunction = {
  name:        'xor_byte',
  description: 'Return a XOR b (single-byte XOR).',
  entryPoint:  0x04,
  signature:   SIG_UNARY,
  mode:        'ISOLATED',
};

export const FN_SUM_RANGE: CallableFunction = {
  name:        'sum_range',
  description: 'Return Σ of all integers from start to end inclusive (mod 256).',
  entryPoint:  0x08,
  signature:   SIG_RANGE,
  mode:        'ISOLATED',
};

export const FN_FIB_N: CallableFunction = {
  name:        'fib_n',
  description: 'Return fib(n). fib(0)=0, fib(1)=1, fib(k)=fib(k-1)+fib(k-2). Results mod 256 for n>13.',
  entryPoint:  0x18,
  signature:   SIG_FIB,
  mode:        'ISOLATED',
};

/**
 * Combined program containing all four callable functions.
 *
 * Machine code layout (hand-assembled, addresses verified):
 *
 * ADD      @ 0x00:  ADD R0,R1 → HALT
 * XOR_BYTE @ 0x04:  XOR R0,R1 → HALT
 * SUM_RANGE@ 0x08:  MOVI R2,0 / CMP R0,R1 / JG 0x14 / ADD R2,R0 / INC R0 / JMP 0x0A / MOV R0,R2 / HALT
 * FIB_N    @ 0x18:  edge(n=0)→0x3C / edge(n=1)→0x3E / setup(R1=0,R2=1,R3=2) / LOOP@0x2A / return R2
 */
export const PROGRAM_FUNCTIONS: CallableProgram = {
  id:          'eml-functions-v1',
  label:       'EML Function Library v1',
  description: 'Four callable pure functions: add, xor_byte, sum_range, fib_n.',
  code: [
    // ── ADD @ 0x00 ────────────────────────────────────────────────────────
    // R0 = R0 + R1; HALT
    0x20,0x01,  // 0x00: ADD R0, R1
    0x01,0x00,  // 0x02: HALT

    // ── XOR_BYTE @ 0x04 ──────────────────────────────────────────────────
    // R0 = R0 ^ R1; HALT
    0x32,0x01,  // 0x04: XOR R0, R1
    0x01,0x00,  // 0x06: HALT

    // ── SUM_RANGE @ 0x08 ─────────────────────────────────────────────────
    // R0=start R1=end → R0 = Σ(start..end)
    // R2=acc=0; LOOP: if R0>R1 exit; acc+=R0; R0++; LOOP; MOV R0,R2; HALT
    0x11,0x20,  // 0x08: MOVI R2, 0        acc=0
    0x40,0x01,  // 0x0A: CMP R0, R1        curr vs end
    0x53,0x14,  // 0x0C: JG 0x14           exit if curr>end
    0x20,0x20,  // 0x0E: ADD R2, R0        acc += curr
    0x41,0x00,  // 0x10: INC R0            curr++
    0x50,0x0A,  // 0x12: JMP 0x0A          loop
    0x10,0x02,  // 0x14: MOV R0, R2        retval = acc
    0x01,0x00,  // 0x16: HALT

    // ── FIB_N @ 0x18 ─────────────────────────────────────────────────────
    // R0=n → R0 = fib(n)
    // Edges: n=0→HALT@0x3C(R0=0 already); n=1→MOVI R0,1+HALT@0x3E
    // General: a=0,b=1,ctr=2; LOOP@0x2A: t=a+b;a=b;b=t;ctr++;ctr>n→exit; R0=b
    0x11,0x50,  // 0x18: MOVI R5, 0        comparison sentinel
    0x40,0x05,  // 0x1A: CMP R0, R5        n vs 0
    0x51,0x3C,  // 0x1C: JZ 0x3C           n=0: HALT (R0=0)
    0x11,0x51,  // 0x1E: MOVI R5, 1
    0x40,0x05,  // 0x20: CMP R0, R5        n vs 1
    0x51,0x3E,  // 0x22: JZ 0x3E           n=1: MOVI R0,1+HALT
    0x11,0x10,  // 0x24: MOVI R1, 0        a=0
    0x11,0x21,  // 0x26: MOVI R2, 1        b=1
    0x11,0x32,  // 0x28: MOVI R3, 2        ctr=2
    0x10,0x41,  // 0x2A: MOV R4, R1        t=a         ← LOOP
    0x20,0x42,  // 0x2C: ADD R4, R2        t=a+b
    0x10,0x12,  // 0x2E: MOV R1, R2        a=b
    0x10,0x24,  // 0x30: MOV R2, R4        b=t
    0x41,0x30,  // 0x32: INC R3            ctr++
    0x40,0x30,  // 0x34: CMP R3, R0        ctr vs n
    0x56,0x2A,  // 0x36: JLE 0x2A          ctr≤n: loop
    0x10,0x02,  // 0x38: MOV R0, R2        retval=b=fib(n)
    0x01,0x00,  // 0x3A: HALT              general return
    0x01,0x00,  // 0x3C: HALT              n=0 edge (R0=0 already)
    0x11,0x01,  // 0x3E: MOVI R0, 1        n=1 edge
    0x01,0x00,  // 0x40: HALT
  ],
  initMem: {},
  cts: {
    symbolTable: new Map([
      [0x00, { name:'add',       region:'code', type:'label', size:4  }],
      [0x04, { name:'xor_byte',  region:'code', type:'label', size:4  }],
      [0x08, { name:'sum_range', region:'code', type:'label', size:16 }],
      [0x0A, { name:'sr_loop',   region:'code', type:'label', size:2  }],
      [0x14, { name:'sr_exit',   region:'code', type:'label', size:4  }],
      [0x18, { name:'fib_n',     region:'code', type:'label', size:42 }],
      [0x2A, { name:'fib_loop',  region:'code', type:'label', size:2  }],
      [0x3C, { name:'fib_r0',    region:'code', type:'label', size:2  }],
      [0x3E, { name:'fib_r1',    region:'code', type:'label', size:4  }],
    ]),
    commentTable: new Map([
      [0x00, 'add(R0,R1) → R0+R1 mod 256'],
      [0x04, 'xor_byte(R0,R1) → R0 XOR R1'],
      [0x08, 'sum_range(R0=start,R1=end) → Σ(start..end) mod 256'],
      [0x18, 'fib_n(R0=n) → fib(n); fib(0)=0, fib(1)=1'],
      [0x2A, 'LOOP: t=a+b; a=b; b=t; ctr++'],
      [0x3C, 'edge case: n=0, return 0'],
      [0x3E, 'edge case: n=1, return 1'],
    ]),
    typeTable: [
      { start:0x00, end:0x42, kind:'code',  colorHint:'#002a00' },
      { start:0x42, end:0xFF, kind:'data',  colorHint:'#00001a' },
      { start:0xE0, end:0xFF, kind:'stack', colorHint:'#1a0000' },
    ],
  },
  exports: [FN_ADD, FN_XOR_BYTE, FN_SUM_RANGE, FN_FIB_N],
};

// ═══════════════════════════════════════════════════════════════════════════════
// § 5. Factory & Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/** Convenience: create a CallableVM from a CallableProgram in one line. */
export function createCallableVM(program: CallableProgram, cts?: Partial<CTS>): CallableVM {
  return new CallableVM(program, cts);
}

/** Build a CallableProgram by augmenting a plain ProgramDefinition with exports. */
export function makeCallableProgram(
  base: ProgramDefinition,
  exports: CallableFunction[],
): CallableProgram {
  return { ...base, exports };
}

/**
 * Validate that a CallableFunction's entry point lies within the program's
 * code array and that all param registers are within [0,7].
 */
export function validateCallableFunction(
  fn:      CallableFunction,
  program: ProgramDefinition,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (fn.entryPoint >= program.code.length) {
    errors.push(`entryPoint 0x${hex2(fn.entryPoint)} exceeds code length ${program.code.length}`);
  }
  fn.signature.params.forEach(p => {
    if (p.register < 0 || p.register > 7) {
      errors.push(`param '${p.name}': register ${p.register} out of range [0,7]`);
    }
  });
  if (fn.signature.params.length > 8) {
    errors.push(`too many params: ECC-1 supports max 8, got ${fn.signature.params.length}`);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Run a quick self-test of all exported functions in a CallableVM.
 * Returns pass/fail per function using the provided test vectors.
 */
export interface TestVector {
  fn:       string;
  args:     u8[];
  expected: u8;
}

export async function selfTest(
  vm:      CallableVM,
  vectors: TestVector[],
): Promise<Array<{ fn: string; args: u8[]; expected: u8; got: u8 | null; pass: boolean }>> {
  const results = [];
  for (const v of vectors) {
    const result = await vm.call(v.fn, v.args);
    const got    = result.returnValue;
    results.push({ fn: v.fn, args: v.args, expected: v.expected, got, pass: got === v.expected });
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 6. Default Test Vectors for PROGRAM_FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

export const DEFAULT_TEST_VECTORS: TestVector[] = [
  // add
  { fn:'add',       args:[0,  0  ], expected:0   },
  { fn:'add',       args:[3,  5  ], expected:8   },
  { fn:'add',       args:[200,60 ], expected:4   },   // 260 mod 256 = 4
  // xor_byte
  { fn:'xor_byte',  args:[0xFF,0xFF], expected:0  },
  { fn:'xor_byte',  args:[0xDE,0xAD], expected:0x73 },
  { fn:'xor_byte',  args:[0x0A,0x0A], expected:0  },
  // sum_range
  { fn:'sum_range', args:[1,  5  ], expected:15  },   // 1+2+3+4+5=15
  { fn:'sum_range', args:[5,  5  ], expected:5   },   // single element
  { fn:'sum_range', args:[0,  10 ], expected:55  },   // 0+1+…+10=55
  // fib_n
  { fn:'fib_n',     args:[0       ], expected:0  },
  { fn:'fib_n',     args:[1       ], expected:1  },
  { fn:'fib_n',     args:[5       ], expected:5  },
  { fn:'fib_n',     args:[10      ], expected:55 },
  { fn:'fib_n',     args:[13      ], expected:233 }, // fib(13)=233, last that fits u8
];

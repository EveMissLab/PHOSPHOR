/**
 * EML-VM-BASIC Core Module
 * EML-EAI-2026-v0.4 · BASIC profile: bounded-integer value domain
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * EML-VM-BASIC is a teaching/safety profile of EML-VM-16. It reuses VM-16's
 * ISA SUBSET, instruction decode, and 8-bit addressing (256 cells), but each
 * register / memory cell holds an integer in a BOUNDED-INTEGER domain [0,N]
 * (N default 10000, parameterizable) — it is NOT a hardware u8.
 *
 *   EML-VM-16                       EML-VM-BASIC
 *   ───────────────────────────     ─────────────────────────────────────────
 *   value domain = u8 [0,255]       value domain = bounded int [0,N], N≫255
 *   Uint8Array memory/regs          Int32Array memory/regs (wide cells)
 *   full ISA (logic, stack, …)      constrained allow-list of MNEMONICS
 *   overflow = & 0xFF (wrap u8)     overflow = wrap mod (N+1) | clamp | throw
 *
 * Rationale (spec §9.2): a bounded-integer domain lets BASIC programs compute
 * results > 255 (proving the cells are wide) while still being fully
 * constrained — an allow-list of opcodes plus an explicit overflow policy makes
 * every program's behaviour decidable up front (validateProgramConstraints) and
 * its runtime envelope provable (bound()). 8-bit addressing is retained: any
 * register used as an address is masked to &0xFF (256 cells).
 */

import {
  decode, hex2, REG_NAMES, OPCODE_TABLE,
  type ProgramDefinition, type CTS, type VMFlags,
} from './eml-vm16-core';

// ═══════════════════════════════════════════════════════════════════════════════
// § 1. Constraint Violation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Thrown when a BASIC program violates its constraints, either statically
 * (a disallowed opcode reached at runtime: kind 'op') or dynamically (a value
 * leaves [0,N] under the 'throw' overflow policy: kind 'overflow').
 */
export class ConstraintViolation extends Error {
  info?: {
    kind:      'op' | 'overflow';
    op?:       number;
    mnemonic?: string;
    pc?:       number;
    value?:    number;
  };

  constructor(message: string, info?: ConstraintViolation['info']) {
    super(message);
    this.name = 'ConstraintViolation';
    this.info = info;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 2. Constraint Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Overflow policy applied by bound() when a computed value leaves [0,maxValue]. */
export type Overflow = 'wrap' | 'clamp' | 'throw';

/**
 * The BASIC profile's constraint set.
 *   - maxValue:   inclusive upper bound N of the value domain [0,N].
 *   - allowedOps: the permitted ISA subset, given as MNEMONICS (e.g. 'ADD').
 *   - overflow:   policy for out-of-range results (default 'wrap').
 */
export interface BasicConstraints {
  maxValue:    number;
  allowedOps:  string[];   // MNEMONICS, not opcodes
  overflow?:   Overflow;
}

/** Default BASIC constraints (spec §9.2): N=10000, wrap-mod overflow, ISA subset. */
export const DEFAULT_BASIC_CONSTRAINTS: BasicConstraints = {
  maxValue:   10000,
  allowedOps: [
    'ADD', 'ADDI', 'SUB', 'SUBI', 'CMP', 'INC', 'DEC',
    'JMP', 'JZ', 'JNZ', 'JG', 'JL', 'JGE', 'JLE',
    'LD', 'ST', 'MOV', 'MOVI', 'HALT', 'NOP',
  ],
  overflow:   'wrap',
};

// ═══════════════════════════════════════════════════════════════════════════════
// § 3. BASIC VM State
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Complete BASIC VM snapshot at a single tick. Treated as immutable by the
 * functional core (stepOnceBasic / stepNBasic return fresh state).
 *
 * Memory and registers are Int32Array — each cell holds a bounded integer in
 * [0,maxValue], NOT a u8. Addressing remains 8-bit (256 cells).
 */
export interface BasicState {
  memory:  Int32Array;     // 256 cells, each holds a bounded int [0,N]
  regs:    Int32Array;     // R0–R7, each holds a bounded int [0,N]
  pc:      number;
  sp:      number;         // grows downward from 0xFF (8-bit addressing)
  flags:   VMFlags;
  halted:  boolean;
  ticks:   number;
  changed: Set<number>;    // addresses written this tick
  log:     { pc: number; decoded: string; ticks: number }[];
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 4. Bounded Arithmetic
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Apply the overflow policy to a raw arithmetic result, mapping it back into
 * the bounded-integer domain [0,maxValue].
 *
 *   wrap:  modular arithmetic over (maxValue+1), normalised to be non-negative.
 *   clamp: saturate to [0,maxValue].
 *   throw: reject any out-of-range value with a ConstraintViolation.
 */
export function bound(x: number, maxValue: number, mode: Overflow): number {
  switch (mode) {
    case 'wrap': {
      const m = maxValue + 1;
      return ((x % m) + m) % m;
    }
    case 'clamp':
      return Math.max(0, Math.min(maxValue, x));
    case 'throw':
      if (x < 0 || x > maxValue) {
        throw new ConstraintViolation(`value ${x} out of [0,${maxValue}]`, { kind: 'overflow', value: x });
      }
      return x;
  }
}

const LOG_MAX = 64;

// ═══════════════════════════════════════════════════════════════════════════════
// § 5. Functional Core — pure, immutable BASIC VM steps
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a fresh BasicState from a ProgramDefinition.
 * Like makeVMState, but memory/regs are Int32Array (wide bounded cells).
 * No side effects; returns a new state object every call.
 */
export function makeBasicState(
  program:     ProgramDefinition,
  _constraints?: BasicConstraints,
): BasicState {
  const memory = new Int32Array(256);
  program.code.forEach((b, i) => { memory[i] = b; });
  Object.entries(program.initMem).forEach(([k, v]) => {
    if (v !== undefined) memory[parseInt(k)] = v;
  });
  return {
    memory,
    regs:    new Int32Array(8),
    pc:      0,
    sp:      0xFF,
    flags:   { z: false, neg: false, gt: false },
    halted:  false,
    ticks:   0,
    changed: new Set(),
    log:     [],
  };
}

/**
 * Statically scan a program's code in 2-byte steps and report any instruction
 * whose opcode is unknown or whose mnemonic is not in the constraints'
 * allow-list. Returns every violation found (does not stop at the first).
 */
export function validateProgramConstraints(
  program:     ProgramDefinition,
  constraints: BasicConstraints,
): { valid: boolean; violations: { addr: number; op: number; mnemonic: string }[] } {
  const allowed = new Set(constraints.allowedOps);
  const violations: { addr: number; op: number; mnemonic: string }[] = [];
  const { code } = program;
  for (let i = 0; i + 1 < code.length; i += 2) {
    const op = code[i];
    const mnemonic = OPCODE_TABLE.get(op)?.mnemonic;
    if (!mnemonic || !allowed.has(mnemonic)) {
      violations.push({ addr: i, op, mnemonic: mnemonic ?? `??? 0x${hex2(op)}` });
    }
  }
  return { valid: violations.length === 0, violations };
}

/**
 * Execute one instruction under BASIC constraints.
 * Pure function: does not mutate input state; returns fresh state.
 *
 * Values live in [0,maxValue] (bounded integers). All arithmetic is funnelled
 * through bound(...) so the configured overflow policy is the single source of
 * truth. Any opcode whose mnemonic is not allowed raises a ConstraintViolation
 * (kind 'op'). Registers used as addresses are masked to &0xFF (8-bit/256-cell).
 */
export function stepOnceBasic(
  state:       BasicState,
  constraints: BasicConstraints,
  cts?:        Partial<CTS>,
): BasicState {
  if (state.halted) return state;

  const N    = constraints.maxValue;
  const mode = constraints.overflow ?? 'wrap';
  const b    = (x: number): number => bound(x, N, mode);

  const mem  = Int32Array.from(state.memory);
  const regs = Int32Array.from(state.regs);
  const fl   = { ...state.flags };
  const chg  = new Set<number>();
  let { pc, sp } = state;
  let halted = false;

  const op  = mem[pc];
  const arg = mem[(pc + 1) & 0xFF] & 0xFF;   // mask arg to a byte for decode/indices
  const d   = (arg >> 4) & 0xF;
  const s   = arg & 0xF;

  const mnemonic = OPCODE_TABLE.get(op)?.mnemonic;
  if (!mnemonic || !(constraints.allowedOps.includes(mnemonic))) {
    throw new ConstraintViolation(
      `opcode 0x${hex2(op)} (${mnemonic ?? 'unknown'}) not allowed at pc=${pc}`,
      { kind: 'op', op, mnemonic, pc },
    );
  }

  const decoded = decode(op, arg, cts);
  const lastPc  = pc;
  pc = (pc + 2) & 0xFF;   // advance before conditional branch

  switch (op) {
    case 0x00: break;                                   // NOP
    case 0x01: halted = true; break;                    // HALT

    case 0x10: regs[d] = regs[s]; break;                // MOV  Rd = Rs
    case 0x11: regs[d] = s; break;                      // MOVI Rd = imm4

    case 0x20: regs[d] = b(regs[d] + regs[s]); break;   // ADD
    case 0x21: regs[d] = b(regs[d] + s);       break;   // ADDI
    case 0x22: regs[d] = b(regs[d] - regs[s]); break;   // SUB
    case 0x23: regs[d] = b(regs[d] - s);       break;   // SUBI

    case 0x40: {                                        // CMP — set flags from Rd vs Rs
      const a = regs[d], bv = regs[s];
      fl.z = a === bv; fl.neg = a < bv; fl.gt = a > bv;
      break;
    }
    case 0x41: regs[d] = b(regs[d] + 1); break;         // INC
    case 0x42: regs[d] = b(regs[d] - 1); break;         // DEC

    case 0x50: pc = arg; break;                         // JMP
    case 0x51: if (fl.z)    pc = arg; break;            // JZ
    case 0x52: if (!fl.z)   pc = arg; break;            // JNZ
    case 0x53: if (fl.gt)   pc = arg; break;            // JG
    case 0x54: if (fl.neg)  pc = arg; break;            // JL
    case 0x55: if (!fl.neg) pc = arg; break;            // JGE
    case 0x56: if (!fl.gt)  pc = arg; break;            // JLE

    case 0x80: regs[d] = mem[regs[s] & 0xFF]; break;    // LD  Rd = MEM[Rs] (addr masked)
    case 0x81: {                                        // ST  MEM[Rd] = Rs (addr masked)
      const addr = regs[d] & 0xFF;
      mem[addr] = b(regs[s]);
      chg.add(addr);
      break;
    }
  }

  const entry = { pc: lastPc, decoded, ticks: state.ticks + 1 };
  const log = [entry, ...state.log.slice(0, LOG_MAX - 1)];

  return { memory: mem, regs, pc, sp, flags: fl, halted, ticks: state.ticks + 1, changed: chg, log };
}

/**
 * Execute N instructions under BASIC constraints in a single call.
 * Accumulates all changed addresses across all steps; stops early on HALT.
 */
export function stepNBasic(
  state:       BasicState,
  n:           number,
  constraints: BasicConstraints,
  cts?:        Partial<CTS>,
): BasicState {
  let cur = state;
  const allChanged = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (cur.halted) break;
    cur = stepOnceBasic(cur, constraints, cts);
    cur.changed.forEach(a => allChanged.add(a));
  }
  return { ...cur, changed: allChanged };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 6. Built-in BASIC Program
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * BASIC_SUM:
 * Accumulate 20 × 15 = 300 into R0 with a counted loop, then HALT.
 * GROUND TRUTH: on HALT, R0 === 300 (a value > 255 — impossible on a u8 cell,
 * proving BASIC's wide bounded-integer cells). Uses only allowed mnemonics.
 *
 * Registers: R0 = accumulator, R1 = counter, R2 = limit (20).
 * imm4 caps at 15, so the limit 20 is built as 15 + 5.
 *
 * Layout (16 bytes, loads at 0x00 — code/data are non-overlapping; this program
 * writes nothing to memory, so no data region is used):
 *   0x00  MOVI R0, #0      [11][00]   accumulator = 0
 *   0x02  MOVI R1, #0      [11][10]   counter = 0
 *   0x04  MOVI R2, #15     [11][2F]   limit = 15 …
 *   0x06  ADDI R2, #5      [21][25]   … + 5 = 20
 *   LOOP @ 0x08
 *   0x08  ADDI R0, #15     [21][0F]   accumulator += 15
 *   0x0A  INC  R1          [41][10]   counter++
 *   0x0C  CMP  R1, R2      [40][12]   compare counter vs 20
 *   0x0E  JL   0x08        [54][08]   while counter < 20 → LOOP (20 iterations)
 *   0x10  HALT             [01][00]
 *
 * Iteration trace: ADDI runs once per loop pass; the loop body runs while
 * R1 < 20. R1 takes values 1..20 across passes; it branches back for R1=1..19
 * and falls through when R1=20 → exactly 20 executions of ADDI #15 → R0 = 300.
 */
export const PROGRAM_BASIC_SUM: ProgramDefinition = {
  id:    'basic-sum',
  label: 'BASIC_SUM',
  description: 'Sum 20×15 = 300 into R0 (result > 255 proves wide bounded-int cells).',
  code: [
    0x11, 0x00,   // 0x00: MOVI R0, #0
    0x11, 0x10,   // 0x02: MOVI R1, #0
    0x11, 0x2F,   // 0x04: MOVI R2, #15
    0x21, 0x25,   // 0x06: ADDI R2, #5   → R2 = 20
    // LOOP @ 0x08
    0x21, 0x0F,   // 0x08: ADDI R0, #15
    0x41, 0x10,   // 0x0A: INC  R1
    0x40, 0x12,   // 0x0C: CMP  R1, R2
    0x54, 0x08,   // 0x0E: JL   0x08  (while R1 < 20)
    0x01, 0x00,   // 0x10: HALT
  ],
  initMem: {},
  cts: {
    symbolTable: new Map([
      [0x00, { name: 'INIT', region: 'code', type: 'label', size: 8 }],
      [0x08, { name: 'LOOP', region: 'code', type: 'label', size: 8 }],
    ]),
    commentTable: new Map([
      [0x00, 'R0=accumulator(0), R1=counter(0)'],
      [0x04, 'R2 = limit = 15 + 5 = 20'],
      [0x08, 'LOOP: R0 += 15; counter++; CMP; JL while counter < 20'],
      [0x10, 'HALT — ground truth: R0 == 300'],
    ]),
    typeTable: [
      { start: 0x00, end: 0x11, kind: 'code',  colorHint: '#003300' },
      { start: 0xE0, end: 0xFF, kind: 'stack', colorHint: '#220000' },
    ],
  },
};

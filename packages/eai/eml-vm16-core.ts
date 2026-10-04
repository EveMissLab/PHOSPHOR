/**
 * EML-VM-16 Core Module
 * EML-EAI-2026-v0.1 · Phase 2: VMCore (純 TypeScript，無 UI 依賴)
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Architecture: 8-bit data · 8-bit address (256B RAM) · 8 registers
 * Instruction format: [opcode:8][arg:8]  arg = [dst:4 | src/imm:4]
 * Jump/CALL instructions use full arg byte as 8-bit absolute address
 */

// ═══════════════════════════════════════════════════════════════════════════════
// § 1. Primitive Types
// ═══════════════════════════════════════════════════════════════════════════════

/** 8-bit unsigned integer (0–255). All VM data values and addresses. */
export type u8 = number;

/**
 * Live EAI protocol/spec version advertised at runtime — the agent welcome
 * `proto` field and the serialized manager-state `version`. Single source of
 * truth so the two surfaces an agent reads cannot drift (they sat stale at
 * `v0.1` from Phase 5 through v0.4 while the spec moved to v0.5).
 */
export const EAI_PROTO = 'EML-EAI-2026-v0.5';

// ═══════════════════════════════════════════════════════════════════════════════
// § 2. Correspondence Table System (CTS) — Type Definitions
// Completes Phase 1 CTS interface specification.
// ═══════════════════════════════════════════════════════════════════════════════

export type ArgType =
  | 'REG_REG'    // [dst:4 | src:4]
  | 'REG_IMM4'   // [dst:4 | imm:4]
  | 'REG_ONLY'   // [dst:4 | 0x0]
  | 'ADDR8'      // full arg byte = 8-bit target address
  | 'NONE';      // arg byte unused

export type RegionKind = 'code' | 'data' | 'stack' | 'string' | 'io' | 'unknown';
export type DataType = 'u8' | 'i8' | 'ptr' | 'char' | 'label' | 'unknown';
export type Flag = 'Z' | 'N' | 'G';

/** CTS Layer 1: opcode → mnemonic, encoding type, description */
export interface OpcodeEntry {
  mnemonic:     string;
  argType:      ArgType;
  description:  string;
  flagsWritten: Flag[];
}

/** CTS Layer 2: address → named symbol */
export interface SymbolEntry {
  name:   string;
  region: RegionKind;
  type:   DataType;
  size:   number;        // bytes occupied
}

/** CTS Layer 3: address range → data kind and visual hint */
export interface RegionEntry {
  start:     u8;
  end:       u8;
  kind:      RegionKind;
  colorHint: string;     // CSS color suggestion for visualizers
}

/** CTS Layer 6: per-address caller/reader/writer sets (computation graph) */
export interface CrossRefEntry {
  callers:     u8[];   // instruction addresses that jump/call here
  dataReaders: u8[];   // instruction addresses that LD from this address
  dataWriters: u8[];   // instruction addresses that ST to this address
}

/** Complete Correspondence Table System */
export interface CTS {
  opcodeTable:  Map<u8, OpcodeEntry>;     // Layer 1
  symbolTable:  Map<u8, SymbolEntry>;     // Layer 2
  typeTable:    RegionEntry[];            // Layer 3
  stringTable:  Map<u8, string>;          // Layer 4: addr → decoded string
  commentTable: Map<u8, string>;          // Layer 5: addr → annotation
  crossRefTable: Map<u8, CrossRefEntry>;  // Layer 6
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 3. VM State Types
// ═══════════════════════════════════════════════════════════════════════════════

export interface VMFlags {
  z:   boolean;   // zero / equal
  neg: boolean;   // negative / less-than
  gt:  boolean;   // greater-than
}

export interface LogEntry {
  pc:      u8;
  decoded: string;
  ticks:   number;
}

/** Complete VM snapshot at a single tick. Treated as immutable by core functions. */
export interface VMState {
  memory:  Uint8Array;    // 256 bytes
  regs:    Uint8Array;    // R0–R7
  pc:      u8;
  sp:      u8;            // grows downward from 0xFF
  flags:   VMFlags;
  halted:  boolean;
  ticks:   number;
  log:     LogEntry[];    // last N entries, newest first
  changed: Set<u8>;       // addresses written this tick
}

/** Result returned by VMController.run() */
export interface VMResult {
  finalState:  VMState;
  memoryDiff:  Map<u8, { before: u8; after: u8 }>;
  steps:       number;
  trace:       LogEntry[];
}

/** AI-readable JSON snapshot (produced by VMController.toJSON()) */
export interface VMSnapshot {
  vm_id:             string;
  tick:              number;
  pc:                string;          // e.g. "0x1A"
  pc_symbol:         string | null;   // from symbolTable, e.g. "LOOP"
  pc_comment:        string | null;   // from commentTable
  instruction:       string;          // decoded mnemonic
  registers:         Record<string, number>;
  flags:             { Z: boolean; N: boolean; G: boolean };
  changed_this_tick: Array<{ addr: string; symbol: string | null; before: u8; after: u8 }>;
  stack_depth:       number;          // 0xFF - sp
  halted:            boolean;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 4. Program Definition
// ═══════════════════════════════════════════════════════════════════════════════

export interface ProgramDefinition {
  id:          string;
  label:       string;
  description: string;
  code:        u8[];
  initMem:     Partial<Record<number, u8>>;
  cts:         Partial<CTS>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 5. Register Names & Helpers
// ═══════════════════════════════════════════════════════════════════════════════

export const REG_NAMES: readonly string[] = ['R0','R1','R2','R3','R4','R5','R6','R7'];

/** Zero-pad hex, 2 digits */
export const hex2 = (n: u8): string => n.toString(16).toUpperCase().padStart(2, '0');

/** 8-bit binary string */
export const bin8 = (n: u8): string => n.toString(2).padStart(8, '0');

// ═══════════════════════════════════════════════════════════════════════════════
// § 6. Opcode Table (CTS Layer 1) — complete ISA definition
// ═══════════════════════════════════════════════════════════════════════════════

export const OPCODE_TABLE: Map<u8, OpcodeEntry> = new Map([
  [0x00, { mnemonic:'NOP',  argType:'NONE',     description:'No operation',                  flagsWritten:[] }],
  [0x01, { mnemonic:'HALT', argType:'NONE',     description:'Halt execution',                flagsWritten:[] }],

  [0x10, { mnemonic:'MOV',  argType:'REG_REG',  description:'Rd = Rs',                       flagsWritten:[] }],
  [0x11, { mnemonic:'MOVI', argType:'REG_IMM4', description:'Rd = imm4',                     flagsWritten:[] }],

  [0x20, { mnemonic:'ADD',  argType:'REG_REG',  description:'Rd += Rs',                      flagsWritten:[] }],
  [0x21, { mnemonic:'ADDI', argType:'REG_IMM4', description:'Rd += imm4',                    flagsWritten:[] }],
  [0x22, { mnemonic:'SUB',  argType:'REG_REG',  description:'Rd -= Rs',                      flagsWritten:[] }],
  [0x23, { mnemonic:'SUBI', argType:'REG_IMM4', description:'Rd -= imm4',                    flagsWritten:[] }],

  [0x30, { mnemonic:'AND',  argType:'REG_REG',  description:'Rd &= Rs',                      flagsWritten:[] }],
  [0x31, { mnemonic:'OR',   argType:'REG_REG',  description:'Rd |= Rs',                      flagsWritten:[] }],
  [0x32, { mnemonic:'XOR',  argType:'REG_REG',  description:'Rd ^= Rs',                      flagsWritten:[] }],
  [0x33, { mnemonic:'NOT',  argType:'REG_ONLY', description:'Rd = ~Rd',                      flagsWritten:[] }],
  [0x40, { mnemonic:'CMP',  argType:'REG_REG',  description:'Set FLAGS from Ra - Rb',        flagsWritten:['Z','N','G'] }],
  [0x41, { mnemonic:'INC',  argType:'REG_ONLY', description:'Rd++',                          flagsWritten:[] }],
  [0x42, { mnemonic:'DEC',  argType:'REG_ONLY', description:'Rd--',                          flagsWritten:[] }],

  [0x50, { mnemonic:'JMP',  argType:'ADDR8',    description:'Unconditional jump',            flagsWritten:[] }],
  [0x51, { mnemonic:'JZ',   argType:'ADDR8',    description:'Jump if Z=1',                   flagsWritten:[] }],
  [0x52, { mnemonic:'JNZ',  argType:'ADDR8',    description:'Jump if Z=0',                   flagsWritten:[] }],
  [0x53, { mnemonic:'JG',   argType:'ADDR8',    description:'Jump if G=1',                   flagsWritten:[] }],
  [0x54, { mnemonic:'JL',   argType:'ADDR8',    description:'Jump if N=1',                   flagsWritten:[] }],
  [0x55, { mnemonic:'JGE',  argType:'ADDR8',    description:'Jump if N=0',                   flagsWritten:[] }],
  [0x56, { mnemonic:'JLE',  argType:'ADDR8',    description:'Jump if G=0',                   flagsWritten:[] }],

  [0x60, { mnemonic:'PUSH', argType:'REG_ONLY', description:'MEM[SP]=Rs; SP--',              flagsWritten:[] }],
  [0x61, { mnemonic:'POP',  argType:'REG_ONLY', description:'SP++; Rd=MEM[SP]',              flagsWritten:[] }],
  [0x70, { mnemonic:'CALL', argType:'ADDR8',    description:'PUSH(PC+2); JMP addr',          flagsWritten:[] }],
  [0x71, { mnemonic:'RET',  argType:'NONE',     description:'POP(PC)',                        flagsWritten:[] }],

  [0x80, { mnemonic:'LD',   argType:'REG_REG',  description:'Rd = MEM[Rs]',                  flagsWritten:[] }],
  [0x81, { mnemonic:'ST',   argType:'REG_REG',  description:'MEM[Rd] = Rs  (Rd=addr reg)',   flagsWritten:[] }],
]);

// ═══════════════════════════════════════════════════════════════════════════════
// § 7. Instruction Decoder
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Decode one instruction to human-readable mnemonic.
 * If CTS is provided and symbolTable has an entry for a target address,
 * the symbol name is appended.
 */
export function decode(op: u8, arg: u8, cts?: Partial<CTS>): string {
  const d = (arg >> 4) & 0xF;
  const s = arg & 0xF;
  const A = `0x${hex2(arg)}`;
  const sym = (addr: u8): string => {
    const entry = cts?.symbolTable?.get(addr);
    return entry ? `${A}<${entry.name}>` : A;
  };

  switch (op) {
    case 0x00: return 'NOP';
    case 0x01: return 'HALT';
    case 0x10: return `MOV ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
    case 0x11: return `MOVI ${REG_NAMES[d]}, #${s}`;
    case 0x20: return `ADD ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
    case 0x21: return `ADDI ${REG_NAMES[d]}, #${s}`;
    case 0x22: return `SUB ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
    case 0x23: return `SUBI ${REG_NAMES[d]}, #${s}`;
    case 0x30: return `AND ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
    case 0x31: return `OR ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
    case 0x32: return `XOR ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
    case 0x33: return `NOT ${REG_NAMES[d]}`;
    case 0x40: return `CMP ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
    case 0x41: return `INC ${REG_NAMES[d]}`;
    case 0x42: return `DEC ${REG_NAMES[d]}`;
    case 0x50: return `JMP ${sym(arg)}`;
    case 0x51: return `JZ  ${sym(arg)}`;
    case 0x52: return `JNZ ${sym(arg)}`;
    case 0x53: return `JG  ${sym(arg)}`;
    case 0x54: return `JL  ${sym(arg)}`;
    case 0x55: return `JGE ${sym(arg)}`;
    case 0x56: return `JLE ${sym(arg)}`;
    case 0x60: return `PUSH ${REG_NAMES[d]}`;
    case 0x61: return `POP  ${REG_NAMES[d]}`;
    case 0x70: return `CALL ${sym(arg)}`;
    case 0x71: return `RET`;
    case 0x80: return `LD ${REG_NAMES[d]}, [${REG_NAMES[s]}]`;
    case 0x81: return `ST [${REG_NAMES[d]}], ${REG_NAMES[s]}`;
    default:   return `??? ${hex2(op)}:${hex2(arg)}`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 8. Functional Core — pure, immutable VM steps
// ═══════════════════════════════════════════════════════════════════════════════

const LOG_MAX = 64;

/**
 * Create a fresh VMState from a ProgramDefinition.
 * No side effects; returns a new state object every call.
 */
export function makeVMState(program: ProgramDefinition): VMState {
  const memory = new Uint8Array(256);
  program.code.forEach((b, i) => { memory[i] = b; });
  Object.entries(program.initMem).forEach(([k, v]) => {
    if (v !== undefined) memory[parseInt(k)] = v;
  });
  return {
    memory,
    regs:    new Uint8Array(8),
    pc:      0,
    sp:      0xFF,
    flags:   { z: false, neg: false, gt: false },
    halted:  false,
    ticks:   0,
    log:     [],
    changed: new Set(),
  };
}

/**
 * Execute one instruction.
 * Pure function: does not mutate input state.
 * Returns a new VMState with all arrays freshly allocated.
 */
export function stepOnce(state: VMState, cts?: Partial<CTS>): VMState {
  if (state.halted) return state;

  const mem   = new Uint8Array(state.memory);
  const regs  = new Uint8Array(state.regs);
  const fl    = { ...state.flags };
  const chg   = new Set<u8>();
  let { pc, sp } = state;
  let halted = false;

  const op  = mem[pc];
  const arg = mem[(pc + 1) & 0xFF];
  const d   = (arg >> 4) & 0xF;
  const sv  = arg & 0xF;
  const decoded = decode(op, arg, cts);
  const lastPc  = pc;
  pc = (pc + 2) & 0xFF;

  switch (op) {
    case 0x00: break;
    case 0x01: halted = true; break;

    case 0x10: regs[d] = regs[sv]; break;
    case 0x11: regs[d] = sv; break;

    case 0x20: regs[d] = (regs[d] + regs[sv]) & 0xFF; break;
    case 0x21: regs[d] = (regs[d] + sv)        & 0xFF; break;
    case 0x22: regs[d] = (regs[d] - regs[sv] + 256) & 0xFF; break;
    case 0x23: regs[d] = (regs[d] - sv + 256)       & 0xFF; break;

    case 0x30: regs[d] = (regs[d] & regs[sv]) & 0xFF; break;
    case 0x31: regs[d] = (regs[d] | regs[sv]) & 0xFF; break;
    case 0x32: regs[d] = (regs[d] ^ regs[sv]) & 0xFF; break;
    case 0x33: regs[d] = (~regs[d])            & 0xFF; break;

    case 0x40: {
      const a = regs[d], b = regs[sv];
      fl.z = a === b; fl.neg = a < b; fl.gt = a > b;
      break;
    }
    case 0x41: regs[d] = (regs[d] + 1) & 0xFF; break;
    case 0x42: regs[d] = (regs[d] - 1 + 256) & 0xFF; break;

    case 0x50: pc = arg; break;
    case 0x51: if (fl.z)   pc = arg; break;
    case 0x52: if (!fl.z)  pc = arg; break;
    case 0x53: if (fl.gt)  pc = arg; break;
    case 0x54: if (fl.neg) pc = arg; break;
    case 0x55: if (!fl.neg) pc = arg; break;
    case 0x56: if (!fl.gt) pc = arg; break;

    case 0x60:
      mem[sp] = regs[d]; chg.add(sp);
      sp = (sp - 1 + 256) & 0xFF;
      break;
    case 0x61:
      sp = (sp + 1) & 0xFF;
      regs[d] = mem[sp];
      break;
    case 0x70:
      mem[sp] = pc & 0xFF; chg.add(sp);
      sp = (sp - 1 + 256) & 0xFF;
      pc = arg;
      break;
    case 0x71:
      sp = (sp + 1) & 0xFF;
      pc = mem[sp];
      break;

    case 0x80: regs[d] = mem[regs[sv]]; break;
    case 0x81: {
      const addr = regs[d];
      mem[addr] = regs[sv];
      chg.add(addr);
      break;
    }
  }

  const entry: LogEntry = { pc: lastPc, decoded, ticks: state.ticks + 1 };
  const log = [entry, ...(state.log.slice(0, LOG_MAX - 1))];

  return { memory: mem, regs, pc, sp, flags: fl, halted, ticks: state.ticks + 1, log, changed: chg };
}

/**
 * Execute N instructions in a single call.
 * Accumulates all changed addresses across all steps.
 * Stops early if VM halts.
 */
export function stepN(state: VMState, n: number, cts?: Partial<CTS>): VMState {
  let cur = state;
  const allChanged = new Set<u8>();
  for (let i = 0; i < n; i++) {
    if (cur.halted) break;
    cur = stepOnce(cur, cts);
    cur.changed.forEach(a => allChanged.add(a));
  }
  return { ...cur, changed: allChanged };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 9. Static Analysis — CrossRef Table Builder
// Scans machine code and infers computation graph without running the VM.
// ═══════════════════════════════════════════════════════════════════════════════

const JUMP_OPS  = new Set([0x50,0x51,0x52,0x53,0x54,0x55,0x56,0x70]);
const LOAD_OPS  = new Set([0x80]);
const STORE_OPS = new Set([0x81]);

/**
 * Statically scan code and build CrossRefTable entries.
 * For jumps: target address gets a `callers` entry pointing to the jump instruction.
 * For LD/ST: if the address register is known at scan time (register set to a literal
 * value immediately before), the target address gets dataReader/dataWriter entries.
 *
 * Note: register-indirect addresses (LD Rd, [Rs]) cannot always be resolved statically;
 * those entries are left empty and should be populated by dynamic analysis during `run()`.
 */
export function buildCrossRef(code: u8[]): Map<u8, CrossRefEntry> {
  const xref = new Map<u8, CrossRefEntry>();
  const ensure = (addr: u8): CrossRefEntry => {
    if (!xref.has(addr)) xref.set(addr, { callers: [], dataReaders: [], dataWriters: [] });
    return xref.get(addr)!;
  };

  // Simple single-pass register tracking: record last MOVI/MOV value per register
  const regHint = new Map<number, u8>();

  for (let i = 0; i + 1 < code.length; i += 2) {
    const op  = code[i];
    const arg = code[i + 1];
    const d   = (arg >> 4) & 0xF;
    const sv  = arg & 0xF;
    const instrAddr = i as u8;

    // Track MOVI: register d receives literal sv
    if (op === 0x11) { regHint.set(d, sv); }
    // MOV copies register
    else if (op === 0x10 && regHint.has(sv)) { regHint.set(d, regHint.get(sv)!); }
    // INC: increment tracked register
    else if (op === 0x41 && regHint.has(d)) { regHint.set(d, (regHint.get(d)! + 1) & 0xFF); }
    // ADDI: add immediate
    else if (op === 0x21 && regHint.has(d)) { regHint.set(d, (regHint.get(d)! + sv) & 0xFF); }
    // Other ALU ops invalidate destination register hint
    else if ([0x20,0x22,0x23,0x30,0x31,0x32,0x33,0x42].includes(op)) { regHint.delete(d); }

    // Jump instructions → target address gets a caller entry
    if (JUMP_OPS.has(op)) {
      const target = arg as u8;
      ensure(target).callers.push(instrAddr);
    }

    // LD Rd, [Rs] → if Rs value is known, annotate data address
    if (LOAD_OPS.has(op) && regHint.has(sv)) {
      const dataAddr = regHint.get(sv)!;
      ensure(dataAddr).dataReaders.push(instrAddr);
    }

    // ST [Rd], Rs → if Rd value is known, annotate data address
    if (STORE_OPS.has(op) && regHint.has(d)) {
      const dataAddr = regHint.get(d)!;
      ensure(dataAddr).dataWriters.push(instrAddr);
    }
  }

  return xref;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 10. VMController — Imperative Shell (stateful, event-driven)
// ═══════════════════════════════════════════════════════════════════════════════

type StateListener    = (state: VMState) => void;
type AddressListener  = (val: u8, addr: u8, state: VMState) => void;

export class VMController {
  private state:   VMState;
  private program: ProgramDefinition;
  private cts:     Partial<CTS>;
  private id:      string;

  private stateListeners:   Set<StateListener>              = new Set();
  private addressListeners: Map<u8, Set<AddressListener>>   = new Map();
  private prevMemory:       Uint8Array;

  constructor(program: ProgramDefinition, id?: string) {
    this.program     = program;
    this.cts         = program.cts ?? {};
    this.id          = id ?? program.id;
    this.state       = makeVMState(program);
    this.prevMemory  = new Uint8Array(this.state.memory);
  }

  // ── State Access ────────────────────────────────────────────────────────────

  getState(): VMState { return this.state; }

  // ── Mutation ────────────────────────────────────────────────────────────────

  load(program: ProgramDefinition): void {
    this.program    = program;
    this.cts        = program.cts ?? {};
    this.state      = makeVMState(program);
    this.prevMemory = new Uint8Array(this.state.memory);
    this._notify();
  }

  reset(): void {
    this.state      = makeVMState(this.program);
    this.prevMemory = new Uint8Array(this.state.memory);
    this._notify();
  }

  step(): VMState {
    if (this.state.halted) return this.state;
    this.prevMemory = new Uint8Array(this.state.memory);
    this.state      = stepOnce(this.state, this.cts);
    this._notify();
    return this.state;
  }

  stepN(n: number): VMState {
    if (this.state.halted) return this.state;
    this.prevMemory = new Uint8Array(this.state.memory);
    this.state      = stepN(this.state, n, this.cts);
    this._notify();
    return this.state;
  }

  /**
   * Run until HALT or maxSteps exceeded.
   * Non-blocking: resolves a Promise with the final VMResult.
   * Uses setTimeout batching to yield to the event loop every `batchSize` steps.
   */
  run(maxSteps = 1_000_000, batchSize = 500): Promise<VMResult> {
    const before     = new Uint8Array(this.state.memory);
    const trace:      LogEntry[] = [];
    let   totalSteps = 0;

    return new Promise((resolve) => {
      const tick = () => {
        let stepsThisBatch = 0;
        while (!this.state.halted && totalSteps < maxSteps && stepsThisBatch < batchSize) {
          this.prevMemory = new Uint8Array(this.state.memory);
          this.state      = stepOnce(this.state, this.cts);
          if (this.state.log[0]) trace.push(this.state.log[0]);
          this._notify();
          totalSteps++;
          stepsThisBatch++;
        }

        if (this.state.halted || totalSteps >= maxSteps) {
          const diff = new Map<u8, { before: u8; after: u8 }>();
          for (let a = 0; a < 256; a++) {
            if (before[a] !== this.state.memory[a]) {
              diff.set(a as u8, { before: before[a], after: this.state.memory[a] });
            }
          }
          resolve({ finalState: this.state, memoryDiff: diff, steps: totalSteps, trace });
        } else {
          setTimeout(tick, 0);
        }
      };
      setTimeout(tick, 0);
    });
  }

  halt(): void {
    // Mark the current state as halted without executing a HALT instruction.
    this.state = { ...this.state, halted: true };
    this._notify();
  }

  // ── Observation ─────────────────────────────────────────────────────────────

  /**
   * Subscribe to all state changes.
   * Returns an unsubscribe function.
   */
  subscribe(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => { this.stateListeners.delete(listener); };
  }

  /**
   * Subscribe to writes at a specific memory address.
   * Callback fires whenever MEM[addr] changes value.
   */
  subscribeAddr(addr: u8, listener: AddressListener): () => void {
    if (!this.addressListeners.has(addr)) this.addressListeners.set(addr, new Set());
    this.addressListeners.get(addr)!.add(listener);
    return () => { this.addressListeners.get(addr)?.delete(listener); };
  }

  // ── AI Interface ─────────────────────────────────────────────────────────────

  /**
   * Produce an AI-readable snapshot of the current VM state.
   * Format defined in EML-EAI-2026 § 5.4.
   */
  toJSON(): VMSnapshot {
    const s    = this.state;
    const sym  = this.cts.symbolTable;
    const cmt  = this.cts.commentTable;
    const pcH  = `0x${hex2(s.pc)}`;
    const op   = s.memory[s.pc];
    const arg  = s.memory[(s.pc + 1) & 0xFF];

    const changed = Array.from(s.changed).map(addr => ({
      addr:   `0x${hex2(addr)}`,
      symbol: sym?.get(addr)?.name ?? null,
      before: this.prevMemory[addr],
      after:  s.memory[addr],
    }));

    const registers: Record<string, number> = {};
    REG_NAMES.forEach((n, i) => { registers[n] = s.regs[i]; });

    return {
      vm_id:             this.id,
      tick:              s.ticks,
      pc:                pcH,
      pc_symbol:         sym?.get(s.pc)?.name ?? null,
      pc_comment:        cmt?.get(s.pc) ?? null,
      instruction:       decode(op, arg, this.cts),
      registers,
      flags:             { Z: s.flags.z, N: s.flags.neg, G: s.flags.gt },
      changed_this_tick: changed,
      stack_depth:       (0xFF - s.sp) & 0xFF,
      halted:            s.halted,
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private _notify(): void {
    this.stateListeners.forEach(fn => fn(this.state));
    this.state.changed.forEach(addr => {
      this.addressListeners.get(addr)?.forEach(fn =>
        fn(this.state.memory[addr], addr, this.state)
      );
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 11. Built-in Programs (with partial CTS)
// ═══════════════════════════════════════════════════════════════════════════════

export const PROGRAM_FIBONACCI: ProgramDefinition = {
  id:    'fibonacci',
  label: 'FIBONACCI',
  description: 'Compute fib(0–10) and write to RAM[0x2E..0x38]. Output: 0,1,1,2,3,5,8,13,21,34,55.',
  code: [
    // prologue: R0=0(fib[n-2]), R1=1(fib[n-1]), R3=0, R4=10(max index)
    0x11,0x00, 0x11,0x11, 0x11,0x30, 0x11,0x4A,
    // build write ptr R5 = 0x2E (just past 46-byte code → no code/data overlap):
    //   MOVI 15 → INC 16 → ADDI 15 = 31 → ADDI 15 = 46 (0x2E)
    0x11,0x5F, 0x41,0x50, 0x21,0x5F, 0x21,0x5F,
    // store fib[0]=0 @0x2E, fib[1]=1 @0x2F, advance ptr
    0x81,0x50, 0x41,0x50, 0x81,0x51, 0x41,0x50,
    0x11,0x32,                                    // R3 = 2 (counter)
    // LOOP @ 0x1A: R2 = R0+R1; shift R0←R1←R2
    0x10,0x20, 0x20,0x21, 0x10,0x01, 0x10,0x12,
    0x81,0x52, 0x41,0x50, 0x41,0x30,             // store R2; advance ptr; counter++
    // CMP R3,R4; JLE→LOOP (inclusive → stores through fib(10)); else restart
    0x40,0x34, 0x56,0x1A, 0x50,0x00,
  ],
  initMem: {},
  cts: {
    symbolTable: new Map([
      [0x00, { name:'INIT',       region:'code', type:'label', size:2 }],
      [0x1A, { name:'LOOP',       region:'code', type:'label', size:2 }],
      [0x2E, { name:'fib_data',   region:'data', type:'u8',    size:11 }],
    ]),
    commentTable: new Map([
      [0x00, 'R0=0(fib[n-2]), R1=1(fib[n-1])'],
      [0x06, 'R4=10(max index)'],
      [0x08, 'Build write ptr R5=0x2E (past code; 0x20 would overlap code)'],
      [0x10, 'Store fib[0]=0, fib[1]=1'],
      [0x1A, 'LOOP: R2 = R0+R1; shift R0←R1←R2; store'],
      [0x28, 'CMP counter vs max(10); JLE→LOOP (inclusive); restart'],
    ]),
    typeTable: [
      { start:0x00, end:0x2D, kind:'code',    colorHint:'#003300' },
      { start:0x2E, end:0x38, kind:'data',    colorHint:'#002233' },
      { start:0xE0, end:0xFF, kind:'stack',   colorHint:'#220000' },
    ],
  },
};

export const PROGRAM_COUNTER: ProgramDefinition = {
  id:    'counter',
  label: 'COUNTER',
  description: 'Count 0→15 in a cycle, written sequentially to RAM[0x14..0x23].',
  code: [
    // R0=counter(0); R1=ptr=0x14 (15+5, past code); R2=max(15)
    0x11,0x00, 0x11,0x1F, 0x21,0x15, 0x11,0x2F,
    // LOOP @ 0x08: store counter, advance both
    0x81,0x10, 0x41,0x00, 0x41,0x10,
    0x40,0x02, 0x53,0x00, 0x50,0x08,             // CMP R0,max; JG→restart; else loop
  ],
  initMem: {},
  cts: {
    symbolTable: new Map([
      [0x00, { name:'INIT',       region:'code', type:'label', size:2 }],
      [0x08, { name:'LOOP',       region:'code', type:'label', size:2 }],
      [0x14, { name:'count_buf',  region:'data', type:'u8',    size:16 }],
    ]),
    commentTable: new Map([
      [0x00, 'R0=counter(0), R1=ptr(→0x14, past code), R2=max(15)'],
      [0x08, 'LOOP: write, inc both, compare, branch'],
    ]),
    typeTable: [
      { start:0x00, end:0x13, kind:'code', colorHint:'#003300' },
      { start:0x14, end:0x23, kind:'data', colorHint:'#002233' },
      { start:0xE0, end:0xFF, kind:'stack', colorHint:'#220000' },
    ],
  },
};

export const PROGRAM_XOR_CIPHER: ProgramDefinition = {
  id:    'xor-cipher',
  label: 'XOR CIPHER',
  description: 'XOR encrypt/decrypt RAM[0x40..0x4F] with key=0x0A. Alternates enc↔dec on loop restart.',
  code: [
    0x11,0x0A,
    0x11,0x1F, 0x41,0x10,
    0x21,0x1F, 0x41,0x10,
    0x21,0x1F, 0x41,0x10,
    0x21,0x1F, 0x41,0x10,
    0x11,0x30, 0x11,0x4F,
    0x80,0x21, 0x32,0x20, 0x81,0x12,
    0x41,0x10, 0x41,0x30,
    0x40,0x34, 0x56,0x16, 0x50,0x00,
  ],
  initMem: {
    0x40:0xDE, 0x41:0xAD, 0x42:0xBE, 0x43:0xEF,
    0x44:0xCA, 0x45:0xFE, 0x46:0xBA, 0x47:0xBE,
    0x48:0x13, 0x49:0x37, 0x4A:0xAA, 0x4B:0x55,
    0x4C:0x0F, 0x4D:0xF0, 0x4E:0x69, 0x4F:0x42,
  },
  cts: {
    symbolTable: new Map([
      [0x00, { name:'INIT',        region:'code',   type:'label', size:2  }],
      [0x16, { name:'LOOP',        region:'code',   type:'label', size:2  }],
      [0x40, { name:'cipher_buf',  region:'data',   type:'u8',    size:16 }],
    ]),
    commentTable: new Map([
      [0x00, 'R0=key(0x0A)'],
      [0x02, 'Build R1=64(0x40): 15→16→31→32→47→48→63→64'],
      [0x12, 'R3=ctr(0), R4=max(15)'],
      [0x16, 'LOOP: LD→XOR→ST; inc ptr and ctr; JLE→LOOP; restart'],
    ]),
    typeTable: [
      { start:0x00, end:0x26, kind:'code',   colorHint:'#003300' },
      { start:0x40, end:0x50, kind:'data',   colorHint:'#002233' },
      { start:0xE0, end:0xFF, kind:'stack',  colorHint:'#220000' },
    ],
  },
};

export const BUILTIN_PROGRAMS: ProgramDefinition[] = [
  PROGRAM_FIBONACCI,
  PROGRAM_COUNTER,
  PROGRAM_XOR_CIPHER,
];

// ═══════════════════════════════════════════════════════════════════════════════
// § 12. CTS Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/** Build an empty CTS scaffold — all tables initialized, ready to populate. */
export function emptyCTS(): CTS {
  return {
    opcodeTable:   new Map(OPCODE_TABLE),
    symbolTable:   new Map(),
    typeTable:     [],
    stringTable:   new Map(),
    commentTable:  new Map(),
    crossRefTable: new Map(),
  };
}

/** Merge a program's partial CTS with the full opcodeTable. */
export function resolveCTS(program: ProgramDefinition): CTS {
  return {
    opcodeTable:   OPCODE_TABLE,
    symbolTable:   program.cts.symbolTable  ?? new Map(),
    typeTable:     program.cts.typeTable    ?? [],
    stringTable:   program.cts.stringTable  ?? new Map(),
    commentTable:  program.cts.commentTable ?? new Map(),
    crossRefTable: program.cts.crossRefTable
      ?? buildCrossRef(program.code),
  };
}

/** One effective memory access (resolved at runtime) attributable to a tick. */
export interface MemAccess {
  kind: 'read' | 'write';
  addr: u8;
}

/**
 * Resolve the effective data-memory access an instruction performs, given the
 * VM state *before* it executes (so register-indirect operands carry their
 * runtime value). Returns `null` for instructions that touch no data memory.
 *
 * This is the read-side counterpart to memory diffing: a `LD Rd,[Rs]` leaves no
 * memory delta, so it is invisible to `augmentCTSFromTrace`'s diff pass — but its
 * source address is `regs[Rs]` at this tick and is captured here.
 */
export function effectiveAccess(s: VMState): MemAccess | null {
  const op  = s.memory[s.pc];
  const arg = s.memory[(s.pc + 1) & 0xFF];
  const d   = (arg >> 4) & 0xF;
  const sv  = arg & 0xF;
  switch (op) {
    case 0x80: return { kind: 'read',  addr: s.regs[sv] };          // LD Rd,[Rs]
    case 0x81: return { kind: 'write', addr: s.regs[d] };           // ST [Rd],Rs
    case 0x60: return { kind: 'write', addr: s.sp };                // PUSH → MEM[SP]
    case 0x70: return { kind: 'write', addr: s.sp };                // CALL → push PC
    case 0x61: return { kind: 'read',  addr: (s.sp + 1) & 0xFF };   // POP  → MEM[SP+1]
    case 0x71: return { kind: 'read',  addr: (s.sp + 1) & 0xFF };   // RET  → pop PC
    default:   return null;
  }
}

/**
 * Augment a CTS with dynamically-observed data readers and writers.
 *
 * `buildCrossRef()` resolves accesses statically only when the address register
 * was set by a nearby literal (MOVI/MOV/INC/ADDI). Register-indirect accesses —
 * `ST [Rd], Rs` / `LD Rd, [Rs]` where the address register was loaded from memory
 * at runtime — are invisible to static analysis. This pass recovers them two ways:
 *
 *  1. **Writers** (always): every address whose byte changed during tick i is
 *     attributed as a `dataWriter` at `trace[i]`'s instruction address. This is
 *     general — it also captures PUSH/CALL stack writes.
 *  2. **Readers** (when `accesses` is supplied): a `LD` leaves no memory delta, so
 *     reads cannot be diffed. When the per-tick effective-access stream from
 *     `traceWithSnapshots()` is passed, each read address is attributed as a
 *     `dataReader` (and each write corroborates a `dataWriter`).
 *
 * Contract: `memSnapshots[i]` is the memory state *before* `trace[i]` executes,
 * and `memSnapshots[trace.length]` is the final memory (length = trace.length+1);
 * `accesses[i]` (if given) is the access `trace[i]` performed. Misaligned inputs
 * are tolerated — only the overlapping prefix is scanned. Pure: returns a new CTS.
 */
export function augmentCTSFromTrace(
  cts: CTS,
  trace: LogEntry[],
  memSnapshots: Uint8Array[],
  accesses?: Array<MemAccess | null>,
): CTS {
  // Deep-copy the crossRef entries so the input CTS is untouched.
  const xref = new Map<u8, CrossRefEntry>();
  cts.crossRefTable.forEach((e, k) => {
    xref.set(k, { callers: [...e.callers], dataReaders: [...e.dataReaders], dataWriters: [...e.dataWriters] });
  });
  const ensure = (addr: u8): CrossRefEntry => {
    if (!xref.has(addr)) xref.set(addr, { callers: [], dataReaders: [], dataWriters: [] });
    return xref.get(addr)!;
  };

  // (1) Writers via memory diff — general, catches register-indirect stores.
  const n = Math.min(trace.length, memSnapshots.length - 1);
  for (let i = 0; i < n; i++) {
    const before = memSnapshots[i];
    const after  = memSnapshots[i + 1];
    if (!before || !after) continue;
    const instrAddr = trace[i].pc as u8;
    const len = Math.min(before.length, after.length);
    for (let a = 0; a < len; a++) {
      if (before[a] !== after[a]) {
        const e = ensure(a as u8);
        if (!e.dataWriters.includes(instrAddr)) e.dataWriters.push(instrAddr);
      }
    }
  }

  // (2) Readers (and corroborating writers) via the effective-access stream.
  if (accesses) {
    const m = Math.min(trace.length, accesses.length);
    for (let i = 0; i < m; i++) {
      const acc = accesses[i];
      if (!acc) continue;
      const instrAddr = trace[i].pc as u8;
      const e = ensure(acc.addr);
      const bucket = acc.kind === 'read' ? e.dataReaders : e.dataWriters;
      if (!bucket.includes(instrAddr)) bucket.push(instrAddr);
    }
  }

  return { ...cts, crossRefTable: xref };
}

/**
 * Run a program for up to `maxSteps`, capturing the per-tick execution trace, a
 * parallel sequence of memory snapshots, and the per-tick effective-access stream
 * — all suitable for `augmentCTSFromTrace()`. `memSnapshots[0]` is the initial
 * memory; `memSnapshots[i+1]` is the state after `trace[i]`; `accesses[i]` is the
 * data-memory access (read/write/none) that `trace[i]` performed.
 */
export function traceWithSnapshots(
  program: ProgramDefinition,
  maxSteps = 10_000,
): { trace: LogEntry[]; memSnapshots: Uint8Array[]; accesses: Array<MemAccess | null> } {
  const cts = program.cts ?? {};
  let s = makeVMState(program);
  const trace: LogEntry[] = [];
  const accesses: Array<MemAccess | null> = [];
  const memSnapshots: Uint8Array[] = [new Uint8Array(s.memory)];
  for (let i = 0; i < maxSteps && !s.halted; i++) {
    const acc = effectiveAccess(s);   // resolve from pre-step state (runtime operands)
    s = stepOnce(s, cts);
    if (s.log[0]) { trace.push(s.log[0]); accesses.push(acc); }
    memSnapshots.push(new Uint8Array(s.memory));
  }
  return { trace, memSnapshots, accesses };
}

/**
 * Build CTS Layer 4 (stringTable) by decoding printable-ASCII runs in memory.
 *
 * A maximal run of printable bytes (0x20–0x7E) of length >= `minLen`, bounded by
 * a non-printable byte or the scan window edge, becomes one entry keyed at the
 * run's start address. Completes the Layer 4 fill logic left open in §6.4 #4.
 */
export function buildStringTable(
  mem: Uint8Array,
  start: u8 = 0x00,
  end: u8 = 0xFF,
  minLen = 3,
): Map<u8, string> {
  const table = new Map<u8, string>();
  let runStart = -1;
  let chars: string[] = [];
  const flush = (): void => {
    if (runStart >= 0 && chars.length >= minLen) table.set(runStart as u8, chars.join(''));
    runStart = -1;
    chars = [];
  };
  for (let a = start; a <= end; a++) {
    const b = mem[a];
    const printable = b >= 0x20 && b <= 0x7E;
    if (printable) {
      if (runStart < 0) runStart = a;
      chars.push(String.fromCharCode(b));
    } else {
      flush();
    }
  }
  flush();
  return table;
}

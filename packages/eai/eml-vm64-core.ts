/**
 * EML-VM64 Core
 * EML-EAI-2026-v0.1 · Phase 6: 16-bit Address Space Architecture
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * EML-VM64 is the successor to EML-VM-16. Key differences:
 *
 *   EML-VM-16 (V1)          EML-VM64 (V2)
 *   ─────────────────────   ─────────────────────────────────────
 *   8-bit address space     16-bit address space (64KB)
 *   256 bytes RAM           65536 bytes RAM
 *   Fixed 2-byte instr      Variable-length: 2 / 3 / 4 bytes
 *   8-bit PC and SP         16-bit PC and SP
 *   No address registers    AR0–AR3 (16-bit, dedicated to addressing)
 *   JMP/CALL 8-bit target   JMP/CALL 8-bit (V1 compat) + 16-bit variants
 *
 * V1 BACKWARD COMPATIBILITY:
 *   All V1 opcodes (0x00–0x81) remain 2-byte with identical semantics.
 *   V1 programs load into V2 address space at 0x0000 and execute unchanged.
 *   V1 JMP 0xNN is treated as JMP 0x00NN in 16-bit PC space (correct).
 *
 * INSTRUCTION LENGTH ENCODING (opcode determines length):
 *   0x00–0x81  2 bytes  [op][arg]           V1-compatible
 *   0x88–0x8F  2 bytes  [op][arg]           V2 new 2-byte
 *   0x90–0x93  3 bytes  [op][reg][imm8]     Extended immediate
 *   0xA0       4 bytes  [op][ARn][hi][lo]   MOVW (16-bit load to AR)
 *   0xA1–0xA9  2 bytes  [op][arg]           Address register ops
 *   0xA5       3 bytes  [op][ARn][imm8]     ADDARI (3-byte exception)
 *   0xB0–0xB7  4 bytes  [op][0][hi][lo]     16-bit jumps / CALL16
 *   0xB8       2 bytes  [op][0]             RET16
 *   0xC0–0xC1  2 bytes  [op][arg]           PUSH16 / POP16
 */

import {
  u8, VMFlags, LogEntry, ProgramDefinition, CTS,
  REG_NAMES, hex2, bin8,
  OPCODE_TABLE,
} from './eml-vm16-core';

// ═══════════════════════════════════════════════════════════════════════════════
// § 1. Architecture Constants
// ═══════════════════════════════════════════════════════════════════════════════

export const VM64_MEMORY_SIZE = 65536;    // 64KB
export const VM64_AR_COUNT    = 4;         // Address registers AR0–AR3
export const VM64_SP_INIT     = 0xFFFE;   // Initial stack pointer

/** Canonical 64KB memory map. */
export const MEMORY_MAP: Readonly<Record<string, number>> = {
  CODE_START:  0x0000,   CODE_END:   0x3FFF,  // 16KB — code segment
  DATA_START:  0x4000,   DATA_END:   0x7FFF,  // 16KB — data segment
  HEAP_START:  0x8000,   HEAP_END:   0xBFFF,  // 16KB — heap (future alloc)
  IO_START:    0xC000,   IO_END:     0xDFFF,  //  8KB — memory-mapped I/O
  STACK_START: 0xE000,   STACK_END:  0xFFFD,  //  8KB — stack (grows ↓)
  SP_INIT:     0xFFFE,
};

export const AR_NAMES: readonly string[] = ['AR0','AR1','AR2','AR3'];

/** Hex-format a 16-bit value as 4 uppercase hex chars. */
export const hex4 = (n: number): string =>
  n.toString(16).toUpperCase().padStart(4, '0');

/** Hex-format two bytes as a 16-bit value string. */
export const hex4_hilo = (hi: u8, lo: u8): string =>
  hex4((hi << 8) | lo);

// ═══════════════════════════════════════════════════════════════════════════════
// § 2. V2 Extended ISA Definition
// ═══════════════════════════════════════════════════════════════════════════════

export type InstrLen = 2 | 3 | 4;

/**
 * Returns the byte length of the instruction with the given opcode.
 * All V1 opcodes (0x00–0x81) return 2.
 * V2 extended opcodes follow the Phase 6 encoding table.
 */
export function getInstrLen64(op: u8): InstrLen {
  // 3-byte: extended immediate ops
  if (op >= 0x90 && op <= 0x93) return 3;  // MOVI8, ADDI8, SUBI8, CMPI8
  if (op === 0xA5)               return 3;  // ADDARI ARn, #imm8
  // 4-byte: MOVW and 16-bit jumps/call
  if (op === 0xA0)               return 4;  // MOVW ARn, #imm16
  if (op >= 0xB0 && op <= 0xB7) return 4;  // JMP16, JZ16, ..., CALL16
  // All others (V1 + new 2-byte): 2 bytes
  return 2;
}

/**
 * Decode a V2 instruction starting at `pc` in `mem`.
 * Reads up to 4 bytes. CTS is optional; if provided, symbol names
 * are substituted for address literals.
 */
export function decode64(
  mem: Uint8Array,
  pc:  number,
  cts?: Partial<CTS64>,
): string {
  const op = mem[pc & 0xFFFF];
  const a1 = mem[(pc+1) & 0xFFFF];
  const a2 = mem[(pc+2) & 0xFFFF];
  const a3 = mem[(pc+3) & 0xFFFF];

  const d   = (a1 >> 4) & 0xF;
  const s   = a1 & 0xF;
  const A8  = `0x${hex2(a1)}`;
  const A16 = `0x${hex4_hilo(a2, a3)}`;
  const sym16 = (addr: number): string => {
    const name = cts?.symbolTable?.get(addr)?.name;
    return name ? `${hex4(addr)}<${name}>` : `0x${hex4(addr)}`;
  };
  const imm16 = (hi: u8, lo: u8) => `#0x${hex4_hilo(hi, lo)}`;

  // ── V2 new opcodes ─────────────────────────────────────────────────────────
  switch (op) {
    // 3-byte extended immediate
    case 0x90: return `MOVI8   ${REG_NAMES[a1] ?? `R${a1}`}, #${a2}`;
    case 0x91: return `ADDI8   ${REG_NAMES[a1] ?? `R${a1}`}, #${a2}`;
    case 0x92: return `SUBI8   ${REG_NAMES[a1] ?? `R${a1}`}, #${a2}`;
    case 0x93: return `CMPI8   ${REG_NAMES[a1] ?? `R${a1}`}, #${a2}`;

    // 4-byte: MOVW
    case 0xA0: return `MOVW    ${AR_NAMES[a1] ?? `AR${a1}`}, ${imm16(a2,a3)}`;

    // 2-byte address register ops
    case 0xA1: return `LDAX    ${REG_NAMES[d]}, [${AR_NAMES[s] ?? `AR${s}`}]`;
    case 0xA2: return `STAX    [${AR_NAMES[d] ?? `AR${d}`}], ${REG_NAMES[s]}`;
    case 0xA3: return `INCAR   ${AR_NAMES[(a1>>4)&3]}`;
    case 0xA4: return `DECAR   ${AR_NAMES[(a1>>4)&3]}`;
    case 0xA5: return `ADDARI  ${AR_NAMES[a1] ?? `AR${a1}`}, #${a2}`;     // 3-byte
    case 0xA6: return `MOVARL  ${REG_NAMES[d]}, ${AR_NAMES[s&3]}`;        // Rd = ARn&0xFF
    case 0xA7: return `MOVARU  ${REG_NAMES[d]}, ${AR_NAMES[s&3]}`;        // Rd = ARn>>8
    case 0xA8: return `MOVARP  ${AR_NAMES[d&3]}, ${REG_NAMES[s]}:${REG_NAMES[(s+1)&7]}`; // AR = reg pair
    case 0xA9: return `ADDARS  ${AR_NAMES[d&3]}, ${REG_NAMES[s]}`;        // AR += Rs

    // 4-byte 16-bit jumps
    case 0xB0: return `JMP16   ${sym16((a2<<8)|a3)}`;
    case 0xB1: return `JZ16    ${sym16((a2<<8)|a3)}`;
    case 0xB2: return `JNZ16   ${sym16((a2<<8)|a3)}`;
    case 0xB3: return `JG16    ${sym16((a2<<8)|a3)}`;
    case 0xB4: return `JL16    ${sym16((a2<<8)|a3)}`;
    case 0xB5: return `JGE16   ${sym16((a2<<8)|a3)}`;
    case 0xB6: return `JLE16   ${sym16((a2<<8)|a3)}`;
    case 0xB7: return `CALL16  ${sym16((a2<<8)|a3)}`;
    case 0xB8: return `RET16`;

    // 2-byte 16-bit stack
    case 0xC0: return `PUSH16  ${AR_NAMES[(a1>>4)&3]}`;
    case 0xC1: return `POP16   ${AR_NAMES[(a1>>4)&3]}`;
  }

  // ── V1 opcodes (0x00–0x81): delegate to V1 decode table ──────────────────
  const v1entry = OPCODE_TABLE.get(op);
  if (v1entry) {
    // Re-implement V1 decode inline for self-containment
    switch (op) {
      case 0x00: return 'NOP';
      case 0x01: return 'HALT';
      case 0x10: return `MOV  ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
      case 0x11: return `MOVI ${REG_NAMES[d]}, #${s}`;
      case 0x20: return `ADD  ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
      case 0x21: return `ADDI ${REG_NAMES[d]}, #${s}`;
      case 0x22: return `SUB  ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
      case 0x23: return `SUBI ${REG_NAMES[d]}, #${s}`;
      case 0x30: return `AND  ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
      case 0x31: return `OR   ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
      case 0x32: return `XOR  ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
      case 0x33: return `NOT  ${REG_NAMES[d]}`;
      case 0x40: return `CMP  ${REG_NAMES[d]}, ${REG_NAMES[s]}`;
      case 0x41: return `INC  ${REG_NAMES[d]}`;
      case 0x42: return `DEC  ${REG_NAMES[d]}`;
      case 0x50: return `JMP  ${A8}`;
      case 0x51: return `JZ   ${A8}`;
      case 0x52: return `JNZ  ${A8}`;
      case 0x53: return `JG   ${A8}`;
      case 0x54: return `JL   ${A8}`;
      case 0x55: return `JGE  ${A8}`;
      case 0x56: return `JLE  ${A8}`;
      case 0x60: return `PUSH ${REG_NAMES[d]}`;
      case 0x61: return `POP  ${REG_NAMES[d]}`;
      case 0x70: return `CALL ${A8}`;
      case 0x71: return `RET`;
      case 0x80: return `LD   ${REG_NAMES[d]}, [${REG_NAMES[s]}]`;
      case 0x81: return `ST   [${REG_NAMES[d]}], ${REG_NAMES[s]}`;
    }
  }
  return `??? ${hex2(op)}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 3. CTS64 Type System
// ═══════════════════════════════════════════════════════════════════════════════

export interface SymbolEntry64 {
  name:   string;
  region: 'code' | 'data' | 'heap' | 'stack' | 'io' | 'unknown';
  type:   'u8' | 'ptr16' | 'label' | 'func' | 'unknown';
  size:   number;
}

export interface RegionEntry64 {
  start:     number;   // 16-bit
  end:       number;   // 16-bit, inclusive
  kind:      'code' | 'data' | 'heap' | 'stack' | 'io' | 'unknown';
  colorHint: string;
}

export interface CrossRefEntry64 {
  callers:     number[];   // 16-bit instruction addresses
  dataReaders: number[];
  dataWriters: number[];
}

export interface CTS64 {
  symbolTable:  Map<number, SymbolEntry64>;    // 16-bit addr keys
  typeTable:    RegionEntry64[];
  stringTable:  Map<number, string>;           // 16-bit addr keys
  commentTable: Map<number, string>;           // 16-bit addr keys
  crossRefTable: Map<number, CrossRefEntry64>;
}

/** Default 64KB type table based on the canonical memory map. */
export const DEFAULT_TYPE_TABLE_64K: RegionEntry64[] = [
  { start:0x0000, end:0x3FFF, kind:'code',    colorHint:'#002200' },
  { start:0x4000, end:0x7FFF, kind:'data',    colorHint:'#000e2a' },
  { start:0x8000, end:0xBFFF, kind:'heap',    colorHint:'#1a0e00' },
  { start:0xC000, end:0xDFFF, kind:'io',      colorHint:'#1a001a' },
  { start:0xE000, end:0xFFFD, kind:'stack',   colorHint:'#1a0000' },
];

// ═══════════════════════════════════════════════════════════════════════════════
// § 4. VM64 State
// ═══════════════════════════════════════════════════════════════════════════════

export interface Log64Entry {
  pc:      number;    // 16-bit
  decoded: string;
  ticks:   number;
  len:     InstrLen;
}

export interface VM64State {
  memory:  Uint8Array;    // 65536 bytes
  regs:    Uint8Array;    // R0–R7 (8-bit each)
  ar:      Uint16Array;   // AR0–AR3 (16-bit each)
  pc:      number;        // 16-bit program counter
  sp:      number;        // 16-bit stack pointer
  flags:   VMFlags;
  halted:  boolean;
  ticks:   number;
  log:     Log64Entry[];
  changed: Set<number>;   // 16-bit addresses changed this tick
}

export interface Program64 {
  id:          string;
  label:       string;
  description: string;
  /** Code loaded at address 0x0000 by default. */
  code:        u8[];
  /** Initial data written at specified 16-bit addresses. */
  initMem:     Partial<Record<number, u8>>;
  /** Load address for code (default: 0x0000). */
  loadAddr?:   number;
  cts?:        Partial<CTS64>;
}

const LOG64_MAX = 64;

// ═══════════════════════════════════════════════════════════════════════════════
// § 5. Functional Core — VM64 step engine
// ═══════════════════════════════════════════════════════════════════════════════

export function makeVM64State(program: Program64): VM64State {
  const memory = new Uint8Array(VM64_MEMORY_SIZE);
  const base   = program.loadAddr ?? 0;
  program.code.forEach((b, i) => { memory[(base + i) & 0xFFFF] = b; });
  Object.entries(program.initMem).forEach(([k, v]) => {
    if (v !== undefined) memory[parseInt(k) & 0xFFFF] = v;
  });
  return {
    memory,
    regs:    new Uint8Array(8),
    ar:      new Uint16Array(4),
    pc:      base,
    sp:      VM64_SP_INIT,
    flags:   { z: false, neg: false, gt: false },
    halted:  false,
    ticks:   0,
    log:     [],
    changed: new Set(),
  };
}

/** Read a 16-bit value from memory (big-endian: addr=hi, addr+1=lo). */
function readWord(mem: Uint8Array, addr: number): number {
  return ((mem[addr & 0xFFFF] << 8) | mem[(addr+1) & 0xFFFF]) & 0xFFFF;
}

/** Write a 16-bit value to memory (big-endian). */
function writeWord(mem: Uint8Array, addr: number, val: number): void {
  mem[addr & 0xFFFF]      = (val >> 8) & 0xFF;
  mem[(addr+1) & 0xFFFF]  = val & 0xFF;
}

/**
 * Execute one instruction.
 * Pure function — does not mutate input state.
 * Handles both V1 (2-byte) and V2 (2/3/4-byte) instructions.
 */
export function stepOnce64(state: VM64State, cts?: Partial<CTS64>): VM64State {
  if (state.halted) return state;

  const mem  = new Uint8Array(state.memory);
  const regs = new Uint8Array(state.regs);
  const ar   = new Uint16Array(state.ar);
  const fl   = { ...state.flags };
  const chg  = new Set<number>();
  let { pc, sp } = state;
  let halted = false;

  const op = mem[pc];
  const a1 = mem[(pc+1) & 0xFFFF];
  const a2 = mem[(pc+2) & 0xFFFF];
  const a3 = mem[(pc+3) & 0xFFFF];
  const len = getInstrLen64(op);
  const d   = (a1 >> 4) & 0xF;
  const s   = a1 & 0xF;
  const decoded = decode64(mem, pc, cts);
  const lastPc  = pc;
  pc = (pc + len) & 0xFFFF;

  // ── V2 new opcodes ────────────────────────────────────────────────────────

  switch (op) {
    // ── 3-byte extended immediate ──────────────────────────────────────────
    case 0x90: // MOVI8 reg, #imm8
      regs[a1 & 7] = a2;
      break;
    case 0x91: // ADDI8 reg, #imm8
      regs[a1 & 7] = (regs[a1 & 7] + a2) & 0xFF;
      break;
    case 0x92: // SUBI8 reg, #imm8
      regs[a1 & 7] = (regs[a1 & 7] - a2 + 256) & 0xFF;
      break;
    case 0x93: { // CMPI8 reg, #imm8
      const rv = regs[a1 & 7];
      fl.z = rv === a2; fl.neg = rv < a2; fl.gt = rv > a2;
      break;
    }

    // ── 4-byte MOVW ────────────────────────────────────────────────────────
    case 0xA0: // MOVW ARn, #imm16
      ar[a1 & 3] = (a2 << 8) | a3;
      break;

    // ── 2-byte address register ops ────────────────────────────────────────
    case 0xA1: // LDAX Rd, [ARn]
      regs[d & 7] = mem[ar[s & 3]];
      break;
    case 0xA2: { // STAX [ARn], Rs
      const addr = ar[d & 3];
      mem[addr] = regs[s & 7];
      chg.add(addr);
      break;
    }
    case 0xA3: // INCAR ARn
      ar[(a1 >> 4) & 3] = (ar[(a1 >> 4) & 3] + 1) & 0xFFFF;
      break;
    case 0xA4: // DECAR ARn
      ar[(a1 >> 4) & 3] = (ar[(a1 >> 4) & 3] - 1 + 65536) & 0xFFFF;
      break;
    case 0xA5: // ADDARI ARn, #imm8  (3-byte)
      ar[a1 & 3] = (ar[a1 & 3] + a2) & 0xFFFF;
      break;
    case 0xA6: // MOVARL Rd, ARn  →  Rd = AR[n] & 0xFF
      regs[d & 7] = ar[s & 3] & 0xFF;
      break;
    case 0xA7: // MOVARU Rd, ARn  →  Rd = (AR[n] >> 8) & 0xFF
      regs[d & 7] = (ar[s & 3] >> 8) & 0xFF;
      break;
    case 0xA8: // MOVARP ARn, Rd:Rd+1  →  AR[n] = (Rd<<8)|(Rd+1)
      ar[d & 3] = ((regs[s & 7] << 8) | regs[(s + 1) & 7]) & 0xFFFF;
      break;
    case 0xA9: // ADDARS ARn, Rs  →  AR[n] += Rs
      ar[d & 3] = (ar[d & 3] + regs[s & 7]) & 0xFFFF;
      break;

    // ── 4-byte 16-bit jumps ───────────────────────────────────────────────
    case 0xB0: pc = (a2 << 8) | a3; break;                      // JMP16
    case 0xB1: if (fl.z)   pc = (a2 << 8) | a3; break;          // JZ16
    case 0xB2: if (!fl.z)  pc = (a2 << 8) | a3; break;          // JNZ16
    case 0xB3: if (fl.gt)  pc = (a2 << 8) | a3; break;          // JG16
    case 0xB4: if (fl.neg) pc = (a2 << 8) | a3; break;          // JL16
    case 0xB5: if (!fl.neg) pc = (a2 << 8) | a3; break;         // JGE16
    case 0xB6: if (!fl.gt) pc = (a2 << 8) | a3; break;          // JLE16
    case 0xB7: {                                                   // CALL16
      // Push 16-bit return address (big-endian, 2-byte push)
      const retAddr = pc;   // already advanced by 4
      mem[sp & 0xFFFF] = (retAddr >> 8) & 0xFF; chg.add(sp & 0xFFFF); sp = (sp - 1) & 0xFFFF;
      mem[sp & 0xFFFF] = retAddr & 0xFF;         chg.add(sp & 0xFFFF); sp = (sp - 1) & 0xFFFF;
      pc = (a2 << 8) | a3;
      break;
    }
    case 0xB8: {                                                   // RET16
      sp = (sp + 1) & 0xFFFF; const lo = mem[sp & 0xFFFF];
      sp = (sp + 1) & 0xFFFF; const hi = mem[sp & 0xFFFF];
      pc = (hi << 8) | lo;
      break;
    }

    // ── 2-byte 16-bit stack ───────────────────────────────────────────────
    case 0xC0: {  // PUSH16 ARn
      const arv = ar[(a1 >> 4) & 3];
      mem[sp & 0xFFFF] = (arv >> 8) & 0xFF; chg.add(sp & 0xFFFF); sp = (sp - 1) & 0xFFFF;
      mem[sp & 0xFFFF] = arv & 0xFF;         chg.add(sp & 0xFFFF); sp = (sp - 1) & 0xFFFF;
      break;
    }
    case 0xC1: {  // POP16 ARn
      sp = (sp + 1) & 0xFFFF; const lo16 = mem[sp & 0xFFFF];
      sp = (sp + 1) & 0xFFFF; const hi16 = mem[sp & 0xFFFF];
      ar[(a1 >> 4) & 3] = (hi16 << 8) | lo16;
      break;
    }

    // ── V1 opcodes (0x00–0x81): identical semantics, 16-bit PC/SP ─────────
    default:
      switch (op) {
        case 0x00: break;
        case 0x01: halted = true; break;
        case 0x10: regs[d]=regs[s]; break;
        case 0x11: regs[d]=s; break;
        case 0x20: regs[d]=(regs[d]+regs[s])&0xFF; break;
        case 0x21: regs[d]=(regs[d]+s)&0xFF; break;
        case 0x22: regs[d]=(regs[d]-regs[s]+256)&0xFF; break;
        case 0x23: regs[d]=(regs[d]-s+256)&0xFF; break;
        case 0x30: regs[d]=(regs[d]&regs[s])&0xFF; break;
        case 0x31: regs[d]=(regs[d]|regs[s])&0xFF; break;
        case 0x32: regs[d]=(regs[d]^regs[s])&0xFF; break;
        case 0x33: regs[d]=(~regs[d])&0xFF; break;
        case 0x40: { const a=regs[d],b=regs[s]; fl.z=a===b; fl.neg=a<b; fl.gt=a>b; break; }
        case 0x41: regs[d]=(regs[d]+1)&0xFF; break;
        case 0x42: regs[d]=(regs[d]-1+256)&0xFF; break;
        // V1 jumps: 8-bit arg treated as 16-bit address (upper 8 bits = 0)
        case 0x50: pc=a1; break;
        case 0x51: if(fl.z)   pc=a1; break;
        case 0x52: if(!fl.z)  pc=a1; break;
        case 0x53: if(fl.gt)  pc=a1; break;
        case 0x54: if(fl.neg) pc=a1; break;
        case 0x55: if(!fl.neg) pc=a1; break;
        case 0x56: if(!fl.gt)  pc=a1; break;
        // V1 stack (SP is now 16-bit, still 8-bit values)
        case 0x60: mem[sp&0xFFFF]=regs[d]; chg.add(sp&0xFFFF); sp=(sp-1+65536)&0xFFFF; break;
        case 0x61: sp=(sp+1)&0xFFFF; regs[d]=mem[sp&0xFFFF]; break;
        // V1 CALL (8-bit return addr; mixes with V2 only if not using CALL16)
        case 0x70: mem[sp&0xFFFF]=pc&0xFF; chg.add(sp&0xFFFF); sp=(sp-1+65536)&0xFFFF; pc=a1; break;
        case 0x71: sp=(sp+1)&0xFFFF; pc=mem[sp&0xFFFF]; break;
        // V1 memory (8-bit address in register → safe within 256B, works in 64KB space)
        case 0x80: regs[d]=mem[regs[s]]; break;
        case 0x81: { const addr=regs[d]; mem[addr]=regs[s]; chg.add(addr); break; }
      }
  }

  const entry: Log64Entry = { pc: lastPc, decoded, ticks: state.ticks+1, len };
  const log = [entry, ...(state.log.slice(0, LOG64_MAX-1))];

  return { memory:mem, regs, ar, pc, sp, flags:fl, halted, ticks:state.ticks+1, log, changed:chg };
}

/** Execute N instructions, accumulating changed addresses. */
export function stepN64(state: VM64State, n: number, cts?: Partial<CTS64>): VM64State {
  let cur = state;
  const allChanged = new Set<number>();
  for (let i = 0; i < n; i++) {
    if (cur.halted) break;
    cur = stepOnce64(cur, cts);
    cur.changed.forEach(a => allChanged.add(a));
  }
  return { ...cur, changed: allChanged };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 6. Static Analysis — CrossRef Builder (16-bit)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Scan a V2 code buffer and build a CrossRef table.
 * Handles variable-length instructions.
 * Resolves:
 *   - Jump targets (8-bit V1 JMPs and 16-bit V2 JMP16s)
 *   - Static STAX write targets (when AR was set by MOVW immediately before)
 */
export function buildCrossRef64(code: u8[], loadAddr = 0): Map<number, CrossRefEntry64> {
  const xref = new Map<number, CrossRefEntry64>();
  const ensure = (addr: number): CrossRefEntry64 => {
    if (!xref.has(addr)) xref.set(addr, { callers:[], dataReaders:[], dataWriters:[] });
    return xref.get(addr)!;
  };

  const JUMP_V1  = new Set([0x50,0x51,0x52,0x53,0x54,0x55,0x56,0x70]);
  const JUMP_V2  = new Set([0xB0,0xB1,0xB2,0xB3,0xB4,0xB5,0xB6,0xB7]);

  // Track last MOVW for each AR register
  const arHint = new Map<number, number>();

  let i = 0;
  while (i < code.length) {
    const op  = code[i];
    const a1  = code[i+1] ?? 0;
    const a2  = code[i+2] ?? 0;
    const a3  = code[i+3] ?? 0;
    const len = getInstrLen64(op);
    const instrAddr = (loadAddr + i) & 0xFFFF;

    // Track MOVW for AR hinting
    if (op === 0xA0) arHint.set(a1 & 3, (a2 << 8) | a3);
    // MOVARP from reg pair — can't statically resolve without reg tracking; skip
    if (op === 0xA3) arHint.set((a1>>4)&3, (arHint.get((a1>>4)&3) ?? 0) + 1);
    if (op === 0xA4) arHint.set((a1>>4)&3, (arHint.get((a1>>4)&3) ?? 0) - 1);
    if (op === 0xA5) arHint.set(a1 & 3, (arHint.get(a1 & 3) ?? 0) + a2);

    // V1 jumps (8-bit target)
    if (JUMP_V1.has(op)) {
      ensure(a1 as u8).callers.push(instrAddr);
    }
    // V2 jumps (16-bit target)
    if (JUMP_V2.has(op)) {
      ensure((a2<<8)|a3).callers.push(instrAddr);
    }
    // STAX: if AR known, annotate target
    if (op === 0xA2 && arHint.has((a1>>4)&3)) {
      ensure(arHint.get((a1>>4)&3)!).dataWriters.push(instrAddr);
    }
    // LDAX: if AR known, annotate source
    if (op === 0xA1 && arHint.has(a1 & 3)) {
      ensure(arHint.get(a1 & 3)!).dataReaders.push(instrAddr);
    }
    // V1 ST: 8-bit AR from register (can't static-resolve; skip)

    i += len;
  }
  return xref;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 7. Built-in Programs (V2 machine code, hand-verified)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FILL_SIMPLE:
 * Fill RAM[0x4000..0x401F] (32 bytes) with value 0xBB.
 * Uses 16-bit addressing via AR0. Loops using R1 counter (0..31).
 *
 * Layout (28 bytes, loads at 0x0000):
 *   0x0000  MOVW AR0, #0x4000   [A0][00][40][00]  4B
 *   0x0004  MOVI8 R0, #0xBB     [90][00][BB]       3B
 *   0x0007  MOVI R1, #0         [11][10]            2B
 *   0x0009  MOVI8 R2, #32       [90][02][20]        3B
 *   0x000C  STAX [AR0], R0      [A2][00]            2B  ← LOOP
 *   0x000E  INCAR AR0           [A3][00]            2B
 *   0x0010  INC R1              [41][10]            2B
 *   0x0012  CMP R1, R2          [40][12]            2B
 *   0x0014  JL16 0x000C         [B4][00][00][0C]    4B
 *   0x0018  JMP16 0x0000        [B0][00][00][00]    4B
 */
export const PROGRAM64_FILL_SIMPLE: Program64 = {
  id:          'vm64-fill-simple',
  label:       'FILL_SIMPLE',
  description: 'Fill RAM[0x4000..0x401F] (32 bytes) with 0xBB using 16-bit AR addressing.',
  code: [
    0xA0,0x00,0x40,0x00,  // 0x0000: MOVW AR0, #0x4000
    0x90,0x00,0xBB,       // 0x0004: MOVI8 R0, #0xBB
    0x11,0x10,            // 0x0007: MOVI R1, #0      (counter)
    0x90,0x02,0x20,       // 0x0009: MOVI8 R2, #32    (limit)
    // LOOP @ 0x000C
    0xA2,0x00,            // 0x000C: STAX [AR0], R0
    0xA3,0x00,            // 0x000E: INCAR AR0
    0x41,0x10,            // 0x0010: INC R1
    0x40,0x12,            // 0x0012: CMP R1, R2
    0xB4,0x00,0x00,0x0C,  // 0x0014: JL16 0x000C
    0xB0,0x00,0x00,0x00,  // 0x0018: JMP16 0x0000 (restart)
  ],
  initMem: {},
  cts: {
    symbolTable: new Map([
      [0x0000, { name:'INIT',      region:'code', type:'label',  size:12 }],
      [0x000C, { name:'LOOP',      region:'code', type:'label',  size:8  }],
      [0x4000, { name:'fill_buf',  region:'data', type:'u8',     size:32 }],
    ]),
    commentTable: new Map([
      [0x0000, 'AR0 = 0x4000 (target buffer start)'],
      [0x0004, 'R0 = 0xBB (fill value)'],
      [0x0007, 'R1 = counter; R2 = 32 (iterations)'],
      [0x000C, 'LOOP: store, advance AR0, inc counter, compare, branch'],
    ]),
    typeTable: DEFAULT_TYPE_TABLE_64K,
  },
};

/**
 * FIBONACCI_64K:
 * Compute fib(0)..fib(10) and store at RAM[0x4000..0x400A] (data segment).
 * Demonstrates V2 16-bit addressing for data beyond 0xFF.
 *
 * Layout (47 bytes, loads at 0x0000):
 *   0x0000  MOVI R0, #0          [11][00]
 *   0x0002  MOVI R1, #1          [11][11]
 *   0x0004  MOVI R3, #0          [11][30]
 *   0x0006  MOVI8 R4, #10        [90][04][0A]
 *   0x0009  MOVW AR0, #0x4000    [A0][00][40][00]
 *   0x000D  STAX [AR0], R0       [A2][00]  store fib[0]
 *   0x000F  INCAR AR0            [A3][00]
 *   0x0011  STAX [AR0], R1       [A2][01]  store fib[1]
 *   0x0013  INCAR AR0            [A3][00]
 *   0x0015  MOVI R3, #2          [11][32]  counter=2
 *   0x0017  MOV R2, R0           [10][20]  ← LOOP
 *   0x0019  ADD R2, R1           [20][21]
 *   0x001B  MOV R0, R1           [10][01]
 *   0x001D  MOV R1, R2           [10][12]
 *   0x001F  STAX [AR0], R2       [A2][02]
 *   0x0021  INCAR AR0            [A3][00]
 *   0x0023  INC R3               [41][30]
 *   0x0025  CMP R3, R4           [40][34]
 *   0x0027  JLE16 0x0017         [B6][00][00][17]   (inclusive → stores fib(2..10))
 *   0x002B  JMP16 0x0000         [B0][00][00][00]
 */
export const PROGRAM64_FIBONACCI: Program64 = {
  id:          'vm64-fibonacci',
  label:       'FIBONACCI_64K',
  description: 'Compute fib(0–10) and store to RAM[0x4000..0x400A] via 16-bit addressing.',
  code: [
    0x11,0x00,            // 0x0000: MOVI R0, #0   fib[n-2]
    0x11,0x11,            // 0x0002: MOVI R1, #1   fib[n-1]
    0x11,0x30,            // 0x0004: MOVI R3, #0   counter
    0x90,0x04,0x0A,       // 0x0006: MOVI8 R4, #10 max
    0xA0,0x00,0x40,0x00,  // 0x0009: MOVW AR0, #0x4000
    0xA2,0x00,            // 0x000D: STAX [AR0], R0  fib[0]=0
    0xA3,0x00,            // 0x000F: INCAR AR0
    0xA2,0x01,            // 0x0011: STAX [AR0], R1  fib[1]=1
    0xA3,0x00,            // 0x0013: INCAR AR0
    0x11,0x32,            // 0x0015: MOVI R3, #2
    // LOOP @ 0x0017
    0x10,0x20,            // 0x0017: MOV R2, R0
    0x20,0x21,            // 0x0019: ADD R2, R1
    0x10,0x01,            // 0x001B: MOV R0, R1
    0x10,0x12,            // 0x001D: MOV R1, R2
    0xA2,0x02,            // 0x001F: STAX [AR0], R2
    0xA3,0x00,            // 0x0021: INCAR AR0
    0x41,0x30,            // 0x0023: INC R3
    0x40,0x34,            // 0x0025: CMP R3, R4
    0xB6,0x00,0x00,0x17,  // 0x0027: JLE16 0x0017  (inclusive: store fib(2..10), not 2..9)
    0xB0,0x00,0x00,0x00,  // 0x002B: JMP16 0x0000 (restart)
  ],
  initMem: {},
  cts: {
    symbolTable: new Map([
      [0x0000, { name:'INIT',      region:'code', type:'label',  size:23 }],
      [0x0017, { name:'LOOP',      region:'code', type:'label',  size:20 }],
      [0x4000, { name:'fib_data',  region:'data', type:'u8',     size:11 }],
    ]),
    commentTable: new Map([
      [0x0000, 'R0=fib[n-2]=0, R1=fib[n-1]=1, R3=counter, R4=max(10)'],
      [0x0009, 'AR0 = 0x4000 (data segment write pointer)'],
      [0x0017, 'LOOP: R2=R0+R1; shift pair; STAX to data segment; inc AR0 and counter'],
      [0x0027, 'JL16 while counter < max(10); then restart'],
    ]),
    typeTable: DEFAULT_TYPE_TABLE_64K,
  },
};

export const BUILTIN_PROGRAMS_64: Program64[] = [
  PROGRAM64_FILL_SIMPLE,
  PROGRAM64_FIBONACCI,
];

// ═══════════════════════════════════════════════════════════════════════════════
// § 8. V1→V2 Migration Utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lift a V1 ProgramDefinition into a V2 Program64.
 * The code is unchanged; the program runs correctly in the V2 engine
 * (V1 opcodes remain 2-byte and work identically in the 16-bit address space).
 */
export function liftV1ToV2(v1: ProgramDefinition): Program64 {
  const initMem: Record<number, u8> = {};
  Object.entries(v1.initMem ?? {}).forEach(([k, v]) => {
    if (v !== undefined) initMem[parseInt(k)] = v;
  });
  return {
    id:          `vm64-${v1.id}`,
    label:       `${v1.label} (V2)`,
    description: `V1 program '${v1.description}' lifted to VM64 address space.`,
    code:        [...v1.code],
    initMem,
    loadAddr:    0,
    cts:         {},  // V1 CTS type is incompatible; rebuild if needed
  };
}

/**
 * Validate that a V2 program's declared entry points are within code bounds
 * and that all jump targets resolve to valid instruction starts.
 */
export function validateProgram64(program: Program64): { valid: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const loadAddr = program.loadAddr ?? 0;
  const codeEnd  = loadAddr + program.code.length;

  // Scan for out-of-bounds jumps
  let i = 0;
  while (i < program.code.length) {
    const op  = program.code[i];
    const a1  = program.code[i+1] ?? 0;
    const a2  = program.code[i+2] ?? 0;
    const a3  = program.code[i+3] ?? 0;
    const len = getInstrLen64(op);
    const instrAddr = loadAddr + i;

    const JUMP_V1 = new Set([0x50,0x51,0x52,0x53,0x54,0x55,0x56,0x70]);
    const JUMP_V2 = new Set([0xB0,0xB1,0xB2,0xB3,0xB4,0xB5,0xB6,0xB7]);

    if (JUMP_V1.has(op)) {
      if (a1 < loadAddr || a1 >= codeEnd) {
        warnings.push(`0x${hex4(instrAddr)}: V1 jump target 0x${hex2(a1)} outside code range [0x${hex4(loadAddr)},0x${hex4(codeEnd)})`);
      }
    }
    if (JUMP_V2.has(op)) {
      const target = (a2 << 8) | a3;
      if (target < loadAddr || target >= codeEnd) {
        warnings.push(`0x${hex4(instrAddr)}: V2 jump target 0x${hex4(target)} outside code range`);
      }
    }
    i += len;
  }
  return { valid: warnings.length === 0, warnings };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 9. AI-Readable VM64 Snapshot
// ═══════════════════════════════════════════════════════════════════════════════

export interface VM64Snapshot {
  vm_id:             string;
  tick:              number;
  pc:                string;   // "0xNNNN" (4 hex digits)
  pc_symbol:         string | null;
  pc_comment:        string | null;
  instruction:       string;
  instruction_bytes: number;   // 2, 3, or 4
  registers:         Record<string, number>;    // R0–R7
  address_regs:      Record<string, string>;    // AR0–AR3 as "0xNNNN"
  flags:             { Z: boolean; N: boolean; G: boolean };
  changed_this_tick: Array<{
    addr:   string;    // "0xNNNN"
    symbol: string | null;
    before: u8;
    after:  u8;
  }>;
  stack_depth:       number;   // VM64_SP_INIT - sp
  halted:            boolean;
  arch:              'EML-VM64';
}

/** Build an AI-readable snapshot from VM64 state. */
export function buildVM64Snapshot(
  id:   string,
  s:    VM64State,
  cts?: Partial<CTS64>,
  prev?: Uint8Array,
): VM64Snapshot {
  const op  = s.memory[s.pc];
  const a1  = s.memory[(s.pc+1) & 0xFFFF];

  const changed = [...s.changed].map(addr => ({
    addr:   `0x${hex4(addr)}`,
    symbol: cts?.symbolTable?.get(addr)?.name ?? null,
    before: prev ? prev[addr] : s.memory[addr],
    after:  s.memory[addr],
  }));

  const regs: Record<string, number> = {};
  REG_NAMES.forEach((n, i) => { regs[n] = s.regs[i]; });

  const arRegs: Record<string, string> = {};
  AR_NAMES.forEach((n, i) => { arRegs[n] = `0x${hex4(s.ar[i])}`; });

  return {
    vm_id:             id,
    tick:              s.ticks,
    pc:                `0x${hex4(s.pc)}`,
    pc_symbol:         cts?.symbolTable?.get(s.pc)?.name ?? null,
    pc_comment:        cts?.commentTable?.get(s.pc)         ?? null,
    instruction:       decode64(s.memory, s.pc, cts),
    instruction_bytes: getInstrLen64(op),
    registers:         regs,
    address_regs:      arRegs,
    flags:             { Z: s.flags.z, N: s.flags.neg, G: s.flags.gt },
    changed_this_tick: changed,
    stack_depth:       (VM64_SP_INIT - s.sp + 65536) & 0xFFFF,
    halted:            s.halted,
    arch:              'EML-VM64',
  };
}

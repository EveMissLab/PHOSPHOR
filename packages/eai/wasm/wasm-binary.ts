/**
 * PHOSPHOR · WASM Binary Parser (browser-safe)
 * EML-EAI-2026-v0.6 · Φ's first non-invented target
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Decodes the REAL WebAssembly binary format (the same bytes any spec-conformant
 * engine — a browser, Node's `WebAssembly`, wasmtime — accepts) into a structured
 * `WasmModule`. This is deliberately a subset of the spec: integer (i32) core
 * instructions, `call`, structured control flow (block/loop/if/else), locals,
 * globals, one linear memory, and the custom "name" section. No imports, no
 * multi-value block types, no i64/f32/f64, no tables/call_indirect — real modules
 * that stay inside this subset (the common case for small, integer-only
 * functions) parse byte-for-byte per spec; anything outside it throws a named
 * "not supported in WASM-MVP profile" error rather than silently misreading it —
 * the same "inexpressible over a wrong answer" discipline `eml-semantic.ts`
 * already uses for `semanticEquiv`.
 *
 * Control flow is pre-resolved at parse time: every block/loop/if instruction
 * gets the flattened-array index of its matching end (and, for `if`, its
 * matching else), computed once via a depth-counting scan — so the interpreter
 * (`wasm-interp.ts`) never re-scans bytes to find a branch target.
 */

export type WasmValType = 'i32' | 'i64' | 'f32' | 'f64';

export interface WasmFuncType {
  params:  WasmValType[];
  results: WasmValType[];
}

/** One decoded instruction. Immediates are resolved at parse time (no re-parsing at run time). */
export interface WasmInstr {
  op:        number;   // raw opcode byte
  mnemonic:  string;
  // operand set actually used depends on `mnemonic` — see wasm-interp.ts's stepOnce dispatch.
  idx?:      number;    // local/global/func index, or br label depth
  i32?:      number;    // i32.const value
  memArg?:   { align: number; offset: number };
  labels?:   number[];  // br_table: [target0, target1, …]
  default?:  number;    // br_table: default label depth
  // control-flow resolution (block | loop | if | else | end only)
  matchEnd?: number;    // index (into the same flattened body[]) of the matching `end`
  matchElse?: number;   // `if` only: index of the matching `else`, if present
}

export interface WasmFunc {
  typeIdx:   number;
  type:      WasmFuncType;
  numParams: number;
  locals:    WasmValType[];  // params ++ declared locals, in local-index order
  body:      WasmInstr[];    // flattened; last element is always the function's own `end`
  name?:     string;         // from the custom "name" section, if present
  localNames?: Map<number, string>;
}

export type WasmExportKind = 'func' | 'table' | 'mem' | 'global';

export interface WasmExport {
  name:  string;
  kind:  WasmExportKind;
  index: number;
}

export interface WasmGlobalDef {
  type:    WasmValType;
  mutable: boolean;
  init:    number;
}

export interface WasmDataSegment {
  memIndex: number;
  offset:   number;
  bytes:    Uint8Array;
}

export interface WasmModule {
  types:        WasmFuncType[];
  funcs:        WasmFunc[];
  memoryPages:  { min: number; max?: number };
  exports:      WasmExport[];
  globals:      WasmGlobalDef[];
  data:         WasmDataSegment[];
  startFuncIdx?: number;
}

/** Thrown for real-but-unsupported constructs, never for malformed input silently misread. */
export class WasmNotSupported extends Error {
  constructor(what: string) { super(`WASM-MVP profile does not support: ${what}`); this.name = 'WasmNotSupported'; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 1. Byte reader — LEB128 + primitive decoding
// ═══════════════════════════════════════════════════════════════════════════════

class ByteReader {
  pos = 0;
  constructor(private readonly bytes: Uint8Array) {}

  get eof(): boolean { return this.pos >= this.bytes.length; }

  u8(): number { return this.bytes[this.pos++]; }

  bytesN(n: number): Uint8Array {
    const b = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  /** Unsigned LEB128 → JS number. Accumulates via multiplication so values beyond 28 bits (page counts, offsets) stay exact. */
  uleb(): number {
    let result = 0, shift = 0, byte: number;
    do {
      byte = this.u8();
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  }

  /** Signed LEB128, 32-bit range (i32.const, br label depth is never negative but reuses uleb). */
  sleb32(): number {
    let result = 0, shift = 0, byte: number;
    do {
      byte = this.u8();
      result |= (byte & 0x7f) << shift;
      shift += 7;
    } while (byte & 0x80 && shift < 32);
    if (shift < 32 && (byte! & 0x40)) result |= (~0 << shift);
    return result;
  }

  name(): string {
    const len = this.uleb();
    return new TextDecoder().decode(this.bytesN(len));
  }
}

const VALTYPE: Record<number, WasmValType> = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64' };

function readValType(r: ByteReader): WasmValType {
  const b = r.u8();
  const t = VALTYPE[b];
  if (!t) throw new WasmNotSupported(`value type byte 0x${b.toString(16)}`);
  return t;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 2. Instruction decoding — shared by function bodies, global init exprs, offset exprs
// ═══════════════════════════════════════════════════════════════════════════════

/** mnemonics this profile understands, keyed by raw opcode byte (single-byte only — no 0xFC/0xFD prefix ops). */
const OPCODE_NAME: Record<number, string> = {
  0x00: 'unreachable', 0x01: 'nop',
  0x02: 'block', 0x03: 'loop', 0x04: 'if', 0x05: 'else', 0x0b: 'end',
  0x0c: 'br', 0x0d: 'br_if', 0x0e: 'br_table', 0x0f: 'return',
  0x10: 'call',
  0x1a: 'drop', 0x1b: 'select',
  0x20: 'local.get', 0x21: 'local.set', 0x22: 'local.tee',
  0x23: 'global.get', 0x24: 'global.set',
  0x28: 'i32.load', 0x36: 'i32.store',
  0x41: 'i32.const',
  0x45: 'i32.eqz', 0x46: 'i32.eq', 0x47: 'i32.ne',
  0x48: 'i32.lt_s', 0x49: 'i32.lt_u', 0x4a: 'i32.gt_s', 0x4b: 'i32.gt_u',
  0x4c: 'i32.le_s', 0x4d: 'i32.le_u', 0x4e: 'i32.ge_s', 0x4f: 'i32.ge_u',
  0x6a: 'i32.add', 0x6b: 'i32.sub', 0x6c: 'i32.mul',
  0x6d: 'i32.div_s', 0x6e: 'i32.div_u', 0x6f: 'i32.rem_s', 0x70: 'i32.rem_u',
  0x71: 'i32.and', 0x72: 'i32.or', 0x73: 'i32.xor',
  0x74: 'i32.shl', 0x75: 'i32.shr_s', 0x76: 'i32.shr_u',
};

/**
 * Reads one `blocktype` byte (block/loop/if immediate). Only the empty type
 * (0x40) is supported: the interpreter tracks branch-target arity as a fixed 0
 * for every block/loop/if (see `ControlFrame.resultArity` in wasm-interp.ts), so
 * a value-producing block type would silently drop the value on branch-exit if
 * we accepted it here. Throwing keeps the "inexpressible over a wrong answer"
 * contract instead of mis-executing a real module that uses one.
 */
function readBlockType(r: ByteReader): void {
  const b = r.u8();
  if (b === 0x40) return;
  if (VALTYPE[b]) throw new WasmNotSupported(`value-producing block type '${VALTYPE[b]}' (only empty block types are supported)`);
  r.pos -= 1;
  const idx = r.sleb32();
  throw new WasmNotSupported(`multi-value block type (typeidx ${idx})`);
}

/** Decode one straight-line instruction stream (a function body, or a const-expr) into a flattened array with block/loop/if/else resolved to matching indices. Stops after the instruction that closes the outermost implicit scope (the body's own final `end`). */
function decodeInstrs(r: ByteReader): WasmInstr[] {
  const body: WasmInstr[] = [];
  const controlStack: number[] = []; // indices (into body[]) of open block/loop/if awaiting `end`
  const ifStack: number[] = [];       // parallel: index of the `if` currently open at each control depth (or -1)

  for (;;) {
    const op = r.u8();
    const mnemonic = OPCODE_NAME[op];
    if (!mnemonic) throw new WasmNotSupported(`opcode 0x${op.toString(16)}`);

    switch (mnemonic) {
      case 'block': case 'loop': case 'if': {
        readBlockType(r);
        body.push({ op, mnemonic });
        controlStack.push(body.length - 1);
        ifStack.push(mnemonic === 'if' ? body.length - 1 : -1);
        break;
      }
      case 'else': {
        const ifIdx = ifStack[ifStack.length - 1];
        if (ifIdx === undefined || ifIdx < 0) throw new WasmNotSupported('else without matching if');
        body.push({ op, mnemonic });
        body[ifIdx].matchElse = body.length - 1;
        break;
      }
      case 'end': {
        body.push({ op, mnemonic });
        const openIdx = controlStack.pop();
        ifStack.pop();
        if (openIdx === undefined) {
          // closes the function/expr body itself — done.
          return body;
        }
        body[openIdx].matchEnd = body.length - 1;
        break;
      }
      case 'br': case 'br_if':
        body.push({ op, mnemonic, idx: r.uleb() });
        break;
      case 'br_table': {
        const count = r.uleb();
        const labels: number[] = [];
        for (let i = 0; i < count; i++) labels.push(r.uleb());
        const def = r.uleb();
        body.push({ op, mnemonic, labels, default: def });
        break;
      }
      case 'call':
        body.push({ op, mnemonic, idx: r.uleb() });
        break;
      case 'local.get': case 'local.set': case 'local.tee':
      case 'global.get': case 'global.set':
        body.push({ op, mnemonic, idx: r.uleb() });
        break;
      case 'i32.load': case 'i32.store': {
        const align = r.uleb();
        const offset = r.uleb();
        body.push({ op, mnemonic, memArg: { align, offset } });
        break;
      }
      case 'i32.const':
        body.push({ op, mnemonic, i32: r.sleb32() });
        break;
      default:
        // unreachable/nop/return/drop/select and all no-immediate i32.* ops
        body.push({ op, mnemonic });
        break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 3. Const-expr (global init / data offset) — restricted to a single i32.const
// ═══════════════════════════════════════════════════════════════════════════════

function readConstExprI32(r: ByteReader): number {
  const op = r.u8();
  if (op !== 0x41) throw new WasmNotSupported(`const-expr opcode 0x${op.toString(16)} (only i32.const supported)`);
  const v = r.sleb32();
  const end = r.u8();
  if (end !== 0x0b) throw new WasmNotSupported('const-expr with more than one instruction');
  return v;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 4. Custom "name" section
// ═══════════════════════════════════════════════════════════════════════════════

function parseNameSection(bytes: Uint8Array, funcs: WasmFunc[]): void {
  const r = new ByteReader(bytes);
  while (!r.eof) {
    const subId = r.u8();
    const subSize = r.uleb();
    const subEnd = r.pos + subSize;
    if (subId === 1) { // function names
      const count = r.uleb();
      for (let i = 0; i < count; i++) {
        const idx = r.uleb();
        const nm = r.name();
        if (funcs[idx]) funcs[idx].name = nm;
      }
    } else if (subId === 2) { // local names
      const funcCount = r.uleb();
      for (let i = 0; i < funcCount; i++) {
        const fIdx = r.uleb();
        const localCount = r.uleb();
        const map = new Map<number, string>();
        for (let j = 0; j < localCount; j++) {
          const lIdx = r.uleb();
          const nm = r.name();
          map.set(lIdx, nm);
        }
        if (funcs[fIdx]) funcs[fIdx].localNames = map;
      }
    }
    r.pos = subEnd; // skip anything in the subsection we didn't interpret
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 5. Module parser
// ═══════════════════════════════════════════════════════════════════════════════

export function parseWasmModule(bytes: Uint8Array): WasmModule {
  const r = new ByteReader(bytes);
  if (r.u8() !== 0x00 || r.u8() !== 0x61 || r.u8() !== 0x73 || r.u8() !== 0x6d) {
    throw new Error('not a WASM module (bad magic)');
  }
  const version = r.u8() | (r.u8() << 8) | (r.u8() << 16) | (r.u8() << 24);
  if (version !== 1) throw new WasmNotSupported(`module version ${version}`);

  const types: WasmFuncType[] = [];
  const funcTypeIdxs: number[] = [];
  const memoryPages: { min: number; max?: number } = { min: 0 };
  const exports: WasmExport[] = [];
  const globals: WasmGlobalDef[] = [];
  const data: WasmDataSegment[] = [];
  const codeBodies: { locals: WasmValType[]; body: WasmInstr[] }[] = [];
  let startFuncIdx: number | undefined;
  let nameSectionBytes: Uint8Array | undefined;

  while (!r.eof) {
    const sectionId = r.u8();
    const sectionSize = r.uleb();
    const sectionEnd = r.pos + sectionSize;

    switch (sectionId) {
      case 0: { // custom
        const name = r.name();
        if (name === 'name') nameSectionBytes = r.bytesN(sectionEnd - r.pos);
        break;
      }
      case 1: { // type
        const count = r.uleb();
        for (let i = 0; i < count; i++) {
          const form = r.u8();
          if (form !== 0x60) throw new WasmNotSupported(`type section form byte 0x${form.toString(16)}`);
          const numParams = r.uleb();
          const params: WasmValType[] = [];
          for (let p = 0; p < numParams; p++) params.push(readValType(r));
          const numResults = r.uleb();
          const results: WasmValType[] = [];
          for (let p = 0; p < numResults; p++) results.push(readValType(r));
          types.push({ params, results });
        }
        break;
      }
      case 2: { // import
        const count = r.uleb();
        if (count > 0) throw new WasmNotSupported('imports');
        break;
      }
      case 3: { // function
        const count = r.uleb();
        for (let i = 0; i < count; i++) funcTypeIdxs.push(r.uleb());
        break;
      }
      case 4: { // table — not used by anything we execute (no call_indirect); skip verbatim.
        break;
      }
      case 5: { // memory
        const count = r.uleb();
        if (count !== 1) throw new WasmNotSupported(`${count} memories (exactly one supported)`);
        const flag = r.uleb();
        memoryPages.min = r.uleb();
        if (flag === 1) memoryPages.max = r.uleb();
        break;
      }
      case 6: { // global
        const count = r.uleb();
        for (let i = 0; i < count; i++) {
          const type = readValType(r);
          const mutable = r.u8() !== 0;
          const init = readConstExprI32(r);
          globals.push({ type, mutable, init });
        }
        break;
      }
      case 7: { // export
        const count = r.uleb();
        const KIND: Record<number, WasmExportKind> = { 0: 'func', 1: 'table', 2: 'mem', 3: 'global' };
        for (let i = 0; i < count; i++) {
          const name = r.name();
          const kindByte = r.u8();
          const kind = KIND[kindByte];
          if (!kind) throw new WasmNotSupported(`export kind byte 0x${kindByte.toString(16)}`);
          const index = r.uleb();
          exports.push({ name, kind, index });
        }
        break;
      }
      case 8: { // start
        startFuncIdx = r.uleb();
        break;
      }
      case 9: { // element — not used (no tables); skip verbatim.
        break;
      }
      case 10: { // code
        const count = r.uleb();
        for (let i = 0; i < count; i++) {
          const bodySize = r.uleb();
          const bodyEnd = r.pos + bodySize;
          const localDeclCount = r.uleb();
          const locals: WasmValType[] = [];
          for (let d = 0; d < localDeclCount; d++) {
            const n = r.uleb();
            const t = readValType(r);
            for (let k = 0; k < n; k++) locals.push(t);
          }
          const body = decodeInstrs(r);
          if (r.pos !== bodyEnd) throw new Error(`code body ${i}: decoded length mismatch (parser/binary drift)`);
          codeBodies.push({ locals, body });
        }
        break;
      }
      case 11: { // data
        const count = r.uleb();
        for (let i = 0; i < count; i++) {
          const memIndex = r.uleb();
          if (memIndex !== 0) throw new WasmNotSupported(`data segment targeting memory ${memIndex}`);
          const offset = readConstExprI32(r);
          const len = r.uleb();
          data.push({ memIndex, offset, bytes: r.bytesN(len) });
        }
        break;
      }
      default:
        // unknown section id — skip verbatim rather than fail; only matters if we later execute it.
        break;
    }
    r.pos = sectionEnd;
  }

  const funcs: WasmFunc[] = funcTypeIdxs.map((typeIdx, i) => {
    const type = types[typeIdx];
    if (!type) throw new Error(`function ${i} references undefined type ${typeIdx}`);
    const { locals, body } = codeBodies[i];
    return {
      typeIdx, type,
      numParams: type.params.length,
      locals: [...type.params, ...locals],
      body,
    };
  });

  if (nameSectionBytes) parseNameSection(nameSectionBytes, funcs);

  return { types, funcs, memoryPages, exports, globals, data, startFuncIdx };
}

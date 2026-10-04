/**
 * PHOSPHOR · WASM fixture builder (test/fixture tooling — NOT part of the parser/interpreter)
 * EML-EAI-2026-v0.6
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Hand-assembles a real, spec-conformant `.wasm` binary — the same byte format
 * any toolchain (wat2wasm, rustc --target wasm32, clang) emits and any engine
 * (a browser, Node's `WebAssembly`, wasmtime) accepts. It stands in for "a real
 * compiled program" so `wasm-binary.ts`/`wasm-interp.ts` can be exercised (and,
 * in `test-wasm.ts`, cross-checked byte-for-byte) without depending on an
 * external toolchain being installed in this environment.
 *
 * PHOSPHOR_FIBONACCI_WASM computes the exact program `PROGRAM_FIBONACCI`
 * (eml-vm16-core.ts) already computes — fib(0..10) written to linear memory —
 * but as two real WASM functions (`add`, `main`) using genuine control flow
 * (`loop`/`br_if`), a real `call`, and real `i32.store`. Same math, real ISA:
 * the direct comparison point for "this is no longer a self-invented VM."
 *
 *   func $add(a i32, b i32) -> i32 { a + b }
 *   func $main(n i32) {
 *     mem[0..44) = fib(0), fib(1), …, fib(n)   (i32 cells, 4 bytes each)
 *   }
 *   data: "PHOSPHOR" @ 4096   (Layer 4 stringTable proof point, mirrors the
 *                              VM-16 PTR_CHASE integration test)
 *   exports: "main" (func), "add" (func), "memory" (mem)
 */

// ── minimal byte/LEB128 writer ─────────────────────────────────────────────────

class ByteWriter {
  private buf: number[] = [];
  u8(n: number): this { this.buf.push(n & 0xff); return this; }
  raw(bytes: ArrayLike<number>): this { for (let i = 0; i < bytes.length; i++) this.buf.push(bytes[i] & 0xff); return this; }
  uleb(n: number): this {
    do {
      let byte = n % 128;
      n = Math.floor(n / 128);
      if (n !== 0) byte |= 0x80;
      this.buf.push(byte);
    } while (n !== 0);
    return this;
  }
  sleb(n: number): this {
    let more = true;
    while (more) {
      let byte = n & 0x7f;
      n >>= 7;
      if ((n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0)) more = false;
      else byte |= 0x80;
      this.buf.push(byte);
    }
    return this;
  }
  name(s: string): this {
    const utf8 = Array.from(new TextEncoder().encode(s));
    this.uleb(utf8.length);
    return this.raw(utf8);
  }
  get length(): number { return this.buf.length; }
  toUint8Array(): Uint8Array { return new Uint8Array(this.buf); }
}

function section(id: number, build: (w: ByteWriter) => void): number[] {
  const inner = new ByteWriter();
  build(inner);
  const out = new ByteWriter();
  out.u8(id).uleb(inner.length).raw(inner.toUint8Array());
  return Array.from(out.toUint8Array());
}

const VALTYPE_BYTE: Record<'i32' | 'i64' | 'f32' | 'f64', number> = { i32: 0x7f, i64: 0x7e, f32: 0x7d, f64: 0x7c };

const OP: Record<string, number> = {
  block: 0x02, loop: 0x03, if: 0x04, else: 0x05, end: 0x0b,
  br: 0x0c, br_if: 0x0d, return: 0x0f, call: 0x10,
  'local.get': 0x20, 'local.set': 0x21, 'local.tee': 0x22,
  'i32.load': 0x28, 'i32.store': 0x36,
  'i32.const': 0x41,
  'i32.le_s': 0x4c,
  'i32.add': 0x6a, 'i32.mul': 0x6c,
};

/** Emit one instruction. `imm` shape depends on the mnemonic (block type byte / LEB128 index / signed const / align+offset). */
function emit(w: ByteWriter, mnemonic: keyof typeof OP, ...imm: number[]): void {
  w.u8(OP[mnemonic]);
  switch (mnemonic) {
    case 'block': case 'loop': case 'if': w.u8(imm[0] ?? 0x40); break;
    case 'br': case 'br_if': case 'call':
    case 'local.get': case 'local.set': case 'local.tee': w.uleb(imm[0]); break;
    case 'i32.const': w.sleb(imm[0]); break;
    case 'i32.load': case 'i32.store': w.uleb(imm[0] ?? 2).uleb(imm[1] ?? 0); break;
    default: break; // else, end, return, i32.le_s, i32.add, i32.mul — no immediate
  }
}

// ── the fixture ─────────────────────────────────────────────────────────────

const PHOSPHOR_LABEL = Array.from(new TextEncoder().encode('PHOSPHOR'));
const STRING_DATA_OFFSET = 4096;

export function buildFibonacciWasmModule(): Uint8Array {
  // §1 type: type0 (i32,i32)->i32 [add]; type1 (i32)->() [main]
  const typeSec = section(1, w => {
    w.uleb(2);
    w.u8(0x60).uleb(2).u8(VALTYPE_BYTE.i32).u8(VALTYPE_BYTE.i32).uleb(1).u8(VALTYPE_BYTE.i32); // (i32,i32)->i32
    w.u8(0x60).uleb(1).u8(VALTYPE_BYTE.i32).uleb(0);                                            // (i32)->()
  });

  // §2 function: func0 -> type0 (add), func1 -> type1 (main)
  const funcSec = section(3, w => { w.uleb(2).uleb(0).uleb(1); });

  // §3 memory: exactly one page (64 KiB), no max
  const memSec = section(5, w => { w.uleb(1).uleb(0).uleb(1); });

  // §4 export: main (func 1), add (func 0), memory (mem 0)
  const exportSec = section(7, w => {
    w.uleb(3);
    w.name('main').u8(0).uleb(1);
    w.name('add').u8(0).uleb(0);
    w.name('memory').u8(2).uleb(0);
  });

  // §5 code
  // func0 $add(a,b): local.get 0; local.get 1; i32.add; end
  const addBody = new ByteWriter();
  addBody.uleb(0); // no declared locals beyond the 2 params
  emit(addBody, 'local.get', 0);
  emit(addBody, 'local.get', 1);
  emit(addBody, 'i32.add');
  emit(addBody, 'end');

  // func1 $main(n): locals i(1) a(2) b(3) tmp(4), all i32
  const mainBody = new ByteWriter();
  mainBody.uleb(1).uleb(4).u8(VALTYPE_BYTE.i32); // one decl group: 4x i32
  emit(mainBody, 'i32.const', 0); emit(mainBody, 'i32.const', 0); emit(mainBody, 'i32.store');   // mem[0]  = 0  (fib 0)
  emit(mainBody, 'i32.const', 4); emit(mainBody, 'i32.const', 1); emit(mainBody, 'i32.store');   // mem[4]  = 1  (fib 1)
  emit(mainBody, 'i32.const', 0); emit(mainBody, 'local.set', 2);                                 // a = 0
  emit(mainBody, 'i32.const', 1); emit(mainBody, 'local.set', 3);                                 // b = 1
  emit(mainBody, 'i32.const', 2); emit(mainBody, 'local.set', 1);                                 // i = 2
  emit(mainBody, 'loop');
    emit(mainBody, 'local.get', 2); emit(mainBody, 'local.get', 3); emit(mainBody, 'call', 0);
    emit(mainBody, 'local.set', 4);                                                                // tmp = add(a,b)
    emit(mainBody, 'local.get', 1); emit(mainBody, 'i32.const', 4); emit(mainBody, 'i32.mul');
    emit(mainBody, 'local.get', 4); emit(mainBody, 'i32.store');                                    // mem[i*4] = tmp
    emit(mainBody, 'local.get', 3); emit(mainBody, 'local.set', 2);                                 // a = b
    emit(mainBody, 'local.get', 4); emit(mainBody, 'local.set', 3);                                 // b = tmp
    emit(mainBody, 'local.get', 1); emit(mainBody, 'i32.const', 1); emit(mainBody, 'i32.add'); emit(mainBody, 'local.set', 1); // i++
    emit(mainBody, 'local.get', 1); emit(mainBody, 'local.get', 0); emit(mainBody, 'i32.le_s');
    emit(mainBody, 'br_if', 0);                                                                     // loop while i <= n
  emit(mainBody, 'end');  // closes loop
  emit(mainBody, 'end');  // closes function

  const codeSec = section(10, w => {
    w.uleb(2);
    w.uleb(addBody.length).raw(addBody.toUint8Array());
    w.uleb(mainBody.length).raw(mainBody.toUint8Array());
  });

  // §6 data: "PHOSPHOR" @ 4096 — Layer 4 stringTable proof point
  const dataSec = section(11, w => {
    w.uleb(1);
    w.uleb(0);                                   // memory index 0
    w.u8(0x41).sleb(STRING_DATA_OFFSET).u8(0x0b); // i32.const 4096; end   (const-expr offset)
    w.uleb(PHOSPHOR_LABEL.length).raw(PHOSPHOR_LABEL);
  });

  // §7 custom "name" section — func names + local names, mirrors real toolchain debug output
  const nameSec = section(0, w => {
    w.name('name');
    // funcs subsection (id=1)
    const funcNames = new ByteWriter();
    funcNames.uleb(2);
    funcNames.uleb(0).name('add');
    funcNames.uleb(1).name('main');
    w.u8(1).uleb(funcNames.length).raw(funcNames.toUint8Array());
    // locals subsection (id=2)
    const localNames = new ByteWriter();
    localNames.uleb(2);
    localNames.uleb(0).uleb(2).uleb(0).name('a').uleb(1).name('b');
    localNames.uleb(1).uleb(5).uleb(0).name('n').uleb(1).name('i').uleb(2).name('a').uleb(3).name('b').uleb(4).name('tmp');
    w.u8(2).uleb(localNames.length).raw(localNames.toUint8Array());
  });

  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  return new Uint8Array([
    ...header, ...typeSec, ...funcSec, ...memSec, ...exportSec, ...codeSec, ...dataSec, ...nameSec,
  ]);
}

export const STRING_DATA_ADDR = STRING_DATA_OFFSET;

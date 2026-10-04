/**
 * PHOSPHOR · WASM CTS mapping (browser-safe)
 * EML-EAI-2026-v0.6
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Maps a parsed WASM module onto the SAME `CTS` shape `eml-vm16-core.ts` already
 * defines (`symbolTable`/`typeTable`/`stringTable`/`commentTable`/`crossRefTable`
 * — `u8` there is just `number`, so the type is structurally reusable as-is).
 *
 * The honest limit, stated rather than papered over: WASM has TWO address
 * spaces — code (function index + instruction offset) and linear memory — while
 * the VM-16 CTS was designed for an architecture where code and data share one
 * space. `symbolTable` / `typeTable` / `stringTable` / `crossRefTable` below are
 * kept to what genuinely maps: the linear-memory layer. Function/label symbols
 * (`WasmFunc.name`, from the custom "name" section) live in the code space and
 * are surfaced directly by `wasm-snapshot.ts`'s `pc_symbol` field instead of
 * being forced into a memory-address map they don't belong in. This split is
 * exactly the "CTS roles need re-deriving per architecture" lesson the WORKPLAN
 * generalized-retrofit-kit phase is meant to formalize — this module is the
 * second data point after EML-VM-16/64/BASIC.
 */

import type { CTS, SymbolEntry, RegionEntry, CrossRefEntry } from '../eml-vm16-core';
import type { WasmModule } from './wasm-binary';
import type { WasmSnapshot } from './wasm-snapshot';

/** Layer 2 + 3 (static): one symbol/region per data segment — the only linear-memory addresses a module declares meaning for ahead of time. Everything else (stack scratch, heap the program manages itself) is only nameable dynamically, via `augmentWasmCrossRef`. */
export function buildWasmCts(module: WasmModule): Partial<CTS> {
  const symbolTable = new Map<number, SymbolEntry>();
  const typeTable: RegionEntry[] = [];

  module.data.forEach((seg, i) => {
    symbolTable.set(seg.offset, {
      name: `data_segment_${i}@${seg.offset}`,
      region: 'data',
      type: 'u8',
      size: seg.bytes.length,
    });
    typeTable.push({
      start: seg.offset,
      end: seg.offset + seg.bytes.length - 1,
      kind: 'data',
      colorHint: '#4fc3f7',
    });
  });

  return { symbolTable, typeTable, commentTable: new Map(), stringTable: new Map(), crossRefTable: new Map() };
}

/**
 * Layer 4 (stringTable): decode printable-ASCII runs in linear memory. Ports
 * `eml-vm16-core.ts`'s `buildStringTable` byte-for-byte in behavior — same
 * "maximal printable run >= minLen" rule — just over a memory buffer that can be
 * larger than 256 bytes (WASM pages are 64 KiB), hence `number` bounds instead of `u8`.
 */
export function buildWasmStringTable(mem: Uint8Array, start = 0, end = mem.length - 1, minLen = 4): Map<number, string> {
  const table = new Map<number, string>();
  let runStart = -1;
  let chars: string[] = [];
  const flush = (): void => {
    if (runStart >= 0 && chars.length >= minLen) table.set(runStart, chars.join(''));
    runStart = -1; chars = [];
  };
  for (let a = start; a <= end; a++) {
    const b = mem[a];
    const printable = b >= 0x20 && b <= 0x7e;
    if (printable) { if (runStart < 0) runStart = a; chars.push(String.fromCharCode(b)); }
    else flush();
  }
  flush();
  return table;
}

/** Encode a code position as a single number so it fits the existing `u8[]`-shaped (`number[]`) CrossRefEntry.callers/dataWriters fields. Documented, reversible, and clearly NOT a memory address. */
export const encodeCodePos = (funcIdx: number, instrIdx: number): number => funcIdx * 1_000_000 + instrIdx;
export const decodeCodePos = (pos: number): { funcIdx: number; instrIdx: number } =>
  ({ funcIdx: Math.floor(pos / 1_000_000), instrIdx: pos % 1_000_000 });

/**
 * Layer 6 (crossRefTable), dynamic: fold a completed run's snapshots into
 * per-address writer provenance. `dataReaders`/`callers` are left empty — our
 * MVP snapshot doesn't yet track which instruction *read* a given address
 * (only `i32.store` sites are attributed here), matching `changed_this_tick`'s
 * existing write-only scope.
 */
export function augmentWasmCrossRef(snapshots: WasmSnapshot[]): Map<number, CrossRefEntry> {
  const table = new Map<number, CrossRefEntry>();
  for (const snap of snapshots) {
    if (snap.changed_this_tick.length === 0) continue;
    const writerPos = encodeCodePos(snap.func_idx, snap.instr_idx);
    for (const c of snap.changed_this_tick) {
      const addr = Number(c.addr.startsWith('0x') ? parseInt(c.addr, 16) : c.addr);
      const entry = table.get(addr) ?? { callers: [], dataReaders: [], dataWriters: [] };
      if (!entry.dataWriters.includes(writerPos)) entry.dataWriters.push(writerPos);
      table.set(addr, entry);
    }
  }
  return table;
}

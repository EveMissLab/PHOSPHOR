/**
 * PHOSPHOR · Headless Snapshot (browser-safe)
 * EML-EAI-2026-v0.5 · the single source of truth for the AI-readable per-tick snapshot
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * This module owns the V_AI projection `Φ : M × CTS → V_AI` and nothing else, so
 * it can be imported from BOTH a Node driver (headless-vm.ts) and the browser
 * human-mode UI (ui/src/PhosphorVM.jsx) without dragging in `process`, `ws`, or
 * the CLI. It depends only on the pure VM core. Extracting it removes the v0.4
 * divergence where the UI re-implemented the builder and silently dropped the
 * `before` field — the grid and the AI stream are now two projections of one M,
 * built by one function.
 *
 * Snapshot-shape contract (three related surfaces an agent may see):
 *   1. HeadlessSnapshot          — this object; arch-neutral (VM-16 u8 + BASIC int).
 *   2. vm:tick stream payload    — headlessSnapshotToStreamFields(snap): the phosphor
 *                                  -stream flattening that renames tick→vm_tick and
 *                                  changed_this_tick→changed (and drops pc_comment).
 *   3. StreamSnapshot (agent)    — eml-vm16-agent.ts; window-aware (window_id/…,
 *                                  stack_depth) and carries no mode/arch. Distinct
 *                                  on purpose: it is produced inside the P5 window
 *                                  manager, which a headless single-VM run has no
 *                                  notion of.
 */

import { hex2, decode, REG_NAMES, type VMFlags, type CTS } from './eml-vm16-core';

export type VMMode = 'ai' | 'human';

/**
 * AI-readable per-tick snapshot. Architecture-neutral: works for both VM-16
 * (Uint8Array cells) and BASIC (Int32Array cells) since both expose
 * ArrayLike<number> memory/registers.
 */
export interface HeadlessSnapshot {
  mode:        VMMode;
  arch:        string;
  vm_id:       string;
  tick:        number;
  pc:          string;
  pc_symbol:   string | null;
  pc_comment:  string | null;
  instruction: string;
  registers:   Record<string, number>;
  flags:       { Z: boolean; N: boolean; G: boolean };
  changed_this_tick: { addr: string; symbol: string | null; before: number; after: number }[];
  halted:      boolean;
}

/**
 * Build a HeadlessSnapshot from a VM state. The state shape is the structural
 * intersection of VMState (Uint8Array) and BasicState (Int32Array); both satisfy
 * ArrayLike<number> for memory/regs, so a single builder serves both archs.
 *
 * `prevMem` (if given) supplies the "before" value for changed cells; otherwise
 * the current value is used for both before/after.
 */
export function buildHeadlessSnapshot(args: {
  id:   string;
  state: {
    memory:  ArrayLike<number>;
    regs:    ArrayLike<number>;
    pc:      number;
    sp:      number;
    flags:   VMFlags;
    ticks:   number;
    halted:  boolean;
    changed: Set<number>;
  };
  mode:    VMMode;
  arch:    string;
  cts?:    Partial<CTS>;
  prevMem?: ArrayLike<number>;
}): HeadlessSnapshot {
  const { id, state, mode, arch, cts, prevMem } = args;
  const mem = state.memory;
  const op  = mem[state.pc] & 0xFF;
  const arg = mem[(state.pc + 1) & 0xFF] & 0xFF;

  const sym = cts?.symbolTable;
  const cmt = cts?.commentTable;

  const changed = [...state.changed].map(addr => ({
    addr:   `0x${hex2(addr)}`,
    symbol: sym?.get(addr)?.name ?? null,
    before: prevMem ? prevMem[addr] : mem[addr],
    after:  mem[addr],
  }));

  const registers: Record<string, number> = {};
  REG_NAMES.forEach((n, i) => { registers[n] = state.regs[i]; });

  return {
    mode,
    arch,
    vm_id:       id,
    tick:        state.ticks,
    pc:          `0x${hex2(state.pc)}`,
    pc_symbol:   sym?.get(state.pc)?.name ?? null,
    pc_comment:  cmt?.get(state.pc) ?? null,
    instruction: decode(op, arg, cts),
    registers,
    flags:       { Z: state.flags.z, N: state.flags.neg, G: state.flags.gt },
    changed_this_tick: changed,
    halted:      state.halted,
  };
}

/**
 * Flatten a HeadlessSnapshot into the `vm:tick` / `vm:halt` phosphor-stream domain
 * payload. This is the canonical (and only) place the field renaming lives, so
 * agents have a single documented contract:
 *   tick              → vm_tick
 *   changed_this_tick → changed
 *   pc_comment        → (dropped; comments are static CTS, not per-tick signal)
 */
export function headlessSnapshotToStreamFields(s: HeadlessSnapshot): Record<string, unknown> {
  return {
    arch:        s.arch,
    mode:        s.mode,
    vm_id:       s.vm_id,
    vm_tick:     s.tick,
    pc:          s.pc,
    pc_symbol:   s.pc_symbol,
    instruction: s.instruction,
    registers:   s.registers,
    flags:       s.flags,
    changed:     s.changed_this_tick,
    halted:      s.halted,
  };
}

/**
 * PHOSPHOR · rpn-snapshot — Φ_rpn : M_rpn × CTS_rpn → V_AI
 * EML-EAI-2026-v0.7
 * EveMissLab（一言諾科技有限公司）· 2026
 *
 * One deliberate convention difference from `headless-snapshot.ts` /
 * `wasm-snapshot.ts`, stated rather than silently diverging: those report the
 * NEXT instruction to run (a `pc`/`instruction` pair that is prospective —
 * hence WasmView.jsx's panel literally being labeled "NEXT"). This snapshot
 * is RETROSPECTIVE — `executed_pc`/`executed_token` name the token that JUST
 * ran this tick, because the point of this retrofit is provenance ("who
 * wrote this variable"), and provenance is inherently a question about the
 * past, not the next step. Different domain, different natural framing;
 * forcing the VM-16/WASM convention here would fit worse, not better.
 */

import type { RpnState } from './rpn-core';
import { decodeToken } from './rpn-core';
import type { RpnCts } from './rpn-cts';

export type RpnMode = 'ai' | 'human';

export interface RpnSnapshot {
  mode: RpnMode;
  arch: 'RPN-CALC';
  vm_id: string;
  tick: number;
  executed_pc: number;
  executed_token: string;
  comment: string | null;
  stack: number[];
  vars: Record<string, number>;
  changed_vars: string[];
  halted: boolean;
}

/**
 * Build a snapshot from the state stepOnce JUST produced (so `state.pc - 1`
 * is always in range for a non-empty program — the caller never calls this
 * before the first tick).
 */
export function buildRpnSnapshot(args: { id: string; state: RpnState; mode: RpnMode; cts?: Partial<RpnCts> }): RpnSnapshot {
  const { id, state, mode, cts } = args;
  const executedPc = state.pc - 1;
  const executedToken = state.tokens[executedPc];
  return {
    mode, arch: 'RPN-CALC', vm_id: id, tick: state.ticks,
    executed_pc: executedPc,
    executed_token: executedToken ? decodeToken(executedToken) : '(none)',
    comment: cts?.comments?.get(executedPc) ?? null,
    stack: [...state.stack],
    vars: { ...state.vars },
    changed_vars: [...state.changedVars],
    halted: state.halted,
  };
}

/** Flatten into `vm:tick`/`vm:halt` phosphor-stream fields — same role as `headlessSnapshotToStreamFields`/`wasmSnapshotToStreamFields`. */
export function rpnSnapshotToStreamFields(s: RpnSnapshot): Record<string, unknown> {
  return {
    arch: s.arch, mode: s.mode, vm_id: s.vm_id, vm_tick: s.tick,
    executed_pc: s.executed_pc, executed_token: s.executed_token,
    stack: s.stack, vars: s.vars, changed: s.changed_vars, halted: s.halted,
  };
}

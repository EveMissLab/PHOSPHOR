/**
 * PHOSPHOR · WASM ⇄ PHOSPHOR-SHEET bridge (v0.6, EXPERIMENTAL)
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * The Phase 2 flagship wiring: turn a `wasmSemanticEquiv` verdict into a
 * `09_Control` row BEFORE it reaches a human — the verdict is what the human
 * reviews, not something computed only after they approve. `phosphor-control.ts`
 * additionally hard-refuses (regardless of the Approved column) any
 * `wasm:apply_optimization` row whose embedded verdict isn't `'equivalent'` —
 * see its `validateArgs` case. This module only builds that row; it has no
 * opinion on approval policy or execution, matching the control plane's own
 * "spreadsheet rows express intent, a host executes" split.
 */

import { wasmSemanticEquiv, type WasmEquivSpec, type WasmEquivResult } from './wasm-semantic';
import type { ControlRow } from '../spreadsheet/phosphor-control.ts';

export interface OptimizationProposal {
  id: string;
  target: string;
  variant: string;
  baseline: Uint8Array;
  candidate: Uint8Array;
  spec: WasmEquivSpec;
  requestedBy: string;
}

export interface ProposedRow {
  row: ControlRow;
  result: WasmEquivResult;
}

/** Judge `candidate` against `baseline`, then package the verdict into a QUEUED (not yet approved) control row ready for human review. */
export function proposeOptimization(p: OptimizationProposal): ProposedRow {
  const result = wasmSemanticEquiv(p.baseline, p.candidate, p.spec);
  const args = {
    variant: p.variant,
    verdict: result.verdict,
    reason: result.reason,
    trials: result.trials,
    distinct_outputs: result.distinctOutputs,
    exhaustive: result.exhaustive,
    ...(result.counterexample ? { counterexample: result.counterexample } : {}),
  };
  const row: ControlRow = {
    command_id: p.id,
    command: 'wasm:apply_optimization',
    target: p.target,
    args_json: JSON.stringify(args),
    requested_by: p.requestedBy,
    approved: false,
    status: 'QUEUED',
    created_at: new Date().toISOString(),
    executed_at: '',
    result_json: '',
    error: '',
  };
  return { row, result };
}

/**
 * PHOSPHOR · WASM Semantic Layer (v0.6, EXPERIMENTAL)
 * EML-EAI-2026-v0.6 · the operational equivalence judge, ported to real WASM
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Same discipline as `eml-semantic.ts`'s `semanticEquiv`, over a genuinely
 * different execution model: WASM functions are called with typed arguments,
 * not "poke a register/memory cell and run to HALT". `wasmSemanticEquiv`
 * adapts the judge to that shape rather than forcing VM-16's register/memory-
 * slot vocabulary onto it — same falsifier discipline, same three-valued
 * verdict, honestly different input surface.
 *
 * One deliberate, stated scope narrowing: VM-16's u8 domain (0–255) IS the
 * entire value space, so `exhaustive` there means a real proof over every
 * possible input. A WASM i32 parameter's value space (2^32) is not something
 * any judge can exhaustively enumerate. `exhaustive` here means "the entire
 * CALLER-DECLARED domain was tested", not "the entire i32 range" — a bounded
 * claim, not the unbounded one the same word carries in eml-semantic.ts. Said
 * once here rather than left to be discovered as an inconsistency.
 *
 * The other real adaptation: two behaviorally-equivalent WASM binaries can
 * legitimately place their data at DIFFERENT linear-memory addresses (the
 * linker decides layout independently per compilation) — so the judge
 * resolves each program's own output location via its own exported
 * `outputPtrExport` function rather than assuming a shared fixed address.
 */

import { parseWasmModule, type WasmModule } from './wasm-binary';
import { makeWasmState, stepOnce, resolveExportedFunc, type WasmState } from './wasm-interp';
import type { Emitter } from '../stream/phosphor-stream';

export type Verdict = 'equivalent' | 'not-equivalent' | 'inexpressible';

export interface WasmEquivSpec {
  /** Exported function to call with the input vector, e.g. 'main'. Must take only i32 params. */
  entry: string;
  /** Number of i32 parameters `entry` takes — also the dimensionality of each input vector. */
  paramCount: number;
  /** Exported i32-returning function that locates the observed memory region. Resolved once PER PROGRAM (layouts can legitimately differ between two equivalent binaries). */
  outputPtrExport: string;
  /** How many bytes to read starting at outputPtrExport()'s return, given the input vector that produced it. */
  outputBytes: (input: number[]) => number;
  /** Bounded input domain to sweep (NOT the entire i32 range — see module doc). */
  domain?: number[];
  /** Extra full-domain-range mixed vectors when the space isn't exhaustively covered. */
  mixedTrials?: number;
  /** Refuse (inexpressible) if either program runs longer than this. Default 200_000. */
  maxSteps?: number;
  /** Force exhaustive enumeration of `domain^paramCount` when it's small enough. */
  exhaustive?: boolean;
}

export interface WasmEquivInputCase { input: number[]; outputA: string; outputB: string; }

export interface WasmEquivResult {
  verdict: Verdict;
  reason: string;
  trials: number;
  distinctOutputs: number;
  exhaustive: boolean;   // ⟺ the DECLARED domain was fully covered — see module doc
  counterexample?: WasmEquivInputCase;
}

const DEFAULT_DOMAIN = [0, 1, 2, 3, 5, 8, 10, 15, 20, 30];
const EXHAUSTIVE_CAP = 20_000; // vectors; keeps exhaustive sweeps cheap for small paramCount/domain

function buildInputVectors(
  paramCount: number, domain: number[], mixedTrials: number, forceExhaustive: boolean,
): { vectors: number[][]; exhaustive: boolean } {
  const space = Math.pow(domain.length, paramCount);
  if ((forceExhaustive || paramCount <= 1) && space <= EXHAUSTIVE_CAP) {
    const vectors: number[][] = [];
    const rec = (prefix: number[]): void => {
      if (prefix.length === paramCount) { vectors.push(prefix.slice()); return; }
      for (const v of domain) rec([...prefix, v]);
    };
    rec([]);
    return { vectors, exhaustive: true };
  }

  const vectors: number[][] = [];
  for (const v of domain) vectors.push(new Array(paramCount).fill(v));  // boundary sweep
  let state = 0x9e3779b1 >>> 0;
  const next = (): number => (state = (1664525 * state + 1013904223) >>> 0);
  const maxDomain = Math.max(...domain, 1);
  for (let t = 0; t < mixedTrials; t++) {
    const v: number[] = [];
    for (let k = 0; k < paramCount; k++) v.push(next() % (maxDomain + 1));
    vectors.push(v);
  }
  return { vectors, exhaustive: false };
}

function findOutputPtr(module: WasmModule, exportName: string): number | null {
  let funcIdx: number;
  try { funcIdx = resolveExportedFunc(module, exportName); } catch { return null; }
  let s = makeWasmState(module, funcIdx, []);
  let guard = 0;
  while (!s.halted && guard++ < 100_000) s = stepOnce(s);
  return s.halted ? (s.result?.[0] ?? null) : null;
}

function runAndObserve(
  module: WasmModule, outPtr: number, spec: WasmEquivSpec, input: number[], maxSteps: number,
): { halted: boolean; output: string } {
  let s = makeWasmState(module, spec.entry, input);
  let steps = 0;
  while (!s.halted && steps++ < maxSteps) s = stepOnce(s);
  if (!s.halted) return { halted: false, output: '' };

  const n = spec.outputBytes(input);
  const view = new DataView(s.memory.buffer, s.memory.byteOffset, s.memory.byteLength);
  const bytes: number[] = [];
  for (let i = 0; i < n; i++) bytes.push(view.getUint8(outPtr + i));
  const resultTail = s.result ?? [];
  return { halted: true, output: `${bytes.join(',')}|ret:${resultTail.join(',')}` };
}

/**
 * Judge whether two real WASM byte sequences are semantically equivalent under
 * `spec`: call `entry` on both with every input vector, compare the observed
 * memory region (+ return values). Optionally emits a self-validating
 * `vm:equiv` phosphor-stream event, same contract as `semanticEquiv`.
 */
export function wasmSemanticEquiv(bytesA: Uint8Array, bytesB: Uint8Array, spec: WasmEquivSpec, emitter?: Emitter): WasmEquivResult {
  const maxSteps = spec.maxSteps ?? 200_000;
  const domain = spec.domain ?? DEFAULT_DOMAIN;
  const mixedTrials = spec.mixedTrials ?? Math.max(32, domain.length * 2);

  const emit = (result: WasmEquivResult): WasmEquivResult => {
    emitter?.check('vm:equiv', result.verdict, 'equivalent', {
      reason: result.reason, trials: result.trials, distinct_outputs: result.distinctOutputs,
      exhaustive: result.exhaustive,
      ...(result.counterexample ? { counterexample: result.counterexample } : {}),
    });
    return result;
  };

  let modA: WasmModule, modB: WasmModule;
  try { modA = parseWasmModule(bytesA); modB = parseWasmModule(bytesB); }
  catch (e: any) {
    return emit({ verdict: 'inexpressible', reason: `refuse: parse failure — ${e.message}`, trials: 0, distinctOutputs: 0, exhaustive: false });
  }

  const ptrA = findOutputPtr(modA, spec.outputPtrExport);
  const ptrB = findOutputPtr(modB, spec.outputPtrExport);
  if (ptrA === null || ptrB === null) {
    return emit({
      verdict: 'inexpressible',
      reason: `refuse: could not resolve '${spec.outputPtrExport}()' on ${ptrA === null ? 'A' : 'B'}`,
      trials: 0, distinctOutputs: 0, exhaustive: false,
    });
  }

  const { vectors, exhaustive } = buildInputVectors(spec.paramCount, domain, mixedTrials, !!spec.exhaustive);
  const distinct = new Set<string>();
  let ran = 0;

  for (const v of vectors) {
    ran++;
    const ra = runAndObserve(modA, ptrA, spec, v, maxSteps);
    const rb = runAndObserve(modB, ptrB, spec, v, maxSteps);

    if (!ra.halted || !rb.halted) {
      return emit({
        verdict: 'inexpressible',
        reason: `refuse: ${!ra.halted ? 'A' : 'B'} did not terminate within ${maxSteps} steps (input ${JSON.stringify(v)})`,
        trials: ran, distinctOutputs: distinct.size, exhaustive,
      });
    }

    if (ra.output !== rb.output) {
      return emit({
        verdict: 'not-equivalent',
        reason: 'a discriminating input produced different observable output',
        trials: ran, distinctOutputs: new Set([...distinct, ra.output]).size, exhaustive,
        counterexample: { input: [...v], outputA: ra.output, outputB: rb.output },
      });
    }
    distinct.add(ra.output);
  }

  if (distinct.size < 2) {
    return emit({
      verdict: 'inexpressible',
      reason: `refuse: inputs did not discriminate (need ≥2 distinct outputs, saw ${distinct.size}); agreement is not evidence`,
      trials: ran, distinctOutputs: distinct.size, exhaustive,
    });
  }
  return emit({
    verdict: 'equivalent',
    reason: exhaustive
      ? `proof over the declared domain: agreed on all ${ran} vectors (domain=${JSON.stringify(domain)}) across ${distinct.size} distinct outputs`
      : `agreed on all ${ran} sampled inputs across ${distinct.size} distinct outputs (sampled, not exhaustive)`,
    trials: ran, distinctOutputs: distinct.size, exhaustive,
  });
}

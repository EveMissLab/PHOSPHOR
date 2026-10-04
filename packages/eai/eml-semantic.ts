/**
 * PHOSPHOR · Semantic Layer (v0.5, EXPERIMENTAL)
 * EML-EAI-2026-v0.5 · the semantic↔machine-code layer, operational form
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * v0.5's headline goal — "an agent can reason about what code *means*, not just
 * what it *does*; and two byte sequences can be judged semantically equivalent" —
 * realized OPERATIONALLY rather than via a Hoare/denotational calculus. This is a
 * deliberate, documented choice: EML (the sibling project) explicitly abandoned
 * axiomatic proof and established equivalence by EXECUTION — run both, compare
 * observable output — and that hard-won "execution truth" is what we port here.
 * Hoare-style proof is left to a later release.
 *
 * Two pieces:
 *   1. describeEffect(op, arg) — the per-instruction state-transition meaning
 *      (reads / writes / flags / control / memory). This is the formal mapping
 *      "machine code → state transition" one layer deeper than CTS's opcode names.
 *   2. semanticEquiv(codeA, codeB, spec) — the equivalence JUDGE. It ports EML's
 *      `validateEquivalence` discipline:
 *        · it generates its OWN adversarial input vectors — boundary edges plus
 *          FULL-RANGE [0,255] mixed values — never trusting a single (all-zero)
 *          input, and never confined to a curated pool;
 *        · for a single input slot it is EXHAUSTIVE (all 256 values), so an
 *          `equivalent` verdict is then a genuine proof over the input space; for
 *          more slots it samples and reports `exhaustive: false` — `equivalent`
 *          is then "equivalent on the tested inputs", not a universal proof;
 *        · it REQUIRES the inputs to discriminate (≥2 distinct observed outputs)
 *          before certifying equivalence — agreement on a degenerate (all-same-
 *          output) input set is rejected as non-evidence (this guards against
 *          degeneracy, NOT against incomplete coverage);
 *        · it refuses mem input/output slots that alias a CODE region (a poke
 *          there would corrupt instructions, asymmetrically across unequal-length
 *          programs) — returning `inexpressible` rather than a corrupt verdict;
 *        · three-valued — equivalent / not-equivalent / inexpressible — refusing
 *          rather than guessing on non-termination or non-discrimination.
 *      Determinism is free: the VM core has no clock and no randomness, so a
 *      verdict is reproducible from (codeA, codeB, spec) alone.
 *
 *      Honest scope: this is a FALSIFIER. A `not-equivalent` verdict is sound (it
 *      carries a concrete counterexample); an `equivalent` verdict is a proof only
 *      when `exhaustive`, otherwise a high-coverage bounded test. Hoare/denotational
 *      proof of universal equivalence is deferred (see EML-EAI-2026-v0.5.md §6.3).
 */

import {
  type u8, type Flag, type VMState, type ProgramDefinition,
  makeVMState, stepOnce, decode, hex2, REG_NAMES,
} from './eml-vm16-core';
import type { Emitter } from './stream/phosphor-stream';

// ═══════════════════════════════════════════════════════════════════════════════
// § 1. Per-instruction operational semantics — describeEffect
// ═══════════════════════════════════════════════════════════════════════════════

/** A read/written location: a register (index 0–7) or a memory cell (addr 0–255). */
export interface SemSlot { kind: 'reg' | 'mem'; index: u8; }

export type ControlKind = 'fallthrough' | 'jump' | 'cond-jump' | 'call' | 'ret' | 'halt';

/** The state-transition meaning of one instruction (its operational semantics). */
export interface InstrEffect {
  mnemonic:   string;
  reads:      SemSlot[];                 // registers read (statically known)
  writes:     SemSlot[];                 // registers written (statically known)
  readsFlags: Flag[];                    // flags consumed (conditional jumps)
  flags:      Flag[];                    // flags written
  mem:        'none' | 'read' | 'write'; // memory access (address may be dynamic)
  control:    ControlKind;
  summary:    string;                    // human/AI-readable state transition
}

const reg = (i: u8): SemSlot => ({ kind: 'reg', index: (i & 7) as u8 });

/**
 * Resolve the operational semantics of one instruction `[op][arg]`.
 * `arg = [d:4 | s/imm:4]`. Memory addresses for LD/ST are register-indirect and
 * therefore dynamic — `mem` records the access kind; the live address is captured
 * at run time by `effectiveAccess` in the core.
 */
export function describeEffect(op: u8, arg: u8): InstrEffect {
  const d  = (arg >> 4) & 0xF;
  const s  = arg & 0xF;
  const R  = (i: number) => REG_NAMES[i & 7];
  const base = (over: Partial<InstrEffect>): InstrEffect => ({
    mnemonic: decode(op, arg).split(' ')[0],
    reads: [], writes: [], readsFlags: [], flags: [], mem: 'none', control: 'fallthrough',
    summary: decode(op, arg),
    ...over,
  });

  switch (op) {
    case 0x00: return base({ summary: 'no operation' });
    case 0x01: return base({ control: 'halt', summary: 'halt execution' });

    case 0x10: return base({ reads: [reg(s)], writes: [reg(d)], summary: `${R(d)} ← ${R(s)}` });
    case 0x11: return base({ writes: [reg(d)], summary: `${R(d)} ← #${s}` });

    case 0x20: return base({ reads: [reg(d), reg(s)], writes: [reg(d)], summary: `${R(d)} ← (${R(d)} + ${R(s)}) mod 256` });
    case 0x21: return base({ reads: [reg(d)], writes: [reg(d)], summary: `${R(d)} ← (${R(d)} + #${s}) mod 256` });
    case 0x22: return base({ reads: [reg(d), reg(s)], writes: [reg(d)], summary: `${R(d)} ← (${R(d)} − ${R(s)}) mod 256` });
    case 0x23: return base({ reads: [reg(d)], writes: [reg(d)], summary: `${R(d)} ← (${R(d)} − #${s}) mod 256` });

    case 0x30: return base({ reads: [reg(d), reg(s)], writes: [reg(d)], summary: `${R(d)} ← ${R(d)} & ${R(s)}` });
    case 0x31: return base({ reads: [reg(d), reg(s)], writes: [reg(d)], summary: `${R(d)} ← ${R(d)} | ${R(s)}` });
    case 0x32: return base({ reads: [reg(d), reg(s)], writes: [reg(d)], summary: `${R(d)} ← ${R(d)} ^ ${R(s)}` });
    case 0x33: return base({ reads: [reg(d)], writes: [reg(d)], summary: `${R(d)} ← ~${R(d)} (mod 256)` });

    case 0x40: return base({ reads: [reg(d), reg(s)], flags: ['Z', 'N', 'G'], summary: `FLAGS ← cmp(${R(d)}, ${R(s)})` });
    case 0x41: return base({ reads: [reg(d)], writes: [reg(d)], summary: `${R(d)} ← (${R(d)} + 1) mod 256` });
    case 0x42: return base({ reads: [reg(d)], writes: [reg(d)], summary: `${R(d)} ← (${R(d)} − 1) mod 256` });

    case 0x50: return base({ control: 'jump',      summary: `PC ← 0x${hex2(arg)}` });
    case 0x51: return base({ control: 'cond-jump', readsFlags: ['Z'], summary: `if Z: PC ← 0x${hex2(arg)}` });
    case 0x52: return base({ control: 'cond-jump', readsFlags: ['Z'], summary: `if ¬Z: PC ← 0x${hex2(arg)}` });
    case 0x53: return base({ control: 'cond-jump', readsFlags: ['G'], summary: `if G: PC ← 0x${hex2(arg)}` });
    case 0x54: return base({ control: 'cond-jump', readsFlags: ['N'], summary: `if N: PC ← 0x${hex2(arg)}` });
    case 0x55: return base({ control: 'cond-jump', readsFlags: ['N'], summary: `if ¬N: PC ← 0x${hex2(arg)}` });
    case 0x56: return base({ control: 'cond-jump', readsFlags: ['G'], summary: `if ¬G: PC ← 0x${hex2(arg)}` });

    case 0x60: return base({ reads: [reg(d)], mem: 'write', summary: `MEM[SP] ← ${R(d)}; SP−−` });
    case 0x61: return base({ writes: [reg(d)], mem: 'read',  summary: `SP++; ${R(d)} ← MEM[SP]` });
    case 0x70: return base({ control: 'call', mem: 'write', summary: `push PC; PC ← 0x${hex2(arg)}` });
    case 0x71: return base({ control: 'ret',  mem: 'read',  summary: `pop PC` });

    case 0x80: return base({ reads: [reg(s)], writes: [reg(d)], mem: 'read',  summary: `${R(d)} ← MEM[${R(s)}]` });
    case 0x81: return base({ reads: [reg(d), reg(s)],          mem: 'write', summary: `MEM[${R(d)}] ← ${R(s)}` });

    default:   return base({ mnemonic: '???', summary: `unknown opcode 0x${hex2(op)}` });
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 2. Operational equivalence judge — semanticEquiv
// ═══════════════════════════════════════════════════════════════════════════════

export type Verdict = 'equivalent' | 'not-equivalent' | 'inexpressible';

export interface EquivSpec {
  /** Where inputs are injected before each run (registers and/or data cells). */
  inputs:  SemSlot[];
  /** What is observed after the run to form the output signature. */
  outputs: SemSlot[];
  /** Also fold the Z/N/G flags into the observed output. Default false. */
  observeFlags?: boolean;
  /** Refuse (inexpressible) if either program runs longer than this. Default 100_000. */
  maxSteps?: number;
  /** Boundary edge values to always sweep, in addition to full-range mixed sampling. */
  inputDomain?: u8[];
  /** Number of full-range mixed vectors (used when the space is not exhausted). */
  mixedTrials?: number;
  /** Force exhaustive enumeration of the whole input space when it is ≤ 65536 vectors. */
  exhaustive?: boolean;
}

export interface EquivInputCase { input: number[]; outputA: string; outputB: string; }

export interface EquivResult {
  verdict:         Verdict;
  reason:          string;
  trials:          number;        // input vectors actually run (≤ the generated set; early-abort stops sooner)
  distinctOutputs: number;        // distinct output signatures observed (discrimination)
  exhaustive:      boolean;       // true ⟺ the generated vector set spanned the ENTIRE input space;
                                   // combined with verdict 'equivalent' this means a proof over all inputs
  counterexample?: EquivInputCase;
}

/** Boundary edge values always swept (full-range mixed sampling covers the rest). */
const DEFAULT_DOMAIN: u8[] = [0, 1, 2, 3, 5, 7, 8, 15, 16, 31, 63, 100, 127, 128, 200, 254, 255];

/** Largest input space (256^nSlots) we will enumerate exhaustively. */
const EXHAUSTIVE_CAP = 65536;   // ⇒ exhaustive by default for 1 slot (256); opt-in for 2 (65536)

function programFor(code: u8[]): ProgramDefinition {
  return { id: 'equiv', label: 'EQUIV', description: '', code: [...code], initMem: {}, cts: {} };
}

/** Run `code` with `inputs` set to `values`, to HALT or `maxSteps`. */
function runWithInput(code: u8[], inputs: SemSlot[], values: u8[], maxSteps: number): { halted: boolean; state: VMState } {
  let s = makeVMState(programFor(code));
  const regs = new Uint8Array(s.regs);
  const mem  = new Uint8Array(s.memory);
  inputs.forEach((slot, i) => {
    const v = values[i] & 0xFF;
    if (slot.kind === 'reg') regs[slot.index & 7] = v;
    else                     mem[slot.index & 0xFF] = v;
  });
  s = { ...s, regs, memory: mem };

  for (let i = 0; i < maxSteps && !s.halted; i++) s = stepOnce(s);
  return { halted: s.halted, state: s };
}

/** Canonical output signature of a halted state over the observed slots. */
function observe(state: VMState, outputs: SemSlot[], observeFlags: boolean): string {
  const parts = outputs.map(slot =>
    slot.kind === 'reg' ? state.regs[slot.index & 7] : state.memory[slot.index & 0xFF]);
  if (observeFlags) parts.push(state.flags.z ? 1 : 0, state.flags.neg ? 1 : 0, state.flags.gt ? 1 : 0);
  return parts.join(',');
}

/**
 * Build input vectors for the judge.
 *   · EXHAUSTIVE when the whole space (256^nSlots) is ≤ EXHAUSTIVE_CAP and either
 *     nSlots ≤ 1 (256 values, cheap) or the caller forced it. An `equivalent`
 *     verdict over an exhaustive set is a genuine proof over the input space.
 *   · Otherwise SAMPLED: a boundary edge SWEEP (every slot = the same edge value —
 *     alone this discriminates ADD vs MOV at value 1: 2 vs 1) PLUS deterministic
 *     LCG MIXED vectors drawn from the FULL [0,255] range (not a curated pool), so
 *     non-equivalence on an arbitrary value like 42 can still surface.
 * Deterministic (fixed seed) → reproducible verdicts.
 */
function buildInputVectors(
  nSlots: number, domain: u8[], mixedTrials: number, forceExhaustive: boolean,
): { vectors: u8[][]; exhaustive: boolean } {
  const space = Math.pow(256, nSlots);
  if ((forceExhaustive || nSlots <= 1) && nSlots >= 1 && space <= EXHAUSTIVE_CAP) {
    const vectors: u8[][] = [];
    const rec = (prefix: u8[]): void => {
      if (prefix.length === nSlots) { vectors.push(prefix.slice()); return; }
      for (let v = 0; v < 256; v++) rec([...prefix, v as u8]);
    };
    rec([]);
    return { vectors, exhaustive: true };
  }

  const vectors: u8[][] = [];
  for (const v of domain) vectors.push(new Array(nSlots).fill(v) as u8[]);   // boundary sweep
  let state = 0x9e3779b1 >>> 0;                                              // LCG, fixed seed
  const next = (): number => (state = (1664525 * state + 1013904223) >>> 0);
  for (let t = 0; t < mixedTrials; t++) {
    const v: u8[] = [];
    for (let k = 0; k < nSlots; k++) v.push((next() & 0xFF) as u8);          // FULL [0,255] range
    vectors.push(v);
  }
  return { vectors, exhaustive: false };
}

/**
 * Judge whether two machine-code byte sequences are semantically equivalent under
 * `spec`, by running both on every adversarial input and comparing the observed
 * output. Optionally emits a self-validating `vm:equiv` phosphor-stream event
 * (the bytecode analog of EML's `eml:equiv` execution-truth check).
 */
export function semanticEquiv(codeA: u8[], codeB: u8[], spec: EquivSpec, emitter?: Emitter): EquivResult {
  const maxSteps    = spec.maxSteps ?? 100_000;
  const domain      = spec.inputDomain ?? DEFAULT_DOMAIN;
  const observeFlags = !!spec.observeFlags;
  const mixedTrials = spec.mixedTrials ?? Math.max(64, domain.length);

  const emit = (result: EquivResult): EquivResult => {
    // Self-validating trace: ok ⟺ certified equivalent (mirrors eml:equiv).
    emitter?.check('vm:equiv', result.verdict, 'equivalent', {
      reason: result.reason,
      trials: result.trials,
      distinct_outputs: result.distinctOutputs,
      exhaustive: result.exhaustive,
      ...(result.counterexample ? { counterexample: result.counterexample } : {}),
    });
    return result;
  };

  // Guard: a `mem` slot inside either program's CODE region would have its poke
  // corrupt instructions (asymmetrically, since the programs differ in length) or,
  // for outputs, return an instruction byte instead of a computed value. The data
  // region (≥ dataFloor) is zero-initialised identically in both runs, so refusing
  // below it eliminates code-encoding artifacts. Fail loud rather than mis-judge.
  const dataFloor = Math.max(codeA.length, codeB.length);
  const bad = [...spec.inputs, ...spec.outputs].find(s => s.kind === 'mem' && (s.index & 0xFF) < dataFloor);
  if (bad) {
    return emit({
      verdict: 'inexpressible',
      reason: `refuse: mem slot 0x${hex2(bad.index)} aliases a code region (data floor 0x${hex2(dataFloor)}); choose a data-region cell`,
      trials: 0, distinctOutputs: 0, exhaustive: false,
    });
  }

  const { vectors, exhaustive } = buildInputVectors(spec.inputs.length, domain, mixedTrials, !!spec.exhaustive);
  const distinct = new Set<string>();
  let ran = 0;   // vectors actually executed (early-abort paths stop before the full set)

  for (const v of vectors) {
    ran++;
    const ra = runWithInput(codeA, spec.inputs, v, maxSteps);
    const rb = runWithInput(codeB, spec.inputs, v, maxSteps);

    if (!ra.halted || !rb.halted) {
      return emit({
        verdict: 'inexpressible',
        reason: `refuse: ${!ra.halted ? 'A' : 'B'} did not terminate within ${maxSteps} steps`,
        trials: ran, distinctOutputs: distinct.size, exhaustive,
      });
    }

    const oa = observe(ra.state, spec.outputs, observeFlags);
    const ob = observe(rb.state, spec.outputs, observeFlags);
    if (oa !== ob) {
      return emit({
        verdict: 'not-equivalent',
        reason: 'a discriminating input produced different observable output',
        trials: ran, distinctOutputs: new Set([...distinct, oa]).size, exhaustive,
        counterexample: { input: [...v], outputA: oa, outputB: ob },
      });
    }
    distinct.add(oa);
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
      ? `proof: agreed on the ENTIRE input space (${ran} vectors) across ${distinct.size} distinct outputs`
      : `agreed on all ${ran} sampled inputs across ${distinct.size} distinct outputs (sampled, not exhaustive)`,
    trials: ran, distinctOutputs: distinct.size, exhaustive,
  });
}

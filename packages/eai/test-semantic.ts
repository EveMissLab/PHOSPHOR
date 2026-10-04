/**
 * PHOSPHOR · Semantic Layer — verification harness
 * EML-EAI-2026-v0.5 · EXPERIMENTAL
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 *   run:  npm run verify:semantic   (== npx tsx test-semantic.ts)
 *
 * Verifies the operational semantic layer (eml-semantic.ts):
 *   · describeEffect — per-instruction state-transition meaning;
 *   · semanticEquiv — the three-valued run-and-compare equivalence judge, with the
 *     ported EML discipline: adversarial inputs, the ≥2-distinct-output guard, and
 *     fail-loud refusal (inexpressible) on non-termination / non-discrimination.
 */

import {
  describeEffect, semanticEquiv,
  type SemSlot, type EquivSpec,
} from './eml-semantic';
import { createEmitter, memorySink, findAnomalies } from './stream/phosphor-stream';

let passed = 0, failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  ${detail}` : ''}`); }
}
const head = (t: string) => console.log(`\n\x1b[36m${t}\x1b[0m`);

const r = (i: number): SemSlot => ({ kind: 'reg', index: i as any });

// ── Byte sequences (arg = [d:4|s:4]) ─────────────────────────────────────────
const ADD_R0_R1 = [0x20, 0x01, 0x01, 0x00];                          // R0 ← R0 + R1
const ADD_COMMUTED = [0x10, 0x20, 0x10, 0x01, 0x20, 0x02, 0x01, 0x00]; // R2←R0; R0←R1; R0←R1+R2  (= R0+R1)
const SUB_R0_R1 = [0x22, 0x01, 0x01, 0x00];                          // R0 ← R0 − R1
const MOV_R0_R1 = [0x10, 0x01, 0x01, 0x00];                          // R0 ← R1
const CONST0_MOVI = [0x11, 0x00, 0x01, 0x00];                        // R0 ← #0
const CONST0_SUB  = [0x22, 0x00, 0x01, 0x00];                        // R0 ← R0 − R0  (= 0)
const INFINITE    = [0x50, 0x00];                                    // JMP 0 (never halts)

const SPEC: EquivSpec = { inputs: [r(0), r(1)], outputs: [r(0)] };
const SPEC1: EquivSpec = { inputs: [r(0)], outputs: [r(0)] };           // single input ⇒ exhaustive

// B outputs 1 iff R0 == 4, else 0 — diverges from "always 0" ONLY at value 4,
// which is NOT in the old curated DEFAULT_DOMAIN. Exhaustive 1-input sweep finds it.
const DIVERGE_AT_4 = [0x11,0x14, 0x40,0x01, 0x51,0x0A, 0x11,0x00, 0x50,0x0C, 0x11,0x01, 0x01,0x00];
const IDENTITY    = [0x01, 0x00];                                       // HALT ⇒ R0 unchanged (= input)
const DOUBLE_NOT  = [0x33, 0x00, 0x33, 0x00, 0x01, 0x00];               // NOT;NOT;HALT ⇒ identity
// Two different encodings that both store R0 into data cell 0x10 (R1 := 16 two ways).
const STORE_A = [0x11,0x1F, 0x41,0x10, 0x81,0x10, 0x01,0x00];           // MOVI R1,#15; INC R1; ST [R1],R0
const STORE_B = [0x11,0x18, 0x20,0x11, 0x81,0x10, 0x01,0x00];           // MOVI R1,#8;  ADD R1,R1; ST [R1],R0

function main(): void {
  console.log('\x1b[1m\nPHOSPHOR · Semantic Layer — verification (v0.5 EXPERIMENTAL)\x1b[0m');

  // ── describeEffect — operational semantics ───────────────────────────────────
  head('describeEffect · machine code → state transition');
  {
    const add = describeEffect(0x20, 0x01);
    check('ADD reads R0,R1 and writes R0', add.mnemonic === 'ADD'
      && add.reads.length === 2 && add.reads[0].index === 0 && add.reads[1].index === 1
      && add.writes.length === 1 && add.writes[0].index === 0 && add.mem === 'none', add.summary);

    const cmp = describeEffect(0x40, 0x01);
    check('CMP writes flags Z,N,G and no register', cmp.flags.join('') === 'ZNG' && cmp.writes.length === 0, cmp.summary);

    const jz = describeEffect(0x51, 0x1A);
    check('JZ is a cond-jump that reads Z', jz.control === 'cond-jump' && jz.readsFlags.join('') === 'Z', jz.summary);

    check('JMP is an unconditional jump', describeEffect(0x50, 0x1A).control === 'jump');
    check('HALT is halt', describeEffect(0x01, 0x00).control === 'halt');
    const ld = describeEffect(0x80, 0x01);
    check('LD reads R1 (addr), writes R0, mem=read', ld.mem === 'read' && ld.reads[0].index === 1 && ld.writes[0].index === 0, ld.summary);
    const st = describeEffect(0x81, 0x01);
    check('ST reads R0(addr),R1, mem=write', st.mem === 'write' && st.reads.length === 2, st.summary);
  }

  // ── semanticEquiv · equivalent (different bytes, same effect) ─────────────────
  head('semanticEquiv · equivalent byte sequences');
  {
    const res = semanticEquiv(ADD_R0_R1, ADD_COMMUTED, SPEC);
    check('ADD R0,R1 ≡ commuted recompute → equivalent', res.verdict === 'equivalent', res.reason);
    check('certification required ≥2 distinct outputs', res.distinctOutputs >= 2, `distinct=${res.distinctOutputs}`);
  }

  // ── semanticEquiv · not-equivalent (with counterexample) ─────────────────────
  head('semanticEquiv · not-equivalent');
  {
    const res = semanticEquiv(ADD_R0_R1, SUB_R0_R1, SPEC);
    check('ADD vs SUB → not-equivalent', res.verdict === 'not-equivalent', res.reason);
    check('a discriminating counterexample is reported',
      !!res.counterexample && res.counterexample.outputA !== res.counterexample.outputB,
      JSON.stringify(res.counterexample));
  }

  // ── The adversarial-input discipline (the crux ported from EML) ──────────────
  head('semanticEquiv · does NOT trust a degenerate input');
  {
    // ADD R0,R1 and MOV R0,R1 AGREE when R0=0 (both → R1). A judge that only tried
    // the all-zero input would wrongly certify them. The boundary sweep tries
    // R0=R1=1 (ADD→2, MOV→1) and catches it.
    const res = semanticEquiv(ADD_R0_R1, MOV_R0_R1, SPEC);
    check('ADD vs MOV(R0←R1) → not-equivalent (zero-input agreement rejected)',
      res.verdict === 'not-equivalent', res.reason);
  }

  // ── Three-valued refusal · inexpressible ─────────────────────────────────────
  head('semanticEquiv · inexpressible (fail-loud, never guess)');
  {
    const nonterm = semanticEquiv(ADD_R0_R1, INFINITE, { ...SPEC, maxSteps: 64 });
    check('non-terminating program → inexpressible', nonterm.verdict === 'inexpressible', nonterm.reason);

    // Both programs constant-0 ⇒ outputs never discriminate ⇒ refuse rather than
    // falsely certify "equivalent" on agreement-without-evidence.
    const nondiscrim = semanticEquiv(CONST0_MOVI, CONST0_SUB, SPEC);
    check('non-discriminating outputs → inexpressible (≥2-distinct guard)',
      nondiscrim.verdict === 'inexpressible' && nondiscrim.distinctOutputs < 2, nondiscrim.reason);
  }

  // ── Self-validating trace (vm:equiv, the bytecode analog of eml:equiv) ────────
  head('semanticEquiv · self-validating vm:equiv event');
  {
    const sink = memorySink();
    const em = createEmitter({ stream: 'phosphor', sink });
    semanticEquiv(ADD_R0_R1, ADD_COMMUTED, SPEC, em);   // equivalent → ok:true
    semanticEquiv(ADD_R0_R1, SUB_R0_R1, SPEC, em);      // not-equivalent → ok:false
    const evts = sink.events.filter(e => e.type === 'vm:equiv');
    check('two vm:equiv events emitted', evts.length === 2, `n=${evts.length}`);
    check('equivalent verdict → ok:true', evts[0].ok === true && evts[0].actual === 'equivalent');
    check('not-equivalent verdict → ok:false', evts[1].ok === false && evts[1].actual === 'not-equivalent');
    check('findAnomalies flags the non-equivalent verdict', findAnomalies(sink.events).some(e => e.type === 'vm:equiv' && e.ok === false));
  }

  // ── Soundness fixes (post adversarial review) ────────────────────────────────
  head('semanticEquiv · code-region guard (mem slot cannot alias instructions)');
  {
    // mem INPUT inside code would corrupt instructions asymmetrically across
    // unequal-length programs → must refuse, not mis-judge.
    const inGuard = semanticEquiv(ADD_R0_R1, ADD_COMMUTED, { inputs: [{ kind: 'mem', index: 1 }], outputs: [r(0)] });
    check('mem INPUT inside code region → inexpressible',
      inGuard.verdict === 'inexpressible' && inGuard.reason.includes('code region'), inGuard.reason);
    // mem OUTPUT inside code would observe an instruction byte, not a value.
    const outGuard = semanticEquiv(ADD_R0_R1, ADD_COMMUTED, { inputs: [r(0)], outputs: [{ kind: 'mem', index: 2 }] });
    check('mem OUTPUT inside code region → inexpressible',
      outGuard.verdict === 'inexpressible' && outGuard.reason.includes('code region'), outGuard.reason);
    // A data-region mem slot (≥ dataFloor) is fine and fully exercised.
    const dataOk = semanticEquiv(STORE_A, STORE_B, { inputs: [r(0)], outputs: [{ kind: 'mem', index: 0x10 }] });
    check('two encodings storing R0→MEM[0x10] are equivalent (data-region slot)',
      dataOk.verdict === 'equivalent' && dataOk.exhaustive === true, dataOk.reason);
  }

  head('semanticEquiv · full coverage (single input is exhaustive — a real proof)');
  {
    // The crux fix: a divergence only at value 4 (NOT in DEFAULT_DOMAIN) would slip
    // past a curated-pool sampler. Exhaustive 1-input enumeration catches it.
    const caught = semanticEquiv(CONST0_MOVI, DIVERGE_AT_4, SPEC1);
    check('divergence at non-domain value 4 is caught (no false equivalent)',
      caught.verdict === 'not-equivalent' && !!caught.counterexample && caught.counterexample.input[0] === 4,
      JSON.stringify(caught.counterexample));
    check('single-input verdict is marked exhaustive', caught.exhaustive === true);

    const proof = semanticEquiv(IDENTITY, DOUBLE_NOT, SPEC1);
    check('identity ≡ double-NOT is an EXHAUSTIVE proof over all 256 inputs',
      proof.verdict === 'equivalent' && proof.exhaustive === true && proof.trials === 256, proof.reason);

    // A multi-input equivalent verdict must NOT claim to be a proof.
    const sampled = semanticEquiv(ADD_R0_R1, ADD_COMMUTED, SPEC);
    check('two-input equivalent is honestly marked NON-exhaustive (sampled)',
      sampled.verdict === 'equivalent' && sampled.exhaustive === false, sampled.reason);
  }

  // ── Determinism (reproducible verdicts) ──────────────────────────────────────
  head('semanticEquiv · deterministic');
  {
    const a = semanticEquiv(ADD_R0_R1, ADD_COMMUTED, SPEC);
    const b = semanticEquiv(ADD_R0_R1, ADD_COMMUTED, SPEC);
    check('same inputs → identical verdict + distinct count',
      a.verdict === b.verdict && a.distinctOutputs === b.distinctOutputs && a.trials === b.trials);
  }

  console.log('\x1b[1m\n── Summary ──\x1b[0m');
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\x1b[31m  failures: ' + failures.join('; ') + '\x1b[0m');
    process.exitCode = 1;
  } else {
    console.log('\x1b[32m  semantic layer verified — operational equivalence judge sound\x1b[0m');
  }
}

main();

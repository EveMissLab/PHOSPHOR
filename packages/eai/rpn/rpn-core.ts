/**
 * PHOSPHOR · rpn-core — the second Tier 1 retrofit target (v0.7, EXPERIMENTAL)
 * EML-EAI-2026-v0.7 · Phase 3 validation for EAI-RETROFIT.md
 * EveMissLab（一言諾科技有限公司）· 2026
 *
 * A stack-based RPN calculator with named variable slots — deliberately a
 * THIRD distinct architecture from VM-16 (register machine) and WASM
 * (structured-control-flow stack machine over linear memory): no registers,
 * no linear memory, no control flow at all, just a growing/shrinking operand
 * stack and a flat token tape. It exists to test whether EAI-RETROFIT.md's
 * six domain-agnostic roles actually transfer to something built with no
 * awareness of PHOSPHOR, or whether the "generalization" only worked because
 * VM-16 and WASM both happen to be, well, VMs.
 *
 * `stepOnce` follows the same functional-step contract as `eml-vm16-core.ts`
 * and `wasm/wasm-interp.ts`: clone the mutable parts, return a new state,
 * leave the input frozen.
 */

export type RpnToken =
  | { kind: 'num'; value: number }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' }
  | { kind: 'store'; name: string }
  | { kind: 'load'; name: string };

export interface RpnState {
  tokens: RpnToken[];
  pc: number;
  stack: number[];
  vars: Record<string, number>;
  halted: boolean;
  ticks: number;
  changedVars: Set<string>;   // vars written THIS tick — mirrors VM-16's `changed: Set<u8>`
}

export function makeRpnState(tokens: RpnToken[]): RpnState {
  return { tokens, pc: 0, stack: [], vars: {}, halted: tokens.length === 0, ticks: 0, changedVars: new Set() };
}

/** Human-legible text for one token — the same role `decode()` plays in eml-vm16-core.ts. */
export function decodeToken(t: RpnToken): string {
  switch (t.kind) {
    case 'num': return `PUSH ${t.value}`;
    case 'op': return t.op;
    case 'store': return `STORE ${t.name}`;
    case 'load': return `LOAD ${t.name}`;
  }
}

export class RpnTrap extends Error {
  constructor(reason: string) { super(`RPN trap: ${reason}`); this.name = 'RpnTrap'; }
}

/** Execute exactly one token. Functional: clones stack/vars, returns a new state. */
export function stepOnce(state: RpnState): RpnState {
  if (state.halted) return state;

  const stack = [...state.stack];
  const vars = { ...state.vars };
  const changedVars = new Set<string>();
  const t = state.tokens[state.pc];

  switch (t.kind) {
    case 'num': stack.push(t.value); break;
    case 'op': {
      const b = stack.pop(), a = stack.pop();
      if (a === undefined || b === undefined) throw new RpnTrap(`stack underflow at token ${state.pc} ('${t.op}')`);
      const r = t.op === '+' ? a + b : t.op === '-' ? a - b : t.op === '*' ? a * b : (() => {
        if (b === 0) throw new RpnTrap(`division by zero at token ${state.pc}`);
        return a / b;
      })();
      stack.push(r);
      break;
    }
    case 'store': {
      const v = stack.pop();
      if (v === undefined) throw new RpnTrap(`stack underflow at token ${state.pc} (STORE ${t.name})`);
      vars[t.name] = v;
      changedVars.add(t.name);
      break;
    }
    case 'load': {
      if (!(t.name in vars)) throw new RpnTrap(`read of undefined variable '${t.name}' at token ${state.pc}`);
      stack.push(vars[t.name]);
      break;
    }
  }

  const pc = state.pc + 1;
  const halted = pc >= state.tokens.length;
  return { tokens: state.tokens, pc, stack, vars, halted, ticks: state.ticks + 1, changedVars };
}

export function stepToHalt(state: RpnState, maxSteps = 100_000): RpnState {
  let s = state;
  let guard = 0;
  while (!s.halted && guard++ < maxSteps) s = stepOnce(s);
  return s;
}

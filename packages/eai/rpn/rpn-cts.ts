/**
 * PHOSPHOR · rpn-cts — CTS mapping for the RPN target
 * EML-EAI-2026-v0.7
 * EveMissLab（一言諾科技有限公司）· 2026
 *
 * The six EAI-RETROFIT.md roles applied to `rpn-core.ts`, following the
 * checklist in EAI-RETROFIT.md §4. This is NOT `eml-vm16-core.ts`'s `CTS`
 * type reused structurally (unlike `wasm-cts.ts`, which could reuse it
 * because WASM's memory addresses are still numbers) — RPN's addressable
 * positions are variable NAMES, not numeric addresses, so forcing the VM-16
 * shape here would be the exact mistake this whole exercise is checking for.
 * A genuinely different domain gets a genuinely different (but role-parallel)
 * type.
 *
 * Role-by-role, stated plainly rather than left to be inferred:
 *   1. Unit Vocabulary   — POPULATED. The op/store/load/push catalog below.
 *   2. Location Naming   — POPULATED. Named variable slots.
 *   3. Region Typing     — POPULATED, but nearly trivial: only two regions
 *                          exist at all (the transient stack, the persistent
 *                          named vars), so this role does real work on VM-16
 *                          (many named regions across 256 bytes) and almost
 *                          none here. That asymmetry is expected, not a bug.
 *   4. Decoded Content   — DELIBERATELY EMPTY. Pure numeric arithmetic has no
 *                          printable-string payloads to recover. Left empty
 *                          on purpose, exactly like WASM's Layer 5 gap — see
 *                          EAI-RETROFIT.md §2 for why an honest empty role
 *                          beats a faked one.
 *   5. Intent Annotation — POPULATED. Comments bound to token positions.
 *   6. Provenance Graph  — POPULATED, dynamic. Built the same way
 *                          `augmentCTSFromTrace` recovers VM-16's
 *                          register-indirect writers: fold a run's snapshots
 *                          rather than trying to derive it statically.
 */

import type { RpnState, RpnToken } from './rpn-core';
import { decodeToken } from './rpn-core';
import type { RpnSnapshot } from './rpn-snapshot';

export interface RpnUnitEntry { description: string; }
export interface RpnVarEntry { description?: string; }
export interface RpnRegion { kind: 'stack' | 'vars'; description: string; }
export interface RpnProvenance { writers: number[]; readers: number[]; }

export interface RpnCts {
  unitVocabulary: Map<string, RpnUnitEntry>;
  varNames: Map<string, RpnVarEntry>;
  regionTypes: RpnRegion[];
  decodedContent: Map<string, string>;
  comments: Map<number, string>;
  provenance: Map<string, RpnProvenance>;
}

/** Role 1 — static, same for every program: the fixed op/store/load/push catalog. */
export const UNIT_VOCABULARY: Map<string, RpnUnitEntry> = new Map([
  ['PUSH', { description: 'push a numeric literal onto the stack' }],
  ['+', { description: 'pop b,a; push a+b' }],
  ['-', { description: 'pop b,a; push a-b' }],
  ['*', { description: 'pop b,a; push a*b' }],
  ['/', { description: 'pop b,a; push a/b (traps on b=0)' }],
  ['STORE', { description: 'pop a value into a named variable slot' }],
  ['LOAD', { description: 'push a named variable slot\'s value' }],
]);

export const REGION_TYPES: RpnRegion[] = [
  { kind: 'stack', description: 'transient operand stack — cleared meaning has no lifetime past HALT' },
  { kind: 'vars', description: 'named, persistent for the run — the only positions Location Naming (Role 2) applies to' },
];

/** Build Role 2 (varNames) + Role 5 (comments) from the program itself, before any run. */
export function buildStaticRpnCts(tokens: RpnToken[], varDescriptions: Record<string, string> = {}, comments: Record<number, string> = {}): RpnCts {
  const varNames = new Map<string, RpnVarEntry>();
  tokens.forEach(t => {
    if (t.kind === 'store' || t.kind === 'load') {
      varNames.set(t.name, { description: varDescriptions[t.name] });
    }
  });
  return {
    unitVocabulary: UNIT_VOCABULARY,
    varNames,
    regionTypes: REGION_TYPES,
    decodedContent: new Map(),   // Role 4 — deliberately empty, see module doc
    comments: new Map(Object.entries(comments).map(([k, v]) => [Number(k), v])),
    provenance: new Map(),       // filled dynamically by augmentRpnProvenance after a run
  };
}

/**
 * Role 6, dynamic: fold a completed run's snapshots into per-variable
 * writer/reader provenance — the RPN analog of `augmentCTSFromTrace`.
 */
export function augmentRpnProvenance(snapshots: RpnSnapshot[]): Map<string, RpnProvenance> {
  const table = new Map<string, RpnProvenance>();
  const get = (name: string): RpnProvenance => {
    if (!table.has(name)) table.set(name, { writers: [], readers: [] });
    return table.get(name)!;
  };
  for (const snap of snapshots) {
    for (const name of snap.changed_vars) get(name).writers.push(snap.executed_pc);
    if (snap.executed_token.startsWith('LOAD ')) get(snap.executed_token.slice(5)).readers.push(snap.executed_pc);
  }
  return table;
}

export { decodeToken };

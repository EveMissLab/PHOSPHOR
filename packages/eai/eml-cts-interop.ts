/**
 * PHOSPHOR · EML CTS interop (v0.5, EXPERIMENTAL)
 * EML-EAI-2026-v0.5 · reconcile EML's source-level Cts with PHOSPHOR's machine CTS
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Both projects ship a "CTS" (Correspondence Table System), and EML's was written
 * "PHOSPHOR-compatible (whitepaper Appendix C)". But they sit at DIFFERENT
 * ALTITUDES and use DIFFERENT KEY SPACES, so they are NOT field-for-field
 * interchangeable — treating them as identical would silently mis-map. This module
 * makes the boundary explicit and bridges only what genuinely transfers. See
 * CTS-INTEROP.md for the full field-by-field contract.
 *
 *   PHOSPHOR CTS  — keyed by MEMORY ADDRESS (u8); machine altitude
 *                   (opcodeTable / symbolTable / typeTable / stringTable /
 *                    commentTable / crossRefTable{callers,dataReaders,dataWriters}).
 *   EML Cts       — keyed by SYMBOL / node-id STRING; source altitude
 *                   (symbols / nodes / functions / loops / commentTable /
 *                    crossRefTable{identifier → source fragments}).
 *
 * What honestly transfers (and is bridged here):
 *   · EML `symbols` (overlay token → meaning)  → a phosphor-stream semantic
 *     Dictionary (the `meta:dictionary` an agent reads to interpret a stream cold).
 *   · EML `functions` (cold/hot + importance)  → attention/risk hints.
 *   · EML `loops` (loopKind + determinism)     → control-flow hints.
 * What does NOT transfer: addresses, opcodes, regions, and EML's `semanticType`
 * strings (source-statement categories, e.g. "function.cold") have no meaning in
 * PHOSPHOR's `DataType` union (memory-cell types, e.g. "u8"/"ptr"); they are kept
 * verbatim as labels, never coerced.
 */

import type { Dictionary, TypeSpec } from './stream/phosphor-stream';

// ═══════════════════════════════════════════════════════════════════════════════
// § 1. EML Cts model (mirror of @eml/types `Cts`, whitepaper Appendix C)
// ═══════════════════════════════════════════════════════════════════════════════

export interface EmlSymbolEntry { type: string; meaning: string; target?: string; }
export interface EmlNode {
  id: string; source: string; python: string;
  dependencies: string[]; semanticType: string;
}
export interface EmlImportance {
  callFrequency: number; riskLevel: number; dependencyDepth: number; score: number;
}
export interface EmlFunction {
  name: string;
  temperature: 'cold' | 'hot' | 'neutral';
  pure: boolean;
  astHash: string;
  cached: boolean;
  importance: EmlImportance;
  sideEffects: string[];
}
export interface EmlLoop {
  loopKind: string; deterministic: boolean; terminating: boolean; source: string; ref?: string;
}
export interface EmlCts {
  file: string;
  symbols: Record<string, EmlSymbolEntry>;
  nodes: EmlNode[];
  functions: EmlFunction[];
  loops: EmlLoop[];
  commentTable: Record<string, string>;
  crossRefTable: Record<string, string[]>;
}

/** Defensive shape check before trusting parsed JSON as an EML Cts. */
export function isEmlCts(x: unknown): x is EmlCts {
  const o = x as Record<string, unknown>;
  return !!o && typeof o === 'object'
    && typeof o.file === 'string'
    && !!o.symbols && typeof o.symbols === 'object'
    && Array.isArray(o.nodes)
    && Array.isArray(o.functions)
    && Array.isArray(o.loops);
}

/** Parse EML Cts JSON text, returning null (never throwing) on malformed input. */
export function parseEmlCts(json: string): EmlCts | null {
  try {
    const v = JSON.parse(json);
    return isEmlCts(v) ? v : null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 2. Bridges (only what genuinely transfers)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Lift EML's overlay symbol catalogue into a phosphor-stream semantic Dictionary.
 * EML `symbols[token] = {type, meaning, target}` → `dictionary[token] = {description}`
 * so a PHOSPHOR agent can emit it as a `meta:dictionary` event and interpret an EML
 * (or mixed) stream with no prior context. The token KEY is preserved verbatim.
 */
export function emlCtsToDictionary(cts: EmlCts): Dictionary {
  const dict: Dictionary = {};
  for (const [token, e] of Object.entries(cts.symbols)) {
    const spec: TypeSpec = {
      description: `[${e.type}] ${e.meaning}${e.target ? ` ⇒ ${e.target}` : ''}`,
    };
    dict[token] = spec;
  }
  return dict;
}

/** A per-function attention/risk hint distilled from EML cold/hot + importance. */
export interface CtsAttentionHint {
  name:            string;
  temperature:     'cold' | 'hot' | 'neutral';
  pure:            boolean;
  cached:          boolean;
  importanceScore: number;     // 0..1 composite (whitepaper 8.5)
  riskLevel:       number;     // 0..1
  sideEffects:     string[];
}

/**
 * Extract attention hints, highest-importance first. A PHOSPHOR visualizer can use
 * these to colour/rank code regions (hot = side-effecting, attention-worthy; cold =
 * deterministic, foldable) — the source-side analog of typeTable region shading.
 */
export function emlCtsAttention(cts: EmlCts): CtsAttentionHint[] {
  return cts.functions
    .map(f => ({
      name: f.name,
      temperature: f.temperature,
      pure: f.pure,
      cached: f.cached,
      importanceScore: f.importance?.score ?? 0,
      riskLevel: f.importance?.riskLevel ?? 0,
      sideEffects: f.sideEffects ?? [],
    }))
    .sort((a, b) => b.importanceScore - a.importanceScore);
}

/** A control-flow hint distilled from an EML loop classification. */
export interface CtsLoopHint { loopKind: string; deterministic: boolean; terminating: boolean; source: string; }

/** Extract loop control-flow hints (loopKind + determinism/termination flags). */
export function emlCtsLoops(cts: EmlCts): CtsLoopHint[] {
  return cts.loops.map(l => ({
    loopKind: l.loopKind, deterministic: l.deterministic, terminating: l.terminating, source: l.source,
  }));
}

/** Split an EML `semanticType` ("function.cold") into {domain, action}. These are
 * SOURCE-statement categories and are intentionally NOT mapped to PHOSPHOR's
 * machine `DataType` union — kept as labels (see CTS-INTEROP.md). */
export function classifyEmlNode(semanticType: string): { domain: string; action: string | null } {
  const i = semanticType.indexOf('.');
  return i < 0 ? { domain: semanticType, action: null }
               : { domain: semanticType.slice(0, i), action: semanticType.slice(i + 1) };
}

/** A compact, PHOSPHOR-side digest of an EML Cts: the three transferable views. */
export interface EmlCtsDigest {
  file:       string;
  dictionary: Dictionary;
  attention:  CtsAttentionHint[];
  loops:      CtsLoopHint[];
  nodeCount:  number;
}

export function digestEmlCts(cts: EmlCts): EmlCtsDigest {
  return {
    file:       cts.file,
    dictionary: emlCtsToDictionary(cts),
    attention:  emlCtsAttention(cts),
    loops:      emlCtsLoops(cts),
    nodeCount:  cts.nodes.length,
  };
}

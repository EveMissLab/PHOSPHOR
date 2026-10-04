/**
 * PHOSPHOR · Headless VM Runner
 * EML-EAI-2026-v0.4 · headless execution driver (AI-mode + human-mode)
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * A UI-free driver that runs an EML-VM-16 or EML-VM-BASIC program to completion
 * and emits AI-readable HeadlessSnapshots per tick. Two modes:
 *
 *   ai    — maximum throughput, no inter-tick delay (for agent consumption /
 *           batch verification). Yields to the event loop periodically so the
 *           process stays non-blocking.
 *   human — same snapshot shape, intended for paced/observed runs.
 *
 * AI-mode output integrates with the portable phosphor-stream protocol: pass an
 * Emitter and every tick becomes a `vm:tick` event, HALT becomes `vm:halt`.
 *
 *   run:  npm run phosphor -- run --program fibonacci [--mode ai] [--max N] …
 */

import {
  hex2,
  PROGRAM_FIBONACCI, PROGRAM_COUNTER, PROGRAM_XOR_CIPHER,
  type ProgramDefinition,
} from './eml-vm16-core';

import {
  type SpeedPreset,
} from './eml-vm16-window';

import {
  validateProgramConstraints,
  type BasicConstraints, DEFAULT_BASIC_CONSTRAINTS,
} from './eml-vm-basic';

// The snapshot builder and the run loop live in their own browser-safe modules so
// the human-mode UI can share them (single source of truth) WITHOUT pulling in the
// Node `ws`/process CLI below. Re-exported here so existing `./headless-vm`
// importers (tests) keep resolving the same symbols.
import {
  buildHeadlessSnapshot, headlessSnapshotToStreamFields,
  type HeadlessSnapshot, type VMMode,
} from './headless-snapshot';
import { createHeadlessVM, type HeadlessOptions } from './headless-driver';
export {
  buildHeadlessSnapshot, headlessSnapshotToStreamFields, createHeadlessVM,
  type HeadlessSnapshot, type VMMode, type HeadlessOptions,
};

// ═══════════════════════════════════════════════════════════════════════════════
// § 4. CLI
// ═══════════════════════════════════════════════════════════════════════════════

const PROGRAM_REGISTRY: Record<string, ProgramDefinition> = {
  fibonacci: PROGRAM_FIBONACCI,
  counter:   PROGRAM_COUNTER,
  xor:       PROGRAM_XOR_CIPHER,
};

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
      else out[key] = true;
    } else if (out._cmd === undefined) {
      out._cmd = a;
    }
  }
  return out;
}

async function cli(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args._cmd !== 'run') {
    console.error('usage: tsx headless-vm.ts run --program <fibonacci|counter|xor> [--mode ai|human] [--speed TURBO] [--max N] [--basic] [--maxValue N] [--ws-port P]');
    process.exitCode = 1;
    return;
  }

  const progName = String(args.program ?? 'fibonacci');
  const program  = PROGRAM_REGISTRY[progName];
  if (!program) {
    console.error(`unknown program '${progName}'. Known: ${Object.keys(PROGRAM_REGISTRY).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const mode    = (args.mode === 'human' ? 'human' : 'ai') as VMMode;
  const speed   = (typeof args.speed === 'string' ? args.speed : 'TURBO') as SpeedPreset | string;
  const maxSteps = args.max !== undefined ? Number(args.max) : 1_000_000;
  const isBasic = args.basic === true;
  const wsPort  = args['ws-port'] !== undefined ? Number(args['ws-port']) : undefined;

  // ── WebSocket-server path: reuse the P5 stack ───────────────────────────────
  if (wsPort !== undefined) {
    const { createPipeline, buildProgramRegistry } = await import('./eml-vm16-window');
    const { bootstrapWSServer } = await import('./eml-vm16-agent');
    const { WebSocketServer } = await import('ws');

    const registry = buildProgramRegistry([program]);
    const mgr = createPipeline({
      id: 'headless-ws', label: 'headless ws', autoRun: false,
      windows: [{ id: program.id, title: program.label, program, speed: speed as SpeedPreset }],
      channels: [],
    }, registry);

    const wss = new WebSocketServer({ port: wsPort });
    await new Promise<void>(res => wss.on('listening', () => res()));
    bootstrapWSServer(wss, mgr);
    mgr.runWindow(program.id, speed as SpeedPreset);
    console.log(`ws://localhost:${wsPort}  (window '${program.id}' running, speed ${speed})`);
    return;
  }

  // ── Headless stdout path ────────────────────────────────────────────────────
  const constraints: BasicConstraints | undefined = isBasic
    ? { ...DEFAULT_BASIC_CONSTRAINTS, ...(args.maxValue !== undefined ? { maxValue: Number(args.maxValue) } : {}) }
    : undefined;

  if (constraints) {
    const { valid, violations } = validateProgramConstraints(program, constraints);
    if (!valid) {
      console.error(`program '${program.id}' violates BASIC constraints: ${violations.map(v => `${v.mnemonic}@0x${hex2(v.addr)}`).join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  const runner = createHeadlessVM({
    program, mode, speed, maxSteps, constraints,
    onSnapshot: (snap) => { process.stdout.write(JSON.stringify(snap) + '\n'); },
  });

  await runner.run();
}

// Guarded entry: only run when executed directly as a Node CLI (not when imported
// by tests, and not when bundled into the browser where `process` is undefined).
if (typeof process !== 'undefined' && process.argv?.[1]?.replace(/\\/g, '/').endsWith('headless-vm.ts')) {
  cli(process.argv.slice(2)).catch(err => {
    console.error('headless-vm crashed:', err);
    process.exitCode = 1;
  });
}

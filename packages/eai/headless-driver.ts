/**
 * PHOSPHOR · Headless VM Driver (browser-safe)
 * EML-EAI-2026-v0.5 · the UI-free run loop, separated from the Node CLI
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * `createHeadlessVM` runs an EML-VM-16 or EML-VM-BASIC program to completion and
 * (in AI mode) bridges each tick onto the portable phosphor-stream standard as a
 * `vm:tick` event (HALT → `vm:halt`). It depends only on the pure VM core + the
 * browser-safe snapshot builder, so it can be imported from the browser UI.
 *
 * The Node CLI (`phosphor run …`, the `ws`/window/agent integration) lives in
 * headless-vm.ts, which re-exports this driver. Keeping them apart means bundling
 * the UI never pulls in `ws` or `process`.
 */

import {
  makeVMState, stepOnce,
  type ProgramDefinition, type VMState,
} from './eml-vm16-core';
import {
  makeBasicState, stepOnceBasic,
  type BasicConstraints, DEFAULT_BASIC_CONSTRAINTS,
} from './eml-vm-basic';
import {
  buildHeadlessSnapshot, headlessSnapshotToStreamFields,
  type HeadlessSnapshot, type VMMode,
} from './headless-snapshot';
import type { Emitter } from './stream/phosphor-stream';

export interface HeadlessOptions {
  program:      ProgramDefinition;
  mode?:        VMMode;
  speed?:       string;
  maxSteps?:    number;
  constraints?: BasicConstraints;
  id?:          string;
  onSnapshot?:  (s: HeadlessSnapshot) => void;
  onHalt?:      (s: HeadlessSnapshot) => void;
  emitter?:     Emitter;
}

const YIELD_EVERY = 2000;

/**
 * Create a headless VM runner. If `constraints` is present the BASIC path is
 * used (makeBasicState / stepOnceBasic, arch 'EML-VM-BASIC'); otherwise the
 * VM-16 path (makeVMState / stepOnce, arch 'EML-VM-16').
 *
 * Per tick: capture prevMem → step once → build snapshot → onSnapshot +
 * emitter.emit('vm:tick', …). On HALT: onHalt + emitter.emit('vm:halt', …).
 * AI mode runs at max throughput, yielding to the event loop every ~2000 steps.
 */
export function createHeadlessVM(opts: HeadlessOptions): {
  run(): Promise<{ steps: number; halted: boolean; finalSnapshot: HeadlessSnapshot; finalState: any }>;
  stop(): void;
} {
  const mode     = opts.mode ?? 'ai';
  const maxSteps = opts.maxSteps ?? 1_000_000;
  const id       = opts.id ?? opts.program.id;
  const cts      = opts.program.cts ?? {};
  const isBasic  = opts.constraints !== undefined;
  const arch     = isBasic ? 'EML-VM-BASIC' : 'EML-VM-16';
  const constraints = opts.constraints ?? DEFAULT_BASIC_CONSTRAINTS;

  let stopped = false;

  const run = async (): Promise<{ steps: number; halted: boolean; finalSnapshot: HeadlessSnapshot; finalState: any }> => {
    let state: VMState | ReturnType<typeof makeBasicState> =
      isBasic ? makeBasicState(opts.program, constraints) : makeVMState(opts.program);

    let steps = 0;
    const snapToFields = headlessSnapshotToStreamFields;

    let finalSnapshot: HeadlessSnapshot = buildHeadlessSnapshot({ id, state: state as any, mode, arch, cts });

    while (!stopped && !state.halted && steps < maxSteps) {
      const prevMem = state.memory;
      state = isBasic
        ? stepOnceBasic(state as ReturnType<typeof makeBasicState>, constraints, cts)
        : stepOnce(state as VMState, cts);
      steps++;

      const snap = buildHeadlessSnapshot({ id, state: state as any, mode, arch, cts, prevMem });
      finalSnapshot = snap;
      opts.onSnapshot?.(snap);
      opts.emitter?.emit('vm:tick', snapToFields(snap));

      if (state.halted) {
        opts.onHalt?.(snap);
        opts.emitter?.emit('vm:halt', snapToFields(snap));
        break;
      }

      if (mode === 'ai' && steps % YIELD_EVERY === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }

    return { steps, halted: state.halted, finalSnapshot, finalState: state };
  };

  return { run, stop() { stopped = true; } };
}

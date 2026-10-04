/**
 * EML-VM-16 Window System
 * EML-EAI-2026-v0.1 · Phase 4: Multi-VM Window System
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Builds on Phase 2 (eml-vm16-core.ts) and Phase 3 (eml-vm16-callable.ts).
 *
 * Provides:
 *   - WindowVM       : stateful VM with poke() interface for cross-VM injection
 *   - VMWindowManager: multi-window scheduling, memory channels, serialization
 *   - Pipeline       : declarative multi-VM composition
 *
 * Design principle: windows are independent execution contexts; channels are
 * directed edges in a computation graph. The manager is the graph.
 */

import {
  u8,
  VMState, VMFlags, LogEntry,
  ProgramDefinition, CTS,
  makeVMState, stepOnce, stepN,
  decode, hex2,
  REG_NAMES,
} from './eml-vm16-core';

import {
  CallableProgram,
  CallableFunction,
  ProgramManifest,
  CallableVM,
  createCallableVM,
} from './eml-vm16-callable';

// ═══════════════════════════════════════════════════════════════════════════════
// § 1. Speed Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export type SpeedPreset = 'SLOW' | 'NORM' | 'FAST' | 'TURBO';

export const SPEED_CONFIG: Record<SpeedPreset, { ms: number; n: number }> = {
  SLOW:  { ms: 480, n: 1 },
  NORM:  { ms: 110, n: 1 },
  FAST:  { ms:  35, n: 1 },
  TURBO: { ms:  40, n: 6 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// § 2. WindowVM — stateful VM with poke() and external-write support
//
// Rationale: Phase 2's VMController keeps `state` private, which prevents
// cross-VM memory injection. WindowVM exposes a controlled mutation path via
// poke() and pokeRange() without breaking the immutable-step semantics of
// the functional core (stepOnce/stepN).
// ═══════════════════════════════════════════════════════════════════════════════

type VMStateListener = (state: VMState) => void;

export class WindowVM {
  readonly id:       string;
  private _state:    VMState;
  private _program:  ProgramDefinition;
  private _cts:      Partial<CTS>;
  private _timer:    ReturnType<typeof setInterval> | null = null;
  private _speed:    SpeedPreset = 'NORM';
  private _listeners: Set<VMStateListener> = new Set();
  private _callableVM?: CallableVM;

  constructor(id: string, program: ProgramDefinition, cts?: Partial<CTS>) {
    this.id       = id;
    this._program = program;
    this._cts     = { ...(program.cts ?? {}), ...(cts ?? {}) };
    this._state   = makeVMState(program);
    // If the program exports callable functions, expose a CallableVM so the
    // agent layer can invoke them (cmd:call) alongside the live visualization.
    if ('exports' in program && Array.isArray((program as CallableProgram).exports)) {
      this._callableVM = createCallableVM(program as CallableProgram, this._cts);
    }
  }

  /** CallableVM for ECC-1 function invocation, present iff the program exports functions. */
  get callableVM(): CallableVM | undefined { return this._callableVM; }

  // ── State Access ─────────────────────────────────────────────────────────

  get state(): VMState { return this._state; }

  get halted(): boolean { return this._state.halted; }

  get running(): boolean { return this._timer !== null; }

  get speed(): SpeedPreset { return this._speed; }

  getMemory(): Readonly<Uint8Array> { return this._state.memory; }

  peekAddr(addr: u8): u8 { return this._state.memory[addr]; }

  // ── Execution Control ─────────────────────────────────────────────────────

  step(): VMState {
    if (this._state.halted) return this._state;
    this._state = stepOnce(this._state, this._cts);
    this._notify();
    return this._state;
  }

  stepN(n: number): VMState {
    if (this._state.halted) return this._state;
    this._state = stepN(this._state, n, this._cts);
    this._notify();
    return this._state;
  }

  run(speed?: SpeedPreset): void {
    if (this._timer !== null || this._state.halted) return;
    if (speed) this._speed = speed;
    const { ms, n } = SPEED_CONFIG[this._speed];
    this._timer = setInterval(() => {
      if (this._state.halted) { this.pauseExecution(); return; }
      this._state = stepN(this._state, n, this._cts);
      this._notify();
    }, ms);
  }

  pauseExecution(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  setSpeed(speed: SpeedPreset): void {
    this._speed = speed;
    if (this._timer !== null) {
      this.pauseExecution();
      this.run();
    }
  }

  reset(): void {
    this.pauseExecution();
    this._state = makeVMState(this._program);
    this._notify();
  }

  forceHalt(): void {
    this.pauseExecution();
    this._state = { ...this._state, halted: true };
    this._notify();
  }

  // ── Memory Injection (poke) ───────────────────────────────────────────────
  // These methods allow the VMWindowManager to inject data from other VMs.
  // Pokes create a new immutable state copy; they do NOT pause execution.

  /** Write a single byte to an address. Safe to call from channel callbacks. */
  poke(addr: u8, val: u8): void {
    const memory = new Uint8Array(this._state.memory);
    memory[addr] = val;
    this._state = {
      ...this._state,
      memory,
      changed: new Set<u8>([addr]),
    };
    this._notify();
  }

  /** Write a range of bytes starting at startAddr. */
  pokeRange(startAddr: u8, vals: u8[]): void {
    if (vals.length === 0) return;
    const memory = new Uint8Array(this._state.memory);
    const changed = new Set<u8>();
    vals.forEach((v, i) => {
      const a = (startAddr + i) & 0xFF as u8;
      memory[a] = v;
      changed.add(a);
    });
    this._state = { ...this._state, memory, changed };
    this._notify();
  }

  // ── Observation ───────────────────────────────────────────────────────────

  subscribe(listener: VMStateListener): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  private _notify(): void {
    this._listeners.forEach(fn => fn(this._state));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 3. Window & Channel Types
// ═══════════════════════════════════════════════════════════════════════════════

export type WindowStatus = 'running' | 'paused' | 'halted' | 'minimized' | 'closed';

export interface WindowRect {
  x: number; y: number;
  w: number; h: number;
}

export interface WindowConfig {
  id:       string;
  title:    string;
  program:  ProgramDefinition | CallableProgram;
  cts?:     Partial<CTS>;
  autoRun?: boolean;
  speed?:   SpeedPreset;
  rect?:    WindowRect;         // optional layout hint for UI layer
}

export interface VMWindowRecord {
  id:      string;
  title:   string;
  status:  WindowStatus;
  vm:      WindowVM;
  config:  WindowConfig;
  rect:    WindowRect;
}

/**
 * A directed memory channel between two Windows.
 * When any address in src[srcStart..srcEnd] changes, the corresponding
 * offset within dst[dstStart..dstStart+rangeLen] is updated immediately.
 */
export interface MemoryChannel {
  id:       string;
  srcId:    string;   // source window ID
  srcStart: u8;
  srcEnd:   u8;       // inclusive
  dstId:    string;   // destination window ID
  dstStart: u8;       // dst address = dstStart + (srcAddr - srcStart)
  label?:   string;   // human-readable description
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 4. State Serialization / Deserialization
// ═══════════════════════════════════════════════════════════════════════════════

export interface SerializedVMState {
  memory:  number[];    // Array.from(Uint8Array(256))
  regs:    number[];    // Array.from(Uint8Array(8))
  pc:      number;
  sp:      number;
  flags:   VMFlags;
  halted:  boolean;
  ticks:   number;
  log:     LogEntry[];
}

export interface SerializedWindow {
  id:        string;
  title:     string;
  status:    WindowStatus;
  program_id: string;
  speed:     SpeedPreset;
  rect:      WindowRect;
  vmState:   SerializedVMState;
}

export interface SerializedManagerState {
  version:   string;
  timestamp: string;
  windows:   SerializedWindow[];
  channels:  MemoryChannel[];
}

export function serializeVMState(s: VMState): SerializedVMState {
  return {
    memory:  Array.from(s.memory),
    regs:    Array.from(s.regs),
    pc:      s.pc,
    sp:      s.sp,
    flags:   { ...s.flags },
    halted:  s.halted,
    ticks:   s.ticks,
    log:     s.log.map(e => ({ ...e })),
  };
}

export function deserializeVMState(s: SerializedVMState): VMState {
  return {
    memory:  new Uint8Array(s.memory),
    regs:    new Uint8Array(s.regs),
    pc:      s.pc,
    sp:      s.sp,
    flags:   { ...s.flags },
    halted:  s.halted,
    ticks:   s.ticks,
    log:     s.log.map(e => ({ ...e })),
    changed: new Set(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 5. Manager Manifest (AI-readable topology)
// ═══════════════════════════════════════════════════════════════════════════════

export interface ManagerManifest {
  total_windows: number;
  total_channels: number;
  windows: Array<{
    id:       string;
    title:    string;
    status:   WindowStatus;
    program:  string;
    speed:    SpeedPreset;
    ticks:    number;
    halted:   boolean;
    pc:       string;
  }>;
  channels: Array<{
    id:    string;
    label: string;
    from:  string;
    to:    string;
    src_range: string;
    dst_start: string;
  }>;
  data_flow_graph: Array<{ src: string; dst: string }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 6. VMWindowManager
// ═══════════════════════════════════════════════════════════════════════════════

type ManagerListener = (event: ManagerEvent) => void;

export type ManagerEventKind =
  | 'window:created'
  | 'window:closed'
  | 'window:status'
  | 'channel:wired'
  | 'channel:removed'
  | 'vm:step'
  | 'vm:halted';

export interface ManagerEvent {
  kind:     ManagerEventKind;
  windowId?: string;
  channelId?: string;
  state?:   VMState;
}

/** Program registry: id → ProgramDefinition */
type ProgramRegistry = Map<string, ProgramDefinition | CallableProgram>;

export class VMWindowManager {
  private windows:   Map<string, VMWindowRecord>    = new Map();
  private channels:  Map<string, MemoryChannel>     = new Map();
  private unsubs:    Map<string, () => void>         = new Map();  // channel unsubs
  private listeners: Set<ManagerListener>           = new Set();
  private programs:  ProgramRegistry                = new Map();

  constructor(programs?: ProgramRegistry) {
    if (programs) programs.forEach((p, id) => this.programs.set(id, p));
  }

  // ── Program Registry ─────────────────────────────────────────────────────

  registerProgram(program: ProgramDefinition | CallableProgram): void {
    this.programs.set(program.id, program);
  }

  // ── Window Lifecycle ─────────────────────────────────────────────────────

  createWindow(config: WindowConfig): VMWindowRecord {
    const vm = new WindowVM(config.id, config.program, config.cts);

    const record: VMWindowRecord = {
      id:     config.id,
      title:  config.title,
      status: 'paused',
      vm,
      config,
      rect:   config.rect ?? { x: 0, y: 0, w: 400, h: 300 },
    };

    this.windows.set(config.id, record);

    // Forward VM state changes as manager events
    vm.subscribe(state => {
      if (state.halted && record.status !== 'halted') {
        record.status = 'halted';
        this._emit({ kind: 'vm:halted', windowId: config.id, state });
      } else {
        this._emit({ kind: 'vm:step', windowId: config.id, state });
      }
    });

    this._emit({ kind: 'window:created', windowId: config.id });

    if (config.autoRun) {
      this.runWindow(config.id, config.speed);
    }

    return record;
  }

  closeWindow(id: string): boolean {
    const record = this.windows.get(id);
    if (!record) return false;

    record.vm.forceHalt();
    record.status = 'closed';

    // Remove any channels involving this window
    [...this.channels.keys()].forEach(cid => {
      const ch = this.channels.get(cid)!;
      if (ch.srcId === id || ch.dstId === id) this.removeChannel(cid);
    });

    this.windows.delete(id);
    this._emit({ kind: 'window:closed', windowId: id });
    return true;
  }

  getWindow(id: string): VMWindowRecord | undefined {
    return this.windows.get(id);
  }

  getWindowVM(id: string): WindowVM | undefined {
    return this.windows.get(id)?.vm;
  }

  listWindows(): VMWindowRecord[] {
    return [...this.windows.values()];
  }

  // ── Execution Control ─────────────────────────────────────────────────────

  runWindow(id: string, speed?: SpeedPreset): void {
    const rec = this.windows.get(id);
    if (!rec || rec.status === 'closed') return;
    rec.vm.run(speed ?? rec.config.speed);
    rec.status = 'running';
    this._emit({ kind: 'window:status', windowId: id });
  }

  pauseWindow(id: string): void {
    const rec = this.windows.get(id);
    if (!rec) return;
    rec.vm.pauseExecution();
    if (rec.status === 'running') {
      rec.status = 'paused';
      this._emit({ kind: 'window:status', windowId: id });
    }
  }

  resetWindow(id: string): void {
    const rec = this.windows.get(id);
    if (!rec) return;
    rec.vm.reset();
    rec.status = 'paused';
    this._emit({ kind: 'window:status', windowId: id });
  }

  runAll(speed?: SpeedPreset): void {
    this.windows.forEach((rec, id) => {
      if (rec.status !== 'halted' && rec.status !== 'closed') {
        this.runWindow(id, speed);
      }
    });
  }

  pauseAll(): void {
    this.windows.forEach((_, id) => this.pauseWindow(id));
  }

  resetAll(): void {
    this.channels.forEach((_, id) => this.removeChannel(id));
    this.windows.forEach((_, id) => this.resetWindow(id));
  }

  setWindowSpeed(id: string, speed: SpeedPreset): void {
    this.windows.get(id)?.vm.setSpeed(speed);
  }

  // ── Memory Channels (cross-VM wiring) ────────────────────────────────────

  /**
   * Wire a directed memory channel between two windows.
   * When any address in src[srcStart..srcEnd] changes, the corresponding
   * byte is immediately poked into dst[dstStart + offset].
   *
   * Returns a disconnect function.
   */
  wire(channel: MemoryChannel): () => void {
    if (this.channels.has(channel.id)) {
      throw new Error(`Channel '${channel.id}' already exists`);
    }

    const srcRec = this.windows.get(channel.srcId);
    const dstRec = this.windows.get(channel.dstId);

    if (!srcRec) throw new Error(`Source window '${channel.srcId}' not found`);
    if (!dstRec) throw new Error(`Target window '${channel.dstId}' not found`);

    const unsub = srcRec.vm.subscribe(state => {
      state.changed.forEach(addr => {
        if (addr >= channel.srcStart && addr <= channel.srcEnd) {
          const offset   = (addr - channel.srcStart) & 0xFF;
          const dstAddr  = (channel.dstStart + offset) & 0xFF as u8;
          dstRec.vm.poke(dstAddr, state.memory[addr]);
        }
      });
    });

    this.channels.set(channel.id, channel);
    this.unsubs.set(channel.id, unsub);
    this._emit({ kind: 'channel:wired', channelId: channel.id });

    return () => this.removeChannel(channel.id);
  }

  removeChannel(id: string): boolean {
    const unsub = this.unsubs.get(id);
    if (!unsub) return false;
    unsub();
    this.unsubs.delete(id);
    this.channels.delete(id);
    this._emit({ kind: 'channel:removed', channelId: id });
    return true;
  }

  listChannels(): MemoryChannel[] {
    return [...this.channels.values()];
  }

  // ── Observation ───────────────────────────────────────────────────────────

  subscribe(listener: ManagerListener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  serialize(): SerializedManagerState {
    const windows: SerializedWindow[] = [...this.windows.values()].map(rec => ({
      id:         rec.id,
      title:      rec.title,
      status:     rec.status === 'running' ? 'paused' : rec.status,  // pause on save
      program_id: rec.config.program.id,
      speed:      rec.vm.speed,
      rect:       rec.rect,
      vmState:    serializeVMState(rec.vm.state),
    }));

    return {
      version:   EAI_PROTO,
      timestamp: new Date().toISOString(),
      windows,
      channels:  [...this.channels.values()],
    };
  }

  /**
   * Restore a serialized state.
   * Requires all referenced program IDs to be in the program registry.
   */
  restore(saved: SerializedManagerState): void {
    // Clear existing state
    this.resetAll();
    this.windows.clear();
    this.channels.clear();

    // Restore windows
    saved.windows.forEach(sw => {
      const prog = this.programs.get(sw.program_id);
      if (!prog) {
        console.warn(`VMWindowManager.restore: program '${sw.program_id}' not found, skipping`);
        return;
      }

      const config: WindowConfig = {
        id:      sw.id,
        title:   sw.title,
        program: prog,
        speed:   sw.speed,
        rect:    sw.rect,
      };

      const rec = this.createWindow(config);
      // Restore VM state
      const vmState = deserializeVMState(sw.vmState);
      // Inject restored memory & registers via poke
      rec.vm.pokeRange(0, Array.from(vmState.memory));
    });

    // Re-wire channels
    saved.channels.forEach(ch => {
      try { this.wire(ch); }
      catch (e) { console.warn(`VMWindowManager.restore: failed to wire channel '${ch.id}'`, e); }
    });
  }

  // ── AI Interface ──────────────────────────────────────────────────────────

  /**
   * Produce a structured topology description for AI consumption.
   * No execution required; snapshot of current state.
   */
  toManifest(): ManagerManifest {
    const windows = [...this.windows.values()].map(rec => ({
      id:      rec.id,
      title:   rec.title,
      status:  rec.status,
      program: rec.config.program.label,
      speed:   rec.vm.speed,
      ticks:   rec.vm.state.ticks,
      halted:  rec.vm.state.halted,
      pc:      `0x${hex2(rec.vm.state.pc)}`,
    }));

    const channels = [...this.channels.values()].map(ch => ({
      id:        ch.id,
      label:     ch.label ?? '',
      from:      ch.srcId,
      to:        ch.dstId,
      src_range: `0x${hex2(ch.srcStart)}..0x${hex2(ch.srcEnd)}`,
      dst_start: `0x${hex2(ch.dstStart)}`,
    }));

    const data_flow_graph = [...this.channels.values()].map(ch => ({
      src: ch.srcId,
      dst: ch.dstId,
    }));

    return {
      total_windows:    this.windows.size,
      total_channels:   this.channels.size,
      windows,
      channels,
      data_flow_graph,
    };
  }

  private _emit(event: ManagerEvent): void {
    this.listeners.forEach(fn => fn(event));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 7. Pipeline — declarative multi-VM composition
// ═══════════════════════════════════════════════════════════════════════════════

export interface PipelineConfig {
  id:       string;
  label:    string;
  windows:  WindowConfig[];
  channels: MemoryChannel[];
  autoRun?: boolean;
  speed?:   SpeedPreset;
}

/**
 * Create and initialise a VMWindowManager from a PipelineConfig.
 * All windows are created and channels wired before any execution starts.
 */
export function createPipeline(
  config:   PipelineConfig,
  programs: ProgramRegistry,
): VMWindowManager {
  const mgr = new VMWindowManager(programs);

  // Create all windows (autoRun=false initially)
  config.windows.forEach(wc => {
    mgr.createWindow({ ...wc, autoRun: false, speed: wc.speed ?? config.speed ?? 'NORM' });
  });

  // Wire all channels
  config.channels.forEach(ch => mgr.wire(ch));

  // Start execution if requested
  if (config.autoRun) {
    mgr.runAll(config.speed);
  }

  return mgr;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 8. Built-in Demo Pipelines
// ═══════════════════════════════════════════════════════════════════════════════

/*
 * DEMO: FIBONACCI → XOR_CIPHER Pipeline
 *
 * Topology:
 *   [fib-window]  writes  fib(0)–fib(10) → RAM[0x20..0x2A]
 *        ↓  channel: fib[0x20..0x2A] → cipher[0x40..0x4A]
 *   [cipher-window] XOR-encrypts live-updated data in RAM[0x40..0x4F]
 *
 * Effect: as Fibonacci numbers are generated and written by fib-window,
 * they are immediately mirrored into cipher-window's data region and
 * XOR-encrypted in place. The visual shows a live encrypted Fibonacci stream.
 */
import { PROGRAM_FIBONACCI, PROGRAM_COUNTER, PROGRAM_XOR_CIPHER, EAI_PROTO } from './eml-vm16-core';

export const DEMO_PIPELINE_FIBCIPHER: PipelineConfig = {
  id:    'demo-fib-cipher',
  label: 'FIBONACCI → XOR_CIPHER Live Pipeline',
  windows: [
    {
      id:      'fib-window',
      title:   'FIBONACCI generator',
      program: PROGRAM_FIBONACCI,
      speed:   'NORM',
    },
    {
      id:      'cipher-window',
      title:   'XOR_CIPHER (live input)',
      program: PROGRAM_XOR_CIPHER,
      speed:   'NORM',
    },
  ],
  channels: [
    {
      id:       'fib→cipher',
      srcId:    'fib-window',
      srcStart: 0x2E,   // fib data output region (relocated past code)
      srcEnd:   0x38,   // fib(0)–fib(10), 11 bytes
      dstId:    'cipher-window',
      dstStart: 0x40,   // cipher input region
      label:    'Fibonacci output → XOR cipher input',
    },
  ],
  autoRun: false,
  speed:   'NORM',
};

/*
 * DEMO: Dual Counter Pipeline
 *
 * Topology:
 *   [counter-a]  writes count 0–15 → RAM[0x10..0x1F]
 *        ↓  channel: a[0x10..0x1F] → b[0x10..0x1F]  (mirror)
 *   [counter-b]  receives mirrored count data, runs its own counter in parallel
 *
 * Effect: counter-b's data region reflects counter-a's output in real-time,
 * creating a visible synchronisation between two independent VMs.
 */
export const DEMO_PIPELINE_DUALCOUNT: PipelineConfig = {
  id:    'demo-dual-counter',
  label: 'Dual Counter with Live Mirror',
  windows: [
    {
      id:      'counter-a',
      title:   'COUNTER A (source)',
      program: PROGRAM_COUNTER,
      speed:   'SLOW',
    },
    {
      id:      'counter-b',
      title:   'COUNTER B (mirror)',
      program: PROGRAM_COUNTER,
      speed:   'FAST',
    },
  ],
  channels: [
    {
      id:       'a→b-mirror',
      srcId:    'counter-a',
      srcStart: 0x10,
      srcEnd:   0x1F,
      dstId:    'counter-b',
      dstStart: 0x10,
      label:    'Counter A output → Counter B memory mirror',
    },
  ],
  autoRun: false,
  speed:   'NORM',
};

// ═══════════════════════════════════════════════════════════════════════════════
// § 9. Utility Functions
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Validate a MemoryChannel configuration before wiring.
 * Checks address ranges, window existence, and overlap conflicts.
 */
export function validateChannel(
  channel: MemoryChannel,
  manager: VMWindowManager,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!manager.getWindow(channel.srcId))
    errors.push(`Source window '${channel.srcId}' not found`);
  if (!manager.getWindow(channel.dstId))
    errors.push(`Target window '${channel.dstId}' not found`);
  if (channel.srcId === channel.dstId)
    errors.push(`Source and target windows must be different`);
  if (channel.srcStart > channel.srcEnd)
    errors.push(`srcStart (0x${hex2(channel.srcStart)}) > srcEnd (0x${hex2(channel.srcEnd)})`);

  const rangeLen = channel.srcEnd - channel.srcStart + 1;
  const dstEnd   = (channel.dstStart + rangeLen - 1) & 0xFF;
  if (dstEnd < channel.dstStart && rangeLen > 1)
    errors.push(`Destination range wraps around address space`);

  return { valid: errors.length === 0, errors };
}

/**
 * Snapshot the current memory diff between two windows at matching address ranges.
 * Useful for debugging channel synchronisation.
 */
export function diffChannelMemory(
  channel: MemoryChannel,
  manager: VMWindowManager,
): Array<{ offset: number; srcAddr: u8; dstAddr: u8; srcVal: u8; dstVal: u8; synced: boolean }> {
  const src = manager.getWindowVM(channel.srcId);
  const dst = manager.getWindowVM(channel.dstId);
  if (!src || !dst) return [];

  const result = [];
  for (let i = 0; i <= channel.srcEnd - channel.srcStart; i++) {
    const srcAddr = (channel.srcStart + i) & 0xFF as u8;
    const dstAddr = (channel.dstStart + i) & 0xFF as u8;
    const srcVal  = src.peekAddr(srcAddr);
    const dstVal  = dst.peekAddr(dstAddr);
    result.push({ offset: i, srcAddr, dstAddr, srcVal, dstVal, synced: srcVal === dstVal });
  }
  return result;
}

/**
 * Build a program registry from an array of programs.
 * Convenience function for use with VMWindowManager constructor and restore().
 */
export function buildProgramRegistry(
  programs: (ProgramDefinition | CallableProgram)[],
): Map<string, ProgramDefinition | CallableProgram> {
  return new Map(programs.map(p => [p.id, p]));
}

/**
 * EML-VM64 Window System
 * EML-EAI-2026-v0.2 · INT: V2 multi-window layer (§6.4 #3)
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * The V2 analog of eml-vm16-window.ts. Phase 4's VMWindowManager only handled
 * V1 (8-bit, 256B) programs; this brings the same model — windows, cross-VM
 * memory channels, run scheduling — to EML-VM64's 16-bit / 64KB address space.
 *
 *   Window64VM        : stateful VM64 with poke() for cross-VM injection
 *   VM64WindowManager : multi-window scheduling + 16-bit memory channels
 *   createPipeline64  : declarative composition
 *
 * Channels carry 16-bit address ranges (number), matching VM64State.changed.
 */

import {
  VM64State, Program64, CTS64,
  makeVM64State, stepOnce64, stepN64,
  hex4,
} from './eml-vm64-core';

// ═══════════════════════════════════════════════════════════════════════════════
// § 1. Speed Configuration (shared cadence with V1)
// ═══════════════════════════════════════════════════════════════════════════════

export type SpeedPreset = 'SLOW' | 'NORM' | 'FAST' | 'TURBO';

export const SPEED_CONFIG64: Record<SpeedPreset, { ms: number; n: number }> = {
  SLOW:  { ms: 480, n: 1 },
  NORM:  { ms: 110, n: 1 },
  FAST:  { ms:  35, n: 1 },
  TURBO: { ms:  40, n: 6 },
};

// ═══════════════════════════════════════════════════════════════════════════════
// § 2. Window64VM — stateful VM64 with poke()
// ═══════════════════════════════════════════════════════════════════════════════

type VM64StateListener = (state: VM64State) => void;

export class Window64VM {
  readonly id:        string;
  private _state:     VM64State;
  private _program:   Program64;
  private _cts?:      Partial<CTS64>;
  private _timer:     ReturnType<typeof setInterval> | null = null;
  private _speed:     SpeedPreset = 'NORM';
  private _listeners: Set<VM64StateListener> = new Set();

  constructor(id: string, program: Program64, cts?: Partial<CTS64>) {
    this.id       = id;
    this._program = program;
    this._cts     = { ...(program.cts ?? {}), ...(cts ?? {}) };
    this._state   = makeVM64State(program);
  }

  // ── State Access ─────────────────────────────────────────────────────────
  get state(): VM64State { return this._state; }
  get halted(): boolean { return this._state.halted; }
  get running(): boolean { return this._timer !== null; }
  get speed(): SpeedPreset { return this._speed; }
  getMemory(): Readonly<Uint8Array> { return this._state.memory; }
  peekAddr(addr: number): number { return this._state.memory[addr & 0xFFFF]; }

  // ── Execution Control ─────────────────────────────────────────────────────
  step(): VM64State {
    if (this._state.halted) return this._state;
    this._state = stepOnce64(this._state, this._cts);
    this._notify();
    return this._state;
  }

  stepN(n: number): VM64State {
    if (this._state.halted) return this._state;
    this._state = stepN64(this._state, n, this._cts);
    this._notify();
    return this._state;
  }

  run(speed?: SpeedPreset): void {
    if (this._timer !== null || this._state.halted) return;
    if (speed) this._speed = speed;
    const { ms, n } = SPEED_CONFIG64[this._speed];
    this._timer = setInterval(() => {
      if (this._state.halted) { this.pauseExecution(); return; }
      this._state = stepN64(this._state, n, this._cts);
      this._notify();
    }, ms);
  }

  pauseExecution(): void {
    if (this._timer !== null) { clearInterval(this._timer); this._timer = null; }
  }

  setSpeed(speed: SpeedPreset): void {
    this._speed = speed;
    if (this._timer !== null) { this.pauseExecution(); this.run(); }
  }

  reset(): void {
    this.pauseExecution();
    this._state = makeVM64State(this._program);
    this._notify();
  }

  forceHalt(): void {
    this.pauseExecution();
    this._state = { ...this._state, halted: true };
    this._notify();
  }

  // ── Memory Injection (poke) — 16-bit addresses ────────────────────────────
  poke(addr: number, val: number): void {
    const memory = new Uint8Array(this._state.memory);
    memory[addr & 0xFFFF] = val & 0xFF;
    this._state = { ...this._state, memory, changed: new Set<number>([addr & 0xFFFF]) };
    this._notify();
  }

  pokeRange(startAddr: number, vals: number[]): void {
    if (vals.length === 0) return;
    const memory = new Uint8Array(this._state.memory);
    const changed = new Set<number>();
    vals.forEach((v, i) => {
      const a = (startAddr + i) & 0xFFFF;
      memory[a] = v & 0xFF;
      changed.add(a);
    });
    this._state = { ...this._state, memory, changed };
    this._notify();
  }

  // ── Observation ───────────────────────────────────────────────────────────
  subscribe(listener: VM64StateListener): () => void {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  }

  private _notify(): void {
    this._listeners.forEach(fn => fn(this._state));
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 3. Window & Channel Types (16-bit)
// ═══════════════════════════════════════════════════════════════════════════════

export type WindowStatus = 'running' | 'paused' | 'halted' | 'closed';

export interface Window64Config {
  id:       string;
  title:    string;
  program:  Program64;
  cts?:     Partial<CTS64>;
  autoRun?: boolean;
  speed?:   SpeedPreset;
}

export interface VM64WindowRecord {
  id:     string;
  title:  string;
  status: WindowStatus;
  vm:     Window64VM;
  config: Window64Config;
}

/**
 * A directed 16-bit memory channel. When any address in src[srcStart..srcEnd]
 * changes, the corresponding byte is poked into dst[dstStart + offset].
 */
export interface MemoryChannel64 {
  id:       string;
  srcId:    string;
  srcStart: number;   // 16-bit
  srcEnd:   number;   // 16-bit, inclusive
  dstId:    string;
  dstStart: number;   // 16-bit
  label?:   string;
}

export interface Manager64Manifest {
  arch:           'EML-VM64';
  total_windows:  number;
  total_channels: number;
  windows: Array<{
    id: string; title: string; status: WindowStatus;
    program: string; speed: SpeedPreset; ticks: number; halted: boolean; pc: string;
  }>;
  channels: Array<{
    id: string; label: string; from: string; to: string;
    src_range: string; dst_start: string;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 4. VM64WindowManager
// ═══════════════════════════════════════════════════════════════════════════════

type ProgramRegistry64 = Map<string, Program64>;

export class VM64WindowManager {
  private windows:  Map<string, VM64WindowRecord> = new Map();
  private channels: Map<string, MemoryChannel64>  = new Map();
  private unsubs:   Map<string, () => void>        = new Map();
  private programs: ProgramRegistry64              = new Map();

  constructor(programs?: ProgramRegistry64) {
    if (programs) programs.forEach((p, id) => this.programs.set(id, p));
  }

  registerProgram(program: Program64): void { this.programs.set(program.id, program); }

  // ── Window Lifecycle ─────────────────────────────────────────────────────
  createWindow(config: Window64Config): VM64WindowRecord {
    const vm = new Window64VM(config.id, config.program, config.cts);
    const record: VM64WindowRecord = { id: config.id, title: config.title, status: 'paused', vm, config };
    this.windows.set(config.id, record);
    vm.subscribe(state => {
      if (state.halted && record.status !== 'halted') record.status = 'halted';
    });
    if (config.autoRun) this.runWindow(config.id, config.speed);
    return record;
  }

  closeWindow(id: string): boolean {
    const record = this.windows.get(id);
    if (!record) return false;
    record.vm.forceHalt();
    record.status = 'closed';
    [...this.channels.keys()].forEach(cid => {
      const ch = this.channels.get(cid)!;
      if (ch.srcId === id || ch.dstId === id) this.removeChannel(cid);
    });
    this.windows.delete(id);
    return true;
  }

  getWindow(id: string): VM64WindowRecord | undefined { return this.windows.get(id); }
  getWindowVM(id: string): Window64VM | undefined { return this.windows.get(id)?.vm; }
  listWindows(): VM64WindowRecord[] { return [...this.windows.values()]; }

  // ── Execution Control ─────────────────────────────────────────────────────
  runWindow(id: string, speed?: SpeedPreset): void {
    const rec = this.windows.get(id);
    if (!rec || rec.status === 'closed') return;
    rec.vm.run(speed ?? rec.config.speed);
    rec.status = 'running';
  }

  pauseWindow(id: string): void {
    const rec = this.windows.get(id);
    if (!rec) return;
    rec.vm.pauseExecution();
    if (rec.status === 'running') rec.status = 'paused';
  }

  resetWindow(id: string): void {
    const rec = this.windows.get(id);
    if (!rec) return;
    rec.vm.reset();
    rec.status = 'paused';
  }

  runAll(speed?: SpeedPreset): void {
    this.windows.forEach((rec, id) => {
      if (rec.status !== 'halted' && rec.status !== 'closed') this.runWindow(id, speed);
    });
  }
  pauseAll(): void { this.windows.forEach((_, id) => this.pauseWindow(id)); }
  resetAll(): void {
    this.channels.forEach((_, id) => this.removeChannel(id));
    this.windows.forEach((_, id) => this.resetWindow(id));
  }
  setWindowSpeed(id: string, speed: SpeedPreset): void { this.windows.get(id)?.vm.setSpeed(speed); }

  // ── Memory Channels (16-bit cross-VM wiring) ──────────────────────────────
  wire(channel: MemoryChannel64): () => void {
    if (this.channels.has(channel.id)) throw new Error(`Channel '${channel.id}' already exists`);
    const srcRec = this.windows.get(channel.srcId);
    const dstRec = this.windows.get(channel.dstId);
    if (!srcRec) throw new Error(`Source window '${channel.srcId}' not found`);
    if (!dstRec) throw new Error(`Target window '${channel.dstId}' not found`);

    const unsub = srcRec.vm.subscribe(state => {
      state.changed.forEach(addr => {
        if (addr >= channel.srcStart && addr <= channel.srcEnd) {
          const offset  = addr - channel.srcStart;
          const dstAddr = (channel.dstStart + offset) & 0xFFFF;
          dstRec.vm.poke(dstAddr, state.memory[addr]);
        }
      });
    });

    this.channels.set(channel.id, channel);
    this.unsubs.set(channel.id, unsub);
    return () => this.removeChannel(channel.id);
  }

  removeChannel(id: string): boolean {
    const unsub = this.unsubs.get(id);
    if (!unsub) return false;
    unsub();
    this.unsubs.delete(id);
    this.channels.delete(id);
    return true;
  }

  listChannels(): MemoryChannel64[] { return [...this.channels.values()]; }

  // ── AI Interface ──────────────────────────────────────────────────────────
  toManifest(): Manager64Manifest {
    return {
      arch: 'EML-VM64',
      total_windows:  this.windows.size,
      total_channels: this.channels.size,
      windows: [...this.windows.values()].map(rec => ({
        id: rec.id, title: rec.title, status: rec.status,
        program: rec.config.program.label, speed: rec.vm.speed,
        ticks: rec.vm.state.ticks, halted: rec.vm.state.halted,
        pc: `0x${hex4(rec.vm.state.pc)}`,
      })),
      channels: [...this.channels.values()].map(ch => ({
        id: ch.id, label: ch.label ?? '', from: ch.srcId, to: ch.dstId,
        src_range: `0x${hex4(ch.srcStart)}..0x${hex4(ch.srcEnd)}`,
        dst_start: `0x${hex4(ch.dstStart)}`,
      })),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 5. Pipeline composition
// ═══════════════════════════════════════════════════════════════════════════════

export interface Pipeline64Config {
  id:       string;
  label:    string;
  windows:  Window64Config[];
  channels: MemoryChannel64[];
  autoRun?: boolean;
  speed?:   SpeedPreset;
}

export function createPipeline64(
  config: Pipeline64Config,
  programs: ProgramRegistry64,
): VM64WindowManager {
  const mgr = new VM64WindowManager(programs);
  config.windows.forEach(wc =>
    mgr.createWindow({ ...wc, autoRun: false, speed: wc.speed ?? config.speed ?? 'NORM' }));
  config.channels.forEach(ch => mgr.wire(ch));
  if (config.autoRun) mgr.runAll(config.speed);
  return mgr;
}

export function buildProgramRegistry64(programs: Program64[]): Map<string, Program64> {
  return new Map(programs.map(p => [p.id, p]));
}

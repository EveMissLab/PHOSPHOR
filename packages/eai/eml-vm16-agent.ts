/**
 * EML-VM-16 Agent Stream Interface
 * EML-EAI-2026-v0.1 · Phase 5: AI Agent JSON Stream Interface
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Builds on Phase 4 (eml-vm16-window.ts).
 *
 * Design: transport-agnostic protocol layer.
 *   - AgentSession   handles all protocol logic
 *   - AgentTransport is the only interface transports must implement
 *   - Adapters: BrowserWebSocket, NodeWebSocket, InProcess, SSE
 *
 * Agent interaction model:
 *   1. Connect → receive 'event:welcome' with manager manifest
 *   2. Subscribe to windows  →  receive 'event:snapshot' stream
 *   3. Send commands (step/run/poke/call/...)  →  receive 'ack'
 *   4. Disconnect cleanly via 'cmd:disconnect'
 *
 * "The VM state stream is a first-class input format for AI agents."
 *                                     — EML-EAI-2026 §4.2
 */

import {
  u8, VMState, VMSnapshot,
  hex2, REG_NAMES, EAI_PROTO,
} from './eml-vm16-core';

import {
  VMWindowManager, VMWindowRecord, WindowVM,
  ManagerManifest, SpeedPreset,
  SerializedManagerState,
} from './eml-vm16-window';

import {
  CallableVM, VMCallResult,
} from './eml-vm16-callable';

// ═══════════════════════════════════════════════════════════════════════════════
// § 1. Protocol Types — Events (server → agent)
// ═══════════════════════════════════════════════════════════════════════════════

export interface StreamSnapshot {
  // Extends VMSnapshot (Phase 2) with window context
  vm_id:             string;
  tick:              number;
  pc:                string;
  pc_symbol:         string | null;
  pc_comment:        string | null;
  instruction:       string;
  registers:         Record<string, number>;
  flags:             { Z: boolean; N: boolean; G: boolean };
  changed_this_tick: Array<{
    addr:   string;
    symbol: string | null;
    before: u8;
    after:  u8;
  }>;
  stack_depth: number;
  halted:      boolean;
  // Window-level context
  window_id:    string;
  window_title: string;
  program_id:   string;
}

export type AgentEventType =
  | 'event:welcome'
  | 'event:snapshot'
  | 'event:halted'
  | 'event:manifest'
  | 'event:channel_sync'
  | 'event:window_status'
  | 'event:call_result'
  | 'event:error'
  | 'ack';

export interface EvtWelcome {
  type:     'event:welcome';
  session:  string;         // session UUID
  manifest: ManagerManifest;
  proto:    string;         // protocol version
}

export interface EvtSnapshot {
  type:     'event:snapshot';
  snapshot: StreamSnapshot;
}

export interface EvtHalted {
  type:     'event:halted';
  windowId: string;
  ticks:    number;
}

export interface EvtManifest {
  type:     'event:manifest';
  manifest: ManagerManifest;
}

export interface EvtChannelSync {
  type:      'event:channel_sync';
  channelId: string;
  writes:    Array<{ addr: string; val: u8 }>;
}

export interface EvtWindowStatus {
  type:     'event:window_status';
  windowId: string;
  status:   string;
}

export interface EvtCallResult {
  type:        'event:call_result';
  cmdId:       string;
  windowId:    string;
  fn:          string;
  returnValue: u8 | null;
  steps:       number;
  timedOut:    boolean;
  memWrites:   Array<{ addr: string; before: u8; after: u8 }>;
}

export interface EvtError {
  type:    'event:error';
  code:    string;
  message: string;
}

export interface EvtAck {
  type:    'ack';
  cmdId:   string;
  ok:      boolean;
  error?:  string;
  payload?: unknown;
}

export type AgentEvent =
  | EvtWelcome | EvtSnapshot | EvtHalted | EvtManifest
  | EvtChannelSync | EvtWindowStatus | EvtCallResult
  | EvtError | EvtAck;

// ═══════════════════════════════════════════════════════════════════════════════
// § 2. Protocol Types — Commands (agent → server)
// ═══════════════════════════════════════════════════════════════════════════════

export type AgentCommandType =
  | 'cmd:step'
  | 'cmd:stepN'
  | 'cmd:run'
  | 'cmd:pause'
  | 'cmd:halt'
  | 'cmd:reset'
  | 'cmd:poke'
  | 'cmd:pokeRange'
  | 'cmd:call'
  | 'cmd:subscribe'
  | 'cmd:unsubscribe'
  | 'cmd:getManifest'
  | 'cmd:getSnapshot'
  | 'cmd:setSpeed'
  | 'cmd:serialize'
  | 'cmd:disconnect';

interface CmdBase { cmdId: string; }

export interface CmdStep       extends CmdBase { type:'cmd:step';       windowId: string }
export interface CmdStepN      extends CmdBase { type:'cmd:stepN';      windowId: string; n: number }
export interface CmdRun        extends CmdBase { type:'cmd:run';        windowId: string; speed?: SpeedPreset }
export interface CmdPause      extends CmdBase { type:'cmd:pause';      windowId: string }
export interface CmdHalt       extends CmdBase { type:'cmd:halt';       windowId: string }
export interface CmdReset      extends CmdBase { type:'cmd:reset';      windowId: string }
export interface CmdPoke       extends CmdBase { type:'cmd:poke';       windowId: string; addr: number; val: number }
export interface CmdPokeRange  extends CmdBase { type:'cmd:pokeRange';  windowId: string; startAddr: number; vals: number[] }
export interface CmdCall       extends CmdBase { type:'cmd:call';       windowId: string; fn: string; args?: number[] }
export interface CmdSubscribe  extends CmdBase { type:'cmd:subscribe';  config: SubscriptionConfig }
export interface CmdUnsubscribe extends CmdBase { type:'cmd:unsubscribe'; subId: string }
export interface CmdGetManifest extends CmdBase { type:'cmd:getManifest' }
export interface CmdGetSnapshot extends CmdBase { type:'cmd:getSnapshot'; windowId: string }
export interface CmdSetSpeed   extends CmdBase { type:'cmd:setSpeed';   windowId: string; speed: SpeedPreset }
export interface CmdSerialize  extends CmdBase { type:'cmd:serialize' }
export interface CmdDisconnect extends CmdBase { type:'cmd:disconnect' }

export type AgentCommand =
  | CmdStep | CmdStepN | CmdRun | CmdPause | CmdHalt | CmdReset
  | CmdPoke | CmdPokeRange | CmdCall
  | CmdSubscribe | CmdUnsubscribe
  | CmdGetManifest | CmdGetSnapshot | CmdSetSpeed
  | CmdSerialize | CmdDisconnect;

export type AgentMessage = AgentEvent | AgentCommand;

// ═══════════════════════════════════════════════════════════════════════════════
// § 3. Subscription Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export type SubscriptionMode =
  | 'all-ticks'     // send snapshot on every execution tick
  | 'on-change'     // send snapshot only when watched addresses change
  | 'periodic'      // send snapshot every N ticks
  | 'events-only';  // send only halted/status events, no tick snapshots

export interface SubscriptionConfig {
  subId:          string;
  windowId:       string;
  mode:           SubscriptionMode;
  watchAddrs?:    u8[];      // for 'on-change': trigger only if these change
  periodTicks?:   number;    // for 'periodic': emit every N ticks
  includeMemory?: boolean;   // include full 256-byte memory dump (large!)
  maxRate?:       number;    // maximum events per second (throttle)
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 4. Transport Interface
// All transports must implement this interface.
// AgentSession is completely transport-agnostic.
// ═══════════════════════════════════════════════════════════════════════════════

export interface AgentTransport {
  /** Send a message to the remote agent. */
  send(msg: AgentMessage): void;

  /** Register a handler for incoming messages. Returns unsubscribe fn. */
  onMessage(handler: (msg: AgentMessage) => void): () => void;

  /** Register a handler for transport close. Returns unsubscribe fn. */
  onClose(handler: () => void): () => void;

  /** True if the transport is currently open/connected. */
  readonly isOpen: boolean;
}

// ── 4a. Browser WebSocket Transport ──────────────────────────────────────────

/**
 * Wraps a browser WebSocket (or any WebSocket-compatible object).
 * Compatible with: browser WebSocket, `ws` package, `socket.io` raw socket.
 */
export function createWebSocketTransport(ws: {
  send: (data: string) => void;
  // Loosely typed so a real browser `WebSocket`, the `ws` package, or a
  // socket.io raw socket all satisfy it — their event APIs are generically
  // typed over an event map and won't match a narrow (ev: string, fn) shape.
  addEventListener?: (...args: any[]) => void;
  on?:              (...args: any[]) => void;
  readyState?:      number;
}): AgentTransport {
  const msgHandlers: Set<(m: AgentMessage) => void> = new Set();
  const closeHandlers: Set<() => void> = new Set();

  const onMsg = (data: unknown) => {
    try {
      const msg = JSON.parse(typeof data === 'string' ? data : String(data)) as AgentMessage;
      msgHandlers.forEach(h => h(msg));
    } catch { /* ignore malformed messages */ }
  };

  // Support both browser EventTarget API and Node.js EventEmitter API
  if (typeof (ws as any).addEventListener === 'function') {
    (ws as any).addEventListener('message', (e: MessageEvent) => onMsg(e.data));
    (ws as any).addEventListener('close', () => closeHandlers.forEach(h => h()));
  } else if (typeof (ws as any).on === 'function') {
    (ws as any).on('message', onMsg);
    (ws as any).on('close', () => closeHandlers.forEach(h => h()));
  }

  return {
    send(msg) { ws.send(JSON.stringify(msg)); },
    onMessage(h) { msgHandlers.add(h); return () => msgHandlers.delete(h); },
    onClose(h)   { closeHandlers.add(h); return () => closeHandlers.delete(h); },
    get isOpen() { return (ws.readyState ?? 1) === 1; },
  };
}

// ── 4b. In-Process Transport (for testing & direct integration) ───────────────

export interface InProcessPair {
  /** Agent side: receives events from server, sends commands to server. */
  agentSide:  AgentTransport;
  /** Server side: receives commands from agent, sends events to agent. */
  serverSide: AgentTransport;
}

type InProcessHalf = AgentTransport & {
  _receive: (m: AgentMessage) => void;
  _close:   () => void;
};

/** Create a paired in-process transport. No network required. */
export function createInProcessTransport(): InProcessPair {
  // `send` is a placeholder here; it is cross-wired to the peer below, once
  // both halves exist. Splitting construction from wiring avoids a circular
  // reference between the two halves.
  const makeHalf = (): InProcessHalf => {
    const listeners:      Set<(m: AgentMessage) => void> = new Set();
    const closeListeners: Set<() => void>                = new Set();
    let   open = true;

    return {
      send(_msg) { /* cross-wired after both halves are constructed */ },
      onMessage(h)  { listeners.add(h);      return () => listeners.delete(h); },
      onClose(h)    { closeListeners.add(h); return () => closeListeners.delete(h); },
      get isOpen()  { return open; },
      _receive(msg) { listeners.forEach(h => h(msg)); },
      _close()      { open = false; closeListeners.forEach(h => h()); },
    };
  };

  const agentSide  = makeHalf();
  const serverSide = makeHalf();
  // Cross-wire: each side's send delivers to the other's _receive.
  agentSide.send  = (msg: AgentMessage) => setTimeout(() => serverSide._receive(msg), 0);
  serverSide.send = (msg: AgentMessage) => setTimeout(() => agentSide._receive(msg), 0);

  return { agentSide, serverSide };
}

// ── 4c. SSE Transport (server → agent only; agent → server via HTTP POST) ─────

/**
 * SSE transport skeleton for Node.js.
 * `res` is a Node.js `ServerResponse`.
 * Commands must arrive via a separate HTTP POST endpoint and be
 * injected via the returned `injectCommand` function.
 */
export function createSSETransport(res: {
  writeHead: (code: number, headers: Record<string, string>) => void;
  write:     (data: string) => void;
  on:        (ev: string, fn: () => void) => void;
}): AgentTransport & { injectCommand: (msg: AgentMessage) => void } {
  const msgHandlers:   Set<(m: AgentMessage) => void> = new Set();
  const closeHandlers: Set<() => void>                = new Set();
  let   open = true;

  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.on('close', () => { open = false; closeHandlers.forEach(h => h()); });

  return {
    send(msg) {
      if (!open) return;
      res.write(`data: ${JSON.stringify(msg)}\n\n`);
    },
    onMessage(h)  { msgHandlers.add(h);      return () => msgHandlers.delete(h); },
    onClose(h)    { closeHandlers.add(h);    return () => closeHandlers.delete(h); },
    get isOpen()  { return open; },
    injectCommand(msg) { msgHandlers.forEach(h => h(msg)); },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 5. Snapshot Builder
// ═══════════════════════════════════════════════════════════════════════════════

/** Build a StreamSnapshot from a WindowVM and its record. */
export function buildStreamSnapshot(
  vm:    WindowVM,
  rec:   VMWindowRecord,
  cts?:  { symbolTable?: Map<u8, { name: string }>; commentTable?: Map<u8, string> },
  prevMem?: Uint8Array,
): StreamSnapshot {
  const s   = vm.state;
  const mem = s.memory;
  const op  = mem[s.pc];
  const arg = mem[(s.pc + 1) & 0xFF];

  const sym  = cts?.symbolTable;
  const cmt  = cts?.commentTable;

  const changed = [...s.changed].map(addr => ({
    addr:   `0x${hex2(addr)}`,
    symbol: sym?.get(addr)?.name ?? null,
    before: prevMem ? prevMem[addr] : s.memory[addr],
    after:  s.memory[addr],
  }));

  const registers: Record<string, number> = {};
  REG_NAMES.forEach((n, i) => { registers[n] = s.regs[i]; });

  // Decode instruction
  let instruction: string;
  try {
    // Dynamic import compatibility: use inline decode if import unavailable
    const d = (arg >> 4) & 0xF, sv = arg & 0xF, A = `0x${hex2(arg)}`;
    const MN: Record<number, string> = {
      0x00:'NOP', 0x01:'HALT',
      0x10:`MOV R${d},R${sv}`, 0x11:`MOVI R${d},#${sv}`,
      0x20:`ADD R${d},R${sv}`, 0x21:`ADDI R${d},#${sv}`,
      0x22:`SUB R${d},R${sv}`, 0x23:`SUBI R${d},#${sv}`,
      0x30:`AND R${d},R${sv}`, 0x31:`OR R${d},R${sv}`,
      0x32:`XOR R${d},R${sv}`, 0x33:`NOT R${d}`,
      0x40:`CMP R${d},R${sv}`, 0x41:`INC R${d}`, 0x42:`DEC R${d}`,
      0x50:`JMP ${A}`, 0x51:`JZ ${A}`,  0x52:`JNZ ${A}`,
      0x53:`JG ${A}`,  0x54:`JL ${A}`,  0x55:`JGE ${A}`, 0x56:`JLE ${A}`,
      0x60:`PUSH R${d}`, 0x61:`POP R${d}`,
      0x70:`CALL ${A}`, 0x71:'RET',
      0x80:`LD R${d},[R${sv}]`, 0x81:`ST [R${d}],R${sv}`,
    };
    instruction = MN[op] ?? `??? ${hex2(op)}:${hex2(arg)}`;
  } catch { instruction = `${hex2(op)} ${hex2(arg)}`; }

  return {
    vm_id:             rec.id,
    tick:              s.ticks,
    pc:                `0x${hex2(s.pc)}`,
    pc_symbol:         sym?.get(s.pc)?.name ?? null,
    pc_comment:        cmt?.get(s.pc) ?? null,
    instruction,
    registers,
    flags:             { Z: s.flags.z, N: s.flags.neg, G: s.flags.gt },
    changed_this_tick: changed,
    stack_depth:       (0xFF - s.sp) & 0xFF,
    halted:            s.halted,
    window_id:         rec.id,
    window_title:      rec.title,
    program_id:        rec.config.program.id,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 6. AgentSession — protocol handler
// ═══════════════════════════════════════════════════════════════════════════════

let _sessionCounter = 0;

export class AgentSession {
  readonly sessionId: string;

  private transport:     AgentTransport;
  private manager:       VMWindowManager;
  private subs:          Map<string, SubscriptionConfig>   = new Map();
  private vmUnsubs:      Map<string, () => void>           = new Map();
  private prevMemory:    Map<string, Uint8Array>           = new Map();
  private tickCounts:    Map<string, number>               = new Map();
  private rateLimiters:  Map<string, number>               = new Map();
  private cleanupFns:    (() => void)[]                    = [];
  private closed = false;

  constructor(transport: AgentTransport, manager: VMWindowManager) {
    this.sessionId = `session-${++_sessionCounter}-${Date.now().toString(36)}`;
    this.transport = transport;
    this.manager   = manager;

    // Register incoming command handler
    const unsubMsg = transport.onMessage(msg => this._handleMessage(msg));
    const unsubClose = transport.onClose(() => this.close());
    this.cleanupFns.push(unsubMsg, unsubClose);

    // Send welcome with current manifest
    this._send({
      type:     'event:welcome',
      session:  this.sessionId,
      manifest: manager.toManifest(),
      proto:    EAI_PROTO,
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Terminate the session and clean up all subscriptions. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.vmUnsubs.forEach(fn => fn());
    this.cleanupFns.forEach(fn => fn());
  }

  // ── Command Dispatch ───────────────────────────────────────────────────────

  private _handleMessage(msg: AgentMessage): void {
    if (!('cmdId' in msg)) return;  // ignore events that arrive (shouldn't happen)
    const cmd = msg as AgentCommand;
    try {
      this._dispatch(cmd);
    } catch (err) {
      this._ack(cmd.cmdId, false, String(err));
    }
  }

  private _dispatch(cmd: AgentCommand): void {
    switch (cmd.type) {
      case 'cmd:step': {
        const vm = this._requireVM(cmd.windowId);
        vm.step();
        this._ack(cmd.cmdId, true);
        break;
      }
      case 'cmd:stepN': {
        const vm = this._requireVM(cmd.windowId);
        vm.stepN(cmd.n);
        this._ack(cmd.cmdId, true);
        break;
      }
      case 'cmd:run': {
        const rec = this._requireRec(cmd.windowId);
        this.manager.runWindow(cmd.windowId, cmd.speed);
        this._ack(cmd.cmdId, true);
        break;
      }
      case 'cmd:pause': {
        this.manager.pauseWindow(cmd.windowId);
        this._ack(cmd.cmdId, true);
        break;
      }
      case 'cmd:halt': {
        this._requireVM(cmd.windowId).forceHalt();
        this._ack(cmd.cmdId, true);
        break;
      }
      case 'cmd:reset': {
        this.manager.resetWindow(cmd.windowId);
        this._ack(cmd.cmdId, true);
        break;
      }
      case 'cmd:poke': {
        const vm = this._requireVM(cmd.windowId);
        if (cmd.addr < 0 || cmd.addr > 255) throw new RangeError(`addr out of range: ${cmd.addr}`);
        if (cmd.val  < 0 || cmd.val  > 255) throw new RangeError(`val out of range: ${cmd.val}`);
        vm.poke(cmd.addr as u8, cmd.val as u8);
        this._ack(cmd.cmdId, true);
        break;
      }
      case 'cmd:pokeRange': {
        const vm = this._requireVM(cmd.windowId);
        vm.pokeRange(cmd.startAddr as u8, cmd.vals as u8[]);
        this._ack(cmd.cmdId, true);
        break;
      }
      case 'cmd:call': {
        this._handleCall(cmd);
        break;
      }
      case 'cmd:subscribe': {
        this._handleSubscribe(cmd);
        this._ack(cmd.cmdId, true, undefined, { subId: cmd.config.subId });
        break;
      }
      case 'cmd:unsubscribe': {
        this._handleUnsubscribe(cmd.subId);
        this._ack(cmd.cmdId, true);
        break;
      }
      case 'cmd:getManifest': {
        this._send({ type: 'event:manifest', manifest: this.manager.toManifest() });
        this._ack(cmd.cmdId, true);
        break;
      }
      case 'cmd:getSnapshot': {
        const rec = this._requireRec(cmd.windowId);
        const snap = buildStreamSnapshot(rec.vm, rec);
        this._send({ type: 'event:snapshot', snapshot: snap });
        this._ack(cmd.cmdId, true);
        break;
      }
      case 'cmd:setSpeed': {
        this.manager.setWindowSpeed(cmd.windowId, cmd.speed);
        this._ack(cmd.cmdId, true);
        break;
      }
      case 'cmd:serialize': {
        const saved = this.manager.serialize();
        this._ack(cmd.cmdId, true, undefined, saved);
        break;
      }
      case 'cmd:disconnect': {
        this._ack(cmd.cmdId, true);
        this.close();
        break;
      }
      default: {
        const t = (cmd as any).type;
        this._ack((cmd as any).cmdId, false, `Unknown command: ${t}`);
      }
    }
  }

  // ── Subscription Handlers ──────────────────────────────────────────────────

  private _handleSubscribe(cmd: CmdSubscribe): void {
    const { config } = cmd;
    const { subId, windowId } = config;

    // Remove existing sub with same id if any
    this._handleUnsubscribe(subId);

    const rec = this._requireRec(windowId);
    this.subs.set(subId, config);
    this.prevMemory.set(subId, new Uint8Array(rec.vm.state.memory));
    this.tickCounts.set(subId, 0);

    let lastSent = 0;

    const unsub = rec.vm.subscribe(state => {
      const cfg = this.subs.get(subId);
      if (!cfg) return;

      const now = Date.now();
      if (cfg.maxRate && (now - lastSent) < 1000 / cfg.maxRate) return;

      const count = (this.tickCounts.get(subId) ?? 0) + 1;
      this.tickCounts.set(subId, count);

      let shouldSend = false;
      switch (cfg.mode) {
        case 'all-ticks':   shouldSend = true; break;
        case 'on-change':
          if (!cfg.watchAddrs || cfg.watchAddrs.length === 0) {
            shouldSend = state.changed.size > 0;
          } else {
            shouldSend = cfg.watchAddrs.some(a => state.changed.has(a));
          }
          break;
        case 'periodic':
          shouldSend = count % (cfg.periodTicks ?? 10) === 0;
          break;
        case 'events-only':
          shouldSend = false;   // only halted/status, handled separately
          break;
      }

      if (shouldSend) {
        const prevMem = this.prevMemory.get(subId);
        const snap = buildStreamSnapshot(rec.vm, rec, rec.config.cts as any, prevMem);
        this._send({ type: 'event:snapshot', snapshot: snap });
        this.prevMemory.set(subId, new Uint8Array(state.memory));
        lastSent = now;
      }

      if (state.halted) {
        this._send({ type: 'event:halted', windowId, ticks: state.ticks });
      }
    });

    this.vmUnsubs.set(subId, unsub);
  }

  private _handleUnsubscribe(subId: string): void {
    const unsub = this.vmUnsubs.get(subId);
    if (unsub) { unsub(); this.vmUnsubs.delete(subId); }
    this.subs.delete(subId);
    this.prevMemory.delete(subId);
    this.tickCounts.delete(subId);
  }

  // ── Async Call Handler ─────────────────────────────────────────────────────

  private _handleCall(cmd: CmdCall): void {
    const rec = this._requireRec(cmd.windowId);
    // WindowVM exposes a CallableVM iff its program exports functions.
    const cvm = rec.vm.callableVM;

    if (!cvm) {
      this._ack(cmd.cmdId, false, `Window '${cmd.windowId}' does not have a CallableVM`);
      return;
    }

    cvm.call(cmd.fn, (cmd.args ?? []) as u8[]).then(result => {
      const writes = [...result.memoryDiff.entries()].map(([addr, d]) => ({
        addr:   `0x${hex2(addr)}`,
        before: d.before,
        after:  d.after,
      }));
      this._send({
        type:        'event:call_result',
        cmdId:       cmd.cmdId,
        windowId:    cmd.windowId,
        fn:          cmd.fn,
        returnValue: result.returnValue,
        steps:       result.steps,
        timedOut:    result.timedOut,
        memWrites:   writes,
      });
      this._ack(cmd.cmdId, true);
    }).catch(err => {
      this._ack(cmd.cmdId, false, String(err));
    });
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private _requireRec(windowId: string): VMWindowRecord {
    const rec = this.manager.getWindow(windowId);
    if (!rec) throw new Error(`Window '${windowId}' not found`);
    return rec;
  }

  private _requireVM(windowId: string): WindowVM {
    return this._requireRec(windowId).vm;
  }

  private _ack(cmdId: string, ok: boolean, error?: string, payload?: unknown): void {
    this._send({ type: 'ack', cmdId, ok, ...(error ? { error } : {}), ...(payload !== undefined ? { payload } : {}) });
  }

  private _send(msg: AgentEvent): void {
    if (!this.closed && this.transport.isOpen) {
      this.transport.send(msg);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 7. AgentRecorder & AgentReplayer
// ═══════════════════════════════════════════════════════════════════════════════

export interface ReplayEntry {
  t:       number;        // milliseconds from session start
  dir:     'in' | 'out'; // 'out' = server→agent, 'in' = agent→server
  message: AgentMessage;
}

/**
 * Wraps a transport and records every message in both directions.
 * Used for debugging, demo generation, and regression testing.
 */
export class AgentRecorder {
  private log:    ReplayEntry[] = [];
  private start:  number = Date.now();
  private unsubs: (() => void)[] = [];
  private _recording = false;

  wrap(transport: AgentTransport): AgentTransport {
    this.start     = Date.now();
    this._recording = true;
    const log      = this.log;
    const t0       = this.start;

    // Intercept outbound (server → agent)
    const originalSend = transport.send.bind(transport);
    const wrappedTransport: AgentTransport = {
      send(msg) {
        log.push({ t: Date.now() - t0, dir: 'out', message: msg });
        originalSend(msg);
      },
      onMessage(handler) {
        return transport.onMessage(msg => {
          log.push({ t: Date.now() - t0, dir: 'in', message: msg });
          handler(msg);
        });
      },
      onClose:  transport.onClose.bind(transport),
      get isOpen() { return transport.isOpen; },
    };
    return wrappedTransport;
  }

  stop(): ReplayEntry[] {
    this._recording = false;
    return [...this.log];
  }

  getLog(): ReplayEntry[] { return [...this.log]; }

  isRecording(): boolean { return this._recording; }

  /** Export log as compact JSON for storage. */
  toJSON(): string {
    return JSON.stringify(this.log, null, 2);
  }

  /** Load a previously saved log. */
  static fromJSON(json: string): ReplayEntry[] {
    return JSON.parse(json) as ReplayEntry[];
  }
}

/**
 * Replay a recorded session against a real AgentSession.
 * Replays only inbound commands (agent → server); ignores outbound events.
 * Timing is preserved (relative delays between commands).
 */
export class AgentReplayer {
  async replay(
    entries:   ReplayEntry[],
    transport: AgentTransport,
    opts: { speed?: number; onEntry?: (e: ReplayEntry) => void } = {},
  ): Promise<void> {
    const speed = opts.speed ?? 1.0;
    const incoming = entries.filter(e => e.dir === 'in');

    let prev = 0;
    for (const entry of incoming) {
      const delay = ((entry.t - prev) / speed);
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      prev = entry.t;
      opts.onEntry?.(entry);
      transport.send(entry.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 8. Session Factory & Server Bootstrap
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Create a new AgentSession from a transport and manager.
 * The session is active immediately; the welcome message is sent synchronously.
 */
export function createSession(
  transport: AgentTransport,
  manager:   VMWindowManager,
): AgentSession {
  return new AgentSession(transport, manager);
}

/**
 * Node.js WebSocket server bootstrap.
 * Usage (requires the `ws` npm package):
 *
 *   import { WebSocketServer } from 'ws';
 *   import { VMWindowManager } from './eml-vm16-window';
 *   import { bootstrapWSServer, createWebSocketTransport } from './eml-vm16-agent';
 *
 *   const wss = new WebSocketServer({ port: 8765 });
 *   const mgr = new VMWindowManager(...);
 *   bootstrapWSServer(wss, mgr);
 *
 * Each connected agent gets its own independent AgentSession.
 */
export function bootstrapWSServer(
  wss: { on: (ev: string, fn: (ws: any) => void) => void },
  manager: VMWindowManager,
  opts: {
    onSession?:  (session: AgentSession) => void;
    onClose?:    (session: AgentSession) => void;
  } = {},
): void {
  wss.on('connection', (ws: any) => {
    const transport = createWebSocketTransport(ws);
    const session   = createSession(transport, manager);
    opts.onSession?.(session);
    transport.onClose(() => {
      session.close();
      opts.onClose?.(session);
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// § 9. Agent Interaction Helper (for testing / scripting AI agents)
// ═══════════════════════════════════════════════════════════════════════════════

let _cmdIdCounter = 0;
export const nextCmdId = () => `cmd-${++_cmdIdCounter}`;

/**
 * A simple programmatic agent client for in-process testing.
 * Wraps the agent side of an InProcessPair.
 */
export class AgentClient {
  private transport: AgentTransport;
  private pending:   Map<string, { resolve: (v: EvtAck) => void; reject: (e: Error) => void }> = new Map();
  private eventHandlers: Map<AgentEventType, Set<(e: AgentEvent) => void>> = new Map();

  constructor(transport: AgentTransport) {
    this.transport = transport;
    transport.onMessage(msg => {
      if ((msg as AgentEvent).type === 'ack') {
        const ack = msg as EvtAck;
        const p = this.pending.get(ack.cmdId);
        if (p) {
          this.pending.delete(ack.cmdId);
          ack.ok ? p.resolve(ack) : p.reject(new Error(ack.error ?? 'unknown error'));
        }
      }
      const handlers = this.eventHandlers.get((msg as AgentEvent).type as AgentEventType);
      handlers?.forEach(h => h(msg as AgentEvent));
    });
  }

  /** Send a command and await its ack. */
  cmd<T extends AgentCommand>(msg: Omit<T, 'cmdId'>): Promise<EvtAck> {
    const cmdId = nextCmdId();
    const full  = { ...msg, cmdId } as AgentMessage;
    return new Promise((resolve, reject) => {
      this.pending.set(cmdId, { resolve, reject });
      this.transport.send(full);
    });
  }

  on(type: AgentEventType, handler: (e: AgentEvent) => void): () => void {
    if (!this.eventHandlers.has(type)) this.eventHandlers.set(type, new Set());
    this.eventHandlers.get(type)!.add(handler);
    return () => { this.eventHandlers.get(type)?.delete(handler); };
  }

  /** Collect the next N snapshots for a window, then resolve. */
  collectSnapshots(windowId: string, n: number): Promise<StreamSnapshot[]> {
    return new Promise(resolve => {
      const snaps: StreamSnapshot[] = [];
      const unsub = this.on('event:snapshot', e => {
        const snap = (e as EvtSnapshot).snapshot;
        if (snap.window_id === windowId) {
          snaps.push(snap);
          if (snaps.length >= n) { unsub(); resolve(snaps); }
        }
      });
    });
  }

  /** Wait for a window to halt. */
  awaitHalt(windowId: string, timeoutMs = 30_000): Promise<EvtHalted> {
    return new Promise((resolve, reject) => {
      const timer  = setTimeout(() => { unsub(); reject(new Error('awaitHalt timed out')); }, timeoutMs);
      const unsub  = this.on('event:halted', e => {
        const ev = e as EvtHalted;
        if (ev.windowId === windowId) { clearTimeout(timer); unsub(); resolve(ev); }
      });
    });
  }
}

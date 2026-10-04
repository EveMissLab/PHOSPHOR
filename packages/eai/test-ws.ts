/**
 * PHOSPHOR · INT — WebSocket Server End-to-End Test (§6.3 Step 3)
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Boots the P5 agent server on a real `ws` WebSocketServer, connects a real
 * WebSocket client, and exercises the full agent protocol over the socket:
 *   welcome → getManifest → subscribe → run → snapshot stream → cmd:call → serialize
 *
 * This is the backend deployment unit, verified end to end. Requires `ws`.
 *
 *   run:  npm run verify:ws
 */

import { WebSocketServer, WebSocket } from 'ws';

import { PROGRAM_FIBONACCI } from './eml-vm16-core';
import { PROGRAM_FUNCTIONS } from './eml-vm16-callable';
import { createPipeline, buildProgramRegistry } from './eml-vm16-window';
import {
  bootstrapWSServer, createWebSocketTransport, AgentClient,
  type EvtWelcome, type EvtCallResult,
} from './eml-vm16-agent';

const PORT = 8771;

let passed = 0, failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  ${detail}` : ''}`); }
}

async function main(): Promise<void> {
  console.log('\x1b[1m\nPHOSPHOR · INT — WebSocket server end-to-end (§6.3 Step 3)\x1b[0m\n');

  // ── Boot the server ──────────────────────────────────────────────────────────
  const registry = buildProgramRegistry([PROGRAM_FIBONACCI, PROGRAM_FUNCTIONS]);
  const mgr = createPipeline({
    id: 'ws-demo', label: 'ws demo', autoRun: false,
    windows: [
      { id: 'fib-window', title: 'FIBONACCI', program: PROGRAM_FIBONACCI, speed: 'FAST' },
      { id: 'fn-window',  title: 'functions', program: PROGRAM_FUNCTIONS },
    ],
    channels: [],
  }, registry);

  const wss = new WebSocketServer({ port: PORT });
  await new Promise<void>(res => wss.on('listening', () => res()));
  bootstrapWSServer(wss, mgr);
  check('WebSocketServer listening', true, `ws://localhost:${PORT}`);

  // ── Connect a real client over the socket ────────────────────────────────────
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  // Attach the transport + welcome listener BEFORE 'open'. The server pushes
  // 'welcome' the instant it accepts the connection; if we only wired handlers
  // after awaiting 'open', that first message would race ahead of us and be lost.
  const transport = createWebSocketTransport(ws);
  const client = new AgentClient(transport);
  const welcomeP = new Promise<EvtWelcome>(res => {
    const off = client.on('event:welcome', e => { off(); res(e as EvtWelcome); });
  });
  await new Promise<void>((res, rej) => {
    ws.on('open', () => res());
    ws.on('error', rej);
  });
  const welcome = await welcomeP;
  check('received welcome with manifest over socket',
    welcome.manifest.total_windows === 2,
    `session=${welcome.session} windows=${welcome.manifest.total_windows}`);

  // ── Subscribe + run + collect snapshots over the wire ────────────────────────
  await client.cmd({ type: 'cmd:subscribe', config: {
    subId: 'ws-sub', windowId: 'fib-window', mode: 'on-change',
  }} as any);
  await client.cmd({ type: 'cmd:run', windowId: 'fib-window', speed: 'FAST' } as any);

  let snaps: Awaited<ReturnType<typeof client.collectSnapshots>> = [];
  try {
    snaps = await Promise.race([
      client.collectSnapshots('fib-window', 10),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 10_000)),
    ]);
  } catch { /* reported below */ }
  await client.cmd({ type: 'cmd:pause', windowId: 'fib-window' } as any);
  check('streamed 10 snapshots over WebSocket', snaps.length === 10, `got ${snaps.length}`);
  check('snapshot decoded over the wire', snaps.length > 0 && typeof snaps[0]?.instruction === 'string',
    snaps.length > 0 ? `first: ${snaps[0].instruction} @ ${snaps[0].pc}` : '');

  // ── cmd:call across the socket (CallableVM behind fn-window) ──────────────────
  const callResult = new Promise<EvtCallResult>(res => {
    const off = client.on('event:call_result', e => { off(); res(e as EvtCallResult); });
  });
  await client.cmd({ type: 'cmd:call', windowId: 'fn-window', fn: 'add', args: [3, 5] } as any);
  const cr = await Promise.race([
    callResult,
    new Promise<EvtCallResult>((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000)),
  ]).catch(() => null);
  check('cmd:call add(3,5) returns 8 over WebSocket', cr?.returnValue === 8, `returnValue=${cr?.returnValue}`);

  // ── serialize round-trips over the socket ────────────────────────────────────
  const ser = await client.cmd({ type: 'cmd:serialize' } as any);
  const saved = ser.payload as { windows?: unknown[] } | undefined;
  check('cmd:serialize returns manager state over WebSocket',
    Array.isArray(saved?.windows) && saved!.windows!.length === 2,
    `windows=${saved?.windows?.length}`);

  // ── Clean shutdown ───────────────────────────────────────────────────────────
  ws.close();
  await new Promise<void>(res => wss.close(() => res()));

  console.log(`\n\x1b[1m── Summary ──\x1b[0m`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) { console.log(`  \x1b[31mfailing:\x1b[0m ${failures.join(' · ')}`); process.exitCode = 1; }
  else            { console.log(`  \x1b[32mWebSocket backend verified end to end\x1b[0m`); }
}

main().catch(err => { console.error('\n\x1b[31mws test crashed:\x1b[0m', err); process.exitCode = 1; });

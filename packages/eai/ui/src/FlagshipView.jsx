import { useState, useEffect, useRef } from 'react';
// Phase 2 flagship case: the three EAI projections (Human CRT / AI stream /
// Sheet) acting on ONE real story instead of three separate demos. An AI
// proposes an optimization to a real rustc-compiled WASM program;
// wasmSemanticEquiv judges it BEFORE a human ever sees the row; the governed
// 09_Control plane executes only what was certified — a human approving a
// bad proposal by mistake doesn't matter, the hard gate in
// phosphor-control.ts refuses it regardless. See test-wasm-semantic.ts for
// the same flow verified headless.
import { parseWasmModule } from '../../wasm/wasm-binary';
import { makeWasmState, stepOnce } from '../../wasm/wasm-interp';
import { buildWasmSnapshot } from '../../wasm/wasm-snapshot';
import { proposeOptimization } from '../../wasm/wasm-sheet-bridge';
import { EAI_PROTO } from '../../eml-vm16-core';
import { buildPhosphorWorkbook } from '../../spreadsheet/phosphor-sheet';
import {
  appendControlRow, executeControlSheet, parseControlSheet, withControlSheet,
} from '../../spreadsheet/phosphor-control';
import { controlHandlersFromHost } from '../../spreadsheet/phosphor-control-host';
import { createEmitter, memorySink } from '../../stream/phosphor-stream';
import { C, Screen, TabTitle, panelHead, alpha } from './theme.jsx';

// Served copies of wasm/rust-fixtures/*.wasm (the reproducible source — see
// wasm/rust-fixtures/build.sh) under public/ so the browser can fetch them as
// static assets, same pattern as ui/public/pet-voices/.
const VARIANTS = {
  baseline: { url: new URL('../public/wasm-fixtures/baseline.wasm', import.meta.url).href, label: 'baseline (add() as a real call)' },
  'optimized-correct': { url: new URL('../public/wasm-fixtures/optimized-correct.wasm', import.meta.url).href, label: 'optimized-correct (add() inlined)' },
  'optimized-buggy': { url: new URL('../public/wasm-fixtures/optimized-buggy.wasm', import.meta.url).href, label: 'optimized-buggy (add() inlined, off-by-one)' },
};

const SPEC = {
  entry: 'main',
  paramCount: 1,
  outputPtrExport: 'buffer_ptr',
  outputBytes: (input) => (input[0] + 1) * 4,
  domain: [0, 1, 2, 3, 5, 8, 10, 15, 20],
};
const N = 10;
const VM_ID = 'phosphor-fib';

function runToHalt(bytes) {
  const module = parseWasmModule(bytes);
  let ptrState = makeWasmState(module, 'buffer_ptr', []);
  let g = 0;
  while (!ptrState.halted && g++ < 100000) ptrState = stepOnce(ptrState);
  const ptr = ptrState.result[0];

  let state = makeWasmState(module, 'main', [N]);
  g = 0;
  while (!state.halted && g++ < 200000) state = stepOnce(state);
  const view = new DataView(state.memory.buffer, state.memory.byteOffset, state.memory.byteLength);
  const fib = Array.from({ length: N + 1 }, (_, i) => view.getInt32(ptr + i * 4, true));
  const snap = buildWasmSnapshot({ id: VM_ID, state, mode: 'ai' });
  return { fib, snap };
}

const VERDICT_STYLE = {
  equivalent: { c: C.ok, label: '≡ EQUIVALENT' },
  'not-equivalent': { c: C.no, label: '≠ NOT EQUIVALENT' },
  inexpressible: { c: C.inx, label: '⊘ INEXPRESSIBLE' },
};

export default function FlagshipView() {
  const [bytes, setBytes] = useState(null);          // { baseline, 'optimized-correct', 'optimized-buggy' } → Uint8Array
  const [live, setLive] = useState('baseline');
  const [run, setRun] = useState(null);               // { fib, snap } for the currently live variant
  const [workbook, setWorkbook] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const sinkRef = useRef(null);
  const emitterRef = useRef(null);
  const seqRef = useRef(0);

  useEffect(() => {
    Promise.all(Object.entries(VARIANTS).map(([id, v]) =>
      fetch(v.url).then(r => r.arrayBuffer()).then(buf => [id, new Uint8Array(buf)])))
      .then(entries => {
        setBytes(Object.fromEntries(entries));
        const sink = memorySink();
        sinkRef.current = sink;
        emitterRef.current = createEmitter({ stream: 'phosphor-flagship', sink });
        setWorkbook(withControlSheet(buildPhosphorWorkbook({
          events: [], manifest: { eai_proto: EAI_PROTO, program: VM_ID, source: 'FlagshipView' },
        }), []));
      });
  }, []);

  useEffect(() => {
    if (bytes) setRun(runToHalt(bytes[live]));
  }, [bytes, live]);

  function propose(variant) {
    if (!bytes) return;
    const id = `cmd-${variant}-${(++seqRef.current).toString(36)}`;
    const { row, result } = proposeOptimization({
      id, target: VM_ID, variant, baseline: bytes.baseline, candidate: bytes[variant], spec: SPEC,
      requestedBy: 'agent:optimizer',
    });
    // Functional update: two proposals fired back-to-back in the same tick
    // (e.g. both buttons clicked before React re-renders) must each build on
    // the OTHER's result, not both read the same pre-update `workbook` closure
    // and silently clobber one another.
    setWorkbook(prev => appendControlRow(prev, row));
    emitterRef.current.emit('sheet:command_requested', { command_id: id, variant, verdict: result.verdict });
    setMessage(`proposed ${variant} — judge says ${result.verdict}`);
  }

  function setApproved(commandId, approved) {
    setWorkbook(prev => {
      const rows = parseControlSheet(prev).map(r => r.command_id === commandId
        ? { ...r, approved, status: approved ? 'APPROVED' : 'QUEUED' } : r);
      return withControlSheet(prev, rows);
    });
  }

  async function executeQueue() {
    if (!workbook) return;
    setBusy(true); setMessage('');
    try {
      const host = {
        applyOptimization: (target, variant) => {
          setLive(variant);
          return { switchedTo: variant };
        },
      };
      const result = await executeControlSheet(
        workbook, controlHandlersFromHost(host), {},
        (type, fields) => emitterRef.current.emit(type, fields),
      );
      setWorkbook(result.workbook);
      setMessage(`${result.processed} processed · ${result.skipped} inert/terminal`);
    } catch (e) { setMessage(String(e?.message ?? e)); }
    finally { setBusy(false); }
  }

  const rows = workbook ? parseControlSheet(workbook) : [];
  const events = sinkRef.current?.events ?? [];

  return (
    <Screen>
      <TabTitle accent={C.fg} title="FLAGSHIP · Φ END-TO-END"
        sub="AI proposes a real optimization → wasmSemanticEquiv judges it → PHOSPHOR-SHEET governs execution → the running program actually changes" />

      {!bytes && <div style={{ fontSize: '10px', color: C.muted }}>loading real WASM fixtures…</div>}

      {bytes && <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Human CRT projection — whichever program is currently LIVE */}
        <div style={{ flex: '1 1 300px', minWidth: '280px' }}>
          <div style={panelHead}>▸ HUMAN VIEW · currently running</div>
          <div style={{ fontSize: '11px', color: C.bright, marginBottom: '6px' }}>{VARIANTS[live].label}</div>
          {run && <>
            <div style={{ fontSize: '9px', color: C.muted, marginBottom: '4px' }}>main({N}) → fib(0..{N})</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', marginBottom: '10px' }}>
              {run.fib.map((v, i) => (
                <div key={i} style={{
                  minWidth: '28px', textAlign: 'center', fontSize: '10px', padding: '3px 2px', borderRadius: '2px',
                  color: C.fg, background: 'rgba(0,255,65,0.06)', border: `1px solid ${C.border}`,
                }}>{v}</div>
              ))}
            </div>
            <div style={{ fontSize: '9px', color: C.muted }}>halted at tick <span style={{ color: C.fg }}>{run.snap.tick}</span></div>
          </>}
        </div>

        {/* AI stream projection */}
        <div style={{ flex: '1 1 260px', maxWidth: '340px', minWidth: '240px' }}>
          <div style={{ ...panelHead, color: C.ai, borderColor: C.aiDim }}>▸ AI STREAM · phosphor-jsonl-v1</div>
          <pre style={{
            margin: 0, fontSize: '9px', lineHeight: '1.4', color: C.ai, fontFamily: 'inherit',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'rgba(0,40,60,0.18)',
            border: `1px solid ${C.aiDim}`, borderRadius: '2px', padding: '8px 10px', maxHeight: '260px', overflowY: 'auto',
          }}>{events.length ? events.map(e => `${e.type}${e.command_id ? ` · ${e.command_id}` : ''}${e.verdict ? ` · ${e.verdict}` : ''}${e.ok !== undefined ? ` · ok=${e.ok}` : ''}`).join('\n') : '(no events yet — propose an optimization)'}</pre>
        </div>

        {/* Sheet projection — 09_Control */}
        <div style={{ flex: '1 1 100%', minWidth: '280px' }}>
          <div style={panelHead}>▸ SHEET · 09_Control</div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
            <button onClick={() => propose('optimized-correct')} style={btn(C.ok)}>propose: inline add() (safe)</button>
            <button onClick={() => propose('optimized-buggy')} style={btn(C.no)}>propose: inline add() (has a bug)</button>
            <button onClick={executeQueue} disabled={busy} style={btn(C.ai)}>▶ EXECUTE GOVERNED QUEUE</button>
          </div>
          {message && <div style={{ fontSize: '9px', color: C.muted, marginBottom: '8px' }}>{message}</div>}

          <div style={{ overflowX: 'auto', border: `1px solid ${C.border}` }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '9.5px' }}>
              <thead><tr>{['ID', 'Variant', 'Verdict', 'Approved', 'Status', 'Error'].map(h => (
                <th key={h} style={{ position: 'sticky', top: 0, background: C.dim, color: C.ai, border: `1px solid ${C.border}`, padding: '4px 6px', textAlign: 'left' }}>{h}</th>
              ))}</tr></thead>
              <tbody>{rows.map(row => {
                const args = (() => { try { return JSON.parse(row.args_json); } catch { return {}; } })();
                const v = VERDICT_STYLE[args.verdict] ?? { c: C.muted, label: args.verdict ?? '—' };
                const pending = row.status === 'DRAFT' || row.status === 'QUEUED' || row.status === 'APPROVED';
                return (
                  <tr key={row.command_id}>
                    <td style={td}>{row.command_id}</td>
                    <td style={td}>{args.variant}</td>
                    <td style={{ ...td, color: v.c }} title={args.reason}>{v.label}{args.counterexample ? ` (n=${args.counterexample.input[0]})` : ''}</td>
                    <td style={td}>{pending
                      ? <input type="checkbox" checked={row.approved} onChange={e => setApproved(row.command_id, e.target.checked)} />
                      : (row.approved ? '✓' : '—')}</td>
                    <td style={{ ...td, color: row.status === 'EXECUTED' ? C.ok : row.status === 'REJECTED' ? C.no : C.fg }}>{row.status}</td>
                    <td style={{ ...td, color: row.error ? C.no : td.color }}>{row.error}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        </div>
      </div>}

      <div style={{ marginTop: '16px', fontSize: '8.5px', color: C.muted, maxWidth: '760px', lineHeight: '1.6' }}>
        Approving the buggy proposal does not execute it — <code style={{ color: C.ai }}>phosphor-control.ts</code>'s
        validation refuses any <code style={{ color: C.ai }}>wasm:apply_optimization</code> row whose embedded verdict
        isn't <code style={{ color: C.ok }}>equivalent</code>, regardless of the Approved column. Try it: check both
        boxes, then execute — only the safe one runs.
      </div>
    </Screen>
  );
}

const btn = (color) => ({
  background: alpha(color, 8), cursor: 'pointer', border: `1px solid ${color}`, color,
  fontSize: '9.5px', fontFamily: 'inherit', padding: '4px 10px', letterSpacing: '0.5px', borderRadius: '2px',
});
const td = { color: C.muted, border: `1px solid ${C.border}`, padding: '3px 6px', verticalAlign: 'top' };

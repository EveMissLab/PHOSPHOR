import { useState } from 'react';
import { createHeadlessVM } from '../../headless-driver';
import { createEmitter, memorySink, findAnomalies } from '../../stream/phosphor-stream';
import { PROGRAM_FIBONACCI, PROGRAM_COUNTER, PROGRAM_XOR_CIPHER } from '../../eml-vm16-core';
import { createCallableVM, PROGRAM_FUNCTIONS } from '../../eml-vm16-callable';
import { C, panelHead, Screen, TabTitle, alpha } from './theme.jsx';

const PROGRAMS = { fibonacci: PROGRAM_FIBONACCI, counter: PROGRAM_COUNTER, xor: PROGRAM_XOR_CIPHER };
const FUNCS = ['add', 'xor_byte', 'sum_range', 'fib_n'];

export default function AgentStream() {
  const [prog, setProg] = useState('fibonacci');
  const [maxSteps, setMaxSteps] = useState(300);   // these demos loop/restart — bound the stream
  const [events, setEvents] = useState([]);
  const [anoms, setAnoms] = useState([]);
  const [busy, setBusy] = useState(false);

  const [fn, setFn] = useState('add');
  const [a0, setA0] = useState('3');
  const [a1, setA1] = useState('5');
  const [callOut, setCallOut] = useState(null);

  async function runStream(injectBug) {
    setBusy(true); setEvents([]); setAnoms([]);
    const sink = memorySink();
    const em = createEmitter({ stream: 'phosphor-ui', sink });
    const runner = createHeadlessVM({ program: PROGRAMS[prog], mode: 'ai', emitter: em, maxSteps: Math.max(1, Math.min(50000, maxSteps | 0)) });
    await runner.run();
    if (injectBug) em.emit('agent:done', { agent: 'demo', code: 1 }); // a non-zero exit → anomaly
    setEvents(sink.events);
    setAnoms(findAnomalies(sink.events));
    setBusy(false);
  }

  async function doCall() {
    setCallOut(null);
    const vm = createCallableVM(PROGRAM_FUNCTIONS);
    const res = await vm.call(fn, [a0, a1].map(x => (parseInt(x, 10) || 0) & 0xFF));
    setCallOut({ fn, args: [Number(a0) || 0, Number(a1) || 0], returnValue: res.returnValue, steps: res.steps });
  }

  const tail = events.slice(-26);

  return (
    <Screen>
      <TabTitle accent={C.ai} title="AGENT · STREAM"
        sub="AI mode · a headless VM emits a phosphor-jsonl-v1 event stream an agent subscribes to — “the VM state stream is a first-class input for AI”" />

      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* ── Live event stream ───────────────────────────────────────────── */}
        <div style={{ flex: '1 1 380px', minWidth: '320px' }}>
          <div style={{ ...panelHead, color: C.ai, borderColor: C.aiDim }}>① HEADLESS STREAM · createHeadlessVM → vm:tick / vm:halt</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
            {Object.keys(PROGRAMS).map(k => (
              <button key={k} onClick={() => setProg(k)} style={{
                background: 'none', border: `1px solid ${prog === k ? C.ai : '#1a3a44'}`,
                color: prog === k ? C.ai : '#1a3a44', cursor: 'pointer',
                fontSize: '9.5px', fontFamily: 'inherit', padding: '2px 9px', borderRadius: '2px',
              }}>{k}</button>
            ))}
            <button onClick={() => runStream(false)} disabled={busy} style={{
              marginLeft: '6px', background: 'rgba(0,210,255,0.08)', border: `1px solid ${C.ai}`, color: C.ai,
              cursor: busy ? 'wait' : 'pointer', fontSize: '11px', fontFamily: 'inherit', padding: '4px 14px', letterSpacing: '1px', borderRadius: '2px',
            }}>▶ STREAM</button>
            <button onClick={() => runStream(true)} disabled={busy} title="append a code:1 event to show findAnomalies flag it" style={{
              background: 'none', border: `1px solid ${C.no}`, color: C.no,
              cursor: busy ? 'wait' : 'pointer', fontSize: '9.5px', fontFamily: 'inherit', padding: '4px 9px', borderRadius: '2px',
            }}>+ inject bug</button>
            <span style={{ fontSize: '9px', color: '#2a5a4a', marginLeft: '4px' }}>
              max steps <input value={maxSteps} onChange={e => setMaxSteps(Number(e.target.value) || 0)} style={inp} />
              <span style={{ color: '#163a30' }}> (these demos restart, never HALT)</span>
            </span>
          </div>

          {events.length > 0 && (
            <>
              <div style={{ fontSize: '9.5px', color: '#4a8a6a', marginBottom: '5px', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
                <span><span style={{ color: C.fg }}>{events.length}</span> events</span>
                <span>anomalies: <span style={{ color: anoms.length ? C.no : C.ok }}>{anoms.length}</span></span>
                <span style={{ color: '#2a5a4a' }}>findAnomalies() · best-effort, never breaks the host</span>
              </div>
              <pre style={{
                margin: 0, fontSize: '9px', lineHeight: '1.4', color: C.ai, fontFamily: 'inherit',
                whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'rgba(0,40,60,0.18)',
                border: `1px solid ${C.aiDim}`, borderRadius: '2px', padding: '7px 9px',
                maxHeight: '300px', overflowY: 'auto',
              }}>{tail.map(e => JSON.stringify(e)).join('\n')}</pre>
              {anoms.length > 0 && (
                <div style={{ marginTop: '6px', fontSize: '9.5px', color: C.no }}>
                  ⚠ anomaly: {anoms.map(a => `${a.type}${a.code !== undefined ? ` code=${a.code}` : ''}`).join(', ')}
                </div>
              )}
            </>
          )}
        </div>

        {/* ── CallableVM · cmd:call (ECC-1) ───────────────────────────────── */}
        <div style={{ flex: '1 1 280px', minWidth: '250px' }}>
          <div style={{ ...panelHead, color: C.sem, borderColor: C.semDim }}>② CALLABLE VM · ECC-1 calling convention</div>
          <div style={{ fontSize: '9px', color: '#2f6a5a', marginBottom: '8px' }}>
            args in R0..R7 · return in R0 after HALT — the VM as a callable function library
          </div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
            <select value={fn} onChange={e => setFn(e.target.value)} style={{
              background: '#040c04', color: C.sem, border: `1px solid ${C.semDim}`, fontFamily: 'inherit', fontSize: '10px', padding: '3px 5px',
            }}>
              {FUNCS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
            <input value={a0} onChange={e => setA0(e.target.value)} style={inp} />
            <input value={a1} onChange={e => setA1(e.target.value)} style={inp} />
            <button onClick={doCall} style={{
              background: 'rgba(90,240,200,0.08)', border: `1px solid ${C.sem}`, color: C.sem, cursor: 'pointer',
              fontSize: '11px', fontFamily: 'inherit', padding: '4px 14px', letterSpacing: '1px', borderRadius: '2px',
            }}>▶ CALL</button>
          </div>
          {callOut && (
            <div style={{
              border: `1px solid ${alpha(C.sem, 33)}`, borderRadius: '2px', padding: '8px 11px',
              fontSize: '12px', color: C.fg,
            }}>
              <span style={{ color: C.sem }}>{callOut.fn}</span>({callOut.args.join(', ')}) ={' '}
              <span style={{ color: C.bright, textShadow: '0 0 6px rgba(0,255,65,0.4)' }}>{String(callOut.returnValue)}</span>
              <span style={{ color: '#2a5a4a', fontSize: '9px', marginLeft: '8px' }}>· {callOut.steps} steps</span>
            </div>
          )}
          <div style={{ fontSize: '8.5px', color: '#1f4a3c', marginTop: '8px' }}>
            try <span style={{ color: C.sem }}>add(3, 5)</span> → 8 — the same path verified end-to-end over a real WebSocket
          </div>
        </div>
      </div>
    </Screen>
  );
}

const inp = {
  width: '42px', background: '#040c04', color: '#1aee44', border: '1px solid #13312a',
  fontFamily: '"Courier New",monospace', fontSize: '11px', padding: '3px 5px', textAlign: 'center',
};

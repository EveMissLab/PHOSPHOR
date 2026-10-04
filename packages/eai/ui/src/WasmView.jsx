import { useState, useEffect, useMemo, useRef } from 'react';
import { parseWasmModule } from '../../wasm/wasm-binary';
import { makeWasmState, stepOnce } from '../../wasm/wasm-interp';
import { buildWasmSnapshot } from '../../wasm/wasm-snapshot';
import { buildWasmCts, buildWasmStringTable } from '../../wasm/wasm-cts';
import { buildFibonacciWasmModule, STRING_DATA_ADDR } from '../../wasm/wasm-fixtures';
import { C, panelHead, Screen, TabTitle } from './theme.jsx';

const SPEEDS = { SLOW: { ms: 260, steps: 1 }, NORM: { ms: 80, steps: 1 }, FAST: { ms: 40, steps: 3 }, TURBO: { ms: 30, steps: 12 } };
const MAX_N = 20;

function readI32(mem, addr) {
  return mem[addr] | (mem[addr + 1] << 8) | (mem[addr + 2] << 16) | (mem[addr + 3] << 24);
}

const btn = (disabled, active) => ({
  background: 'none', border: `1px solid ${disabled ? '#0a1c0a' : active ? C.bright : '#1a4a1a'}`,
  cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '10px', fontFamily: '"Courier New",monospace',
  padding: '2px 9px', color: disabled ? '#0a1c0a' : active ? C.bright : '#1a4a1a', letterSpacing: '1px',
});

export default function WasmView() {
  const module = useMemo(() => parseWasmModule(buildFibonacciWasmModule()), []);
  const cts = useMemo(() => buildWasmCts(module), [module]);

  const [n, setN] = useState(10);
  const [state, setState] = useState(() => makeWasmState(module, 'main', [10]));
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState('NORM');
  const prevMemRef = useRef(state.memory);

  function reset(nextN) {
    prevMemRef.current = null;
    setState(makeWasmState(module, 'main', [nextN]));
    setRunning(false);
  }

  function step() {
    setState(s => {
      if (s.halted) return s;
      prevMemRef.current = s.memory;
      return stepOnce(s);
    });
  }

  useEffect(() => { if (state.halted) setRunning(false); }, [state.halted]);

  useEffect(() => {
    if (!running) return;
    const { ms, steps } = SPEEDS[speed];
    const id = setInterval(() => { for (let i = 0; i < steps; i++) step(); }, ms);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, speed]);

  const snap = buildWasmSnapshot({ id: 'main', state, mode: 'ai', cts, prevMem: prevMemRef.current ?? state.memory });
  const changedAddrs = new Set(snap.changed_this_tick.map(c => parseInt(c.addr, 16)));
  const fibCells = Array.from({ length: n + 1 }, (_, i) => ({ i, addr: i * 4, value: readI32(state.memory, i * 4) }));
  const label = state.frames.length ? `$${state.module.funcs[state.frames[state.frames.length - 1].funcIdx].name ?? 'func'}` : '(returned)';
  const label2 = state.halted ? '(returned)' : label;
  const strTable = buildWasmStringTable(state.memory, STRING_DATA_ADDR, STRING_DATA_ADDR + 16);

  return (
    <Screen>
      <TabTitle accent={C.fg} title="WASM-MVP"
        sub="real WebAssembly bytecode · i32 · structured control flow · call · cross-checked against Node's native engine" />

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
        <span style={{ fontSize: '9px', color: '#1a4a1a' }}>main(n=</span>
        <input type="number" min={0} max={MAX_N} value={n}
          onChange={e => { const v = Math.max(0, Math.min(MAX_N, Number(e.target.value) || 0)); setN(v); reset(v); }}
          style={{ width: '42px', background: C.bg, border: '1px solid #1a4a1a', color: C.bright, fontFamily: 'inherit', fontSize: '10px', padding: '2px 4px' }} />
        <span style={{ fontSize: '9px', color: '#1a4a1a' }}>)</span>
        <span style={{ color: C.border }}>│</span>
        <button onClick={step} disabled={state.halted || running} style={btn(state.halted || running)}>STEP</button>
        <button onClick={() => setRunning(r => !r)} disabled={state.halted} style={btn(state.halted, running)}>{running ? '■ HALT' : '▶ RUN'}</button>
        <button onClick={() => reset(n)} style={btn(false)}>↺ RST</button>
        <span style={{ color: C.border }}>│</span>
        {Object.keys(SPEEDS).map(s => (
          <button key={s} onClick={() => setSpeed(s)} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '9px',
            color: speed === s ? C.bright : '#1a3a1a',
          }}>{speed === s ? '◉' : '○'} {s}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Memory: fib output cells + the static string data segment */}
        <div style={{ flex: '1 1 320px', minWidth: '300px' }}>
          <div style={panelHead}>mem[0..{(n + 1) * 4}) · i32 cells · fib(0..{n})</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '3px', marginBottom: '14px' }}>
            {fibCells.map(({ i, addr, value }) => {
              const isChanged = changedAddrs.has(addr);
              return (
                <div key={i} title={`0x${addr.toString(16)}`} style={{
                  minWidth: '30px', textAlign: 'center', fontSize: '10px', padding: '3px 2px', borderRadius: '2px',
                  color: isChanged ? '#fff' : C.fg, background: isChanged ? 'rgba(255,255,255,0.16)' : 'rgba(0,255,65,0.06)',
                  border: `1px solid ${isChanged ? '#fff' : C.border}`,
                }}>{value}</div>
              );
            })}
          </div>

          <div style={panelHead}>data segment @0x{STRING_DATA_ADDR.toString(16)} · Layer 4 stringTable</div>
          <div style={{ fontSize: '11px', color: C.amber, letterSpacing: '2px', marginBottom: '12px' }}>
            "{strTable.get(STRING_DATA_ADDR) ?? '…'}"
          </div>

          <div style={panelHead}>NEXT</div>
          <div style={{ fontSize: '12px', color: C.bright, textShadow: '0 0 5px rgba(0,255,65,0.35)' }}>{snap.instruction}</div>
          <div style={{ fontSize: '8.5px', color: '#2a5a4a', marginTop: '3px' }}>{snap.pc}</div>
        </div>

        {/* Call frame: locals + operand stack */}
        <div style={{ flex: '1 1 220px', minWidth: '200px' }}>
          <div style={panelHead}>CALL FRAME · depth {snap.call_depth} · {label2}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px', marginBottom: '10px' }}>
            {Object.entries(snap.locals).map(([k, v]) => (
              <div key={k} style={{ fontSize: '10px' }}><span style={{ color: '#1a4a1a' }}>{k} </span><span style={{ color: C.fg }}>{v}</span></div>
            ))}
          </div>
          <div style={panelHead}>OPERAND STACK</div>
          <div style={{ display: 'flex', gap: '3px', flexWrap: 'wrap', marginBottom: '12px' }}>
            {snap.operand_stack.length === 0 && <span style={{ fontSize: '9px', color: '#1a3a1a' }}>(empty)</span>}
            {snap.operand_stack.map((v, i) => (
              <span key={i} style={{ fontSize: '10px', color: C.sp, border: '1px solid #1a4a1a', borderRadius: '2px', padding: '1px 6px' }}>{v}</span>
            ))}
          </div>
        </div>

        {/* AI snapshot */}
        <div style={{ flex: '1 1 280px', maxWidth: '360px', minWidth: '250px' }}>
          <div style={{ ...panelHead, color: C.ai, borderColor: C.aiDim }}>▸ AI STREAM · V_AI(WASM-MVP)</div>
          <pre style={{
            margin: 0, fontSize: '9.5px', lineHeight: '1.4', color: C.ai, fontFamily: 'inherit',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'rgba(0,40,60,0.18)',
            border: `1px solid ${C.aiDim}`, borderRadius: '2px', padding: '8px 10px', maxHeight: '340px', overflowY: 'auto',
          }}>{JSON.stringify(snap, null, 2)}</pre>
        </div>
      </div>

      <div style={{ marginTop: '10px', fontSize: '9px', color: C.muted }}>
        T: {state.ticks} · {state.halted ? '■ HALTED' : running ? `● ${speed}` : '○ PAUSED'} · real WebAssembly bytecode, cross-checked byte-for-byte against Node's native engine (see verify:wasm)
      </div>
    </Screen>
  );
}

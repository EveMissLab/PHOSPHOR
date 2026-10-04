import { useState, useEffect } from 'react';
import {
  makeVM64State, stepOnce64, stepN64, decode64, buildVM64Snapshot,
  MEMORY_MAP, AR_NAMES, DEFAULT_TYPE_TABLE_64K, hex4, getInstrLen64,
  PROGRAM64_FILL_SIMPLE, PROGRAM64_FIBONACCI, VM64_SP_INIT,
} from '../../eml-vm64-core';
import { REG_NAMES as REG, hex2 as h } from '../../eml-vm16-core';
import { C, panelHead, Screen, TabTitle } from './theme.jsx';

const PROGRAMS = { FILL: PROGRAM64_FILL_SIMPLE, FIBONACCI: PROGRAM64_FIBONACCI };
const SPEEDS = { SLOW: { ms: 360, n: 1 }, NORM: { ms: 90, n: 1 }, FAST: { ms: 28, n: 2 }, TURBO: { ms: 30, n: 8 } };

const REGION_COLORS = { code: '#1a4a1a', data: '#1a3a44', heap: '#3a2a4a', io: '#4a3a1a', stack: '#4a1a1a' };

// A zoomed 48-byte window of the 64KB space, 16 bytes/row, PC + write highlighted.
function MemWindow({ title, mem, base, pc, changed, rows = 3 }) {
  const b = base & 0xFFF0;
  return (
    <div style={{ marginBottom: '10px' }}>
      <div style={{ fontSize: '8.5px', color: C.muted, letterSpacing: '1px', marginBottom: '3px' }}>{title} · 0x{hex4(b)}</div>
      {Array.from({ length: rows }, (_, r) => {
        const rowBase = (b + r * 16) & 0xFFFF;
        return (
          <div key={r} style={{ display: 'flex', alignItems: 'center', marginBottom: '1px' }}>
            <span style={{ width: '40px', fontSize: '7.5px', color: '#0a1e0a', flexShrink: 0 }}>{hex4(rowBase)}</span>
            {Array.from({ length: 16 }, (_, c) => {
              const addr = (rowBase + c) & 0xFFFF;
              const v = mem[addr];
              const isPC = addr === pc;
              const isFl = changed.has(addr);
              const col = isFl ? '#fff' : isPC ? C.bright : v === 0 ? '#0a3a0a' : `rgba(20,${Math.min(255, v + 35)},20,0.9)`;
              const bg = isFl ? 'rgba(255,255,255,0.13)' : isPC ? 'rgba(0,255,65,0.15)' : 'transparent';
              return (
                <span key={c} title={`0x${hex4(addr)} = ${v} (0x${h(v)})`} style={{
                  width: '20px', textAlign: 'center', fontSize: '9px', lineHeight: '14px',
                  color: col, background: bg, borderRadius: '1px',
                }}>{h(v)}</span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export default function VM64View() {
  const [name, setName] = useState('FIBONACCI');
  const [vm, setVM] = useState(() => makeVM64State(PROGRAM64_FIBONACCI));
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState('NORM');

  const prog = PROGRAMS[name];
  const cts = prog.cts ?? {};

  useEffect(() => {
    if (!running) return;
    const { ms, n } = SPEEDS[speed];
    const id = setInterval(() => {
      setVM(prev => { if (prev.halted) { setRunning(false); return prev; } return stepN64(prev, n, cts); });
    }, ms);
    return () => clearInterval(id);
  }, [running, speed, name]);

  function load(k) { setName(k); setRunning(false); setVM(makeVM64State(PROGRAMS[k])); }
  function step() { setVM(s => (s.halted ? s : stepOnce64(s, cts))); }

  const snap = buildVM64Snapshot(prog.id, vm, cts);
  const op = vm.memory[vm.pc];
  const lastChanged = [...vm.changed];
  const dataBase = lastChanged.length ? lastChanged[lastChanged.length - 1] : MEMORY_MAP.DATA_START;
  const total = 0x10000;

  return (
    <Screen>
      <TabTitle accent={C.fg} title="EML-VM-64"
        sub="16-bit address space · 64 KB · AR0–AR3 · variable-length (2/3/4-byte) ISA · V1-compatible" />

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '12px' }}>
        {Object.keys(PROGRAMS).map(k => (
          <button key={k} onClick={() => load(k)} style={{
            background: 'none', border: `1px solid ${name === k ? C.bright : '#1a4a1a'}`, color: name === k ? C.bright : '#1a4a1a',
            cursor: 'pointer', fontSize: '10px', fontFamily: 'inherit', padding: '3px 10px', borderRadius: '2px',
          }}>{PROGRAMS[k].label}</button>
        ))}
        <span style={{ color: C.border }}>│</span>
        <button onClick={step} disabled={vm.halted || running} style={btn(vm.halted || running)}>STEP</button>
        <button onClick={() => setRunning(r => !r)} disabled={vm.halted} style={btn(vm.halted, running)}>{running ? '■ HALT' : '▶ RUN'}</button>
        <button onClick={() => load(name)} style={btn(false)}>↺ RST</button>
        <span style={{ color: C.border }}>│</span>
        {Object.keys(SPEEDS).map(s => (
          <button key={s} onClick={() => setSpeed(s)} style={{
            background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '9px',
            color: speed === s ? C.bright : '#1a3a1a',
          }}>{speed === s ? '◉' : '○'} {s}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* Region map + memory windows */}
        <div style={{ flex: '1 1 380px', minWidth: '330px' }}>
          <div style={panelHead}>MEMORY MAP · 64 KB</div>
          <div style={{ display: 'flex', height: '16px', marginBottom: '12px', border: '1px solid #0a1c0a' }}>
            {DEFAULT_TYPE_TABLE_64K.map((r, i) => {
              const w = ((r.end - r.start + 1) / total) * 100;
              return (
                <div key={i} title={`${r.kind} 0x${hex4(r.start)}–0x${hex4(r.end)}`} style={{
                  width: `${w}%`, background: (REGION_COLORS[r.kind] || '#1a4a1a') + '55',
                  borderRight: '1px solid #040c04', fontSize: '7px', color: REGION_COLORS[r.kind] || C.fg,
                  overflow: 'hidden', whiteSpace: 'nowrap', paddingLeft: '2px', lineHeight: '16px',
                }}>{r.kind}</div>
              );
            })}
          </div>
          <MemWindow title="CODE near PC" mem={vm.memory} base={vm.pc} pc={vm.pc} changed={vm.changed} />
          <MemWindow title="recent writes" mem={vm.memory} base={dataBase} pc={vm.pc} changed={vm.changed} />
        </div>

        {/* Registers + NEXT */}
        <div style={{ flex: '1 1 220px', minWidth: '200px' }}>
          <div style={panelHead}>REGISTERS</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px', marginBottom: '6px' }}>
            {[...Array(8)].map((_, i) => (
              <div key={i} style={{ fontSize: '10px' }}><span style={{ color: '#1a4a1a' }}>{REG[i]} </span><span style={{ color: C.fg }}>0x{h(vm.regs[i])}</span></div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '2px 8px', marginBottom: '6px' }}>
            {AR_NAMES.map((n, i) => (
              <div key={n} style={{ fontSize: '10px' }}><span style={{ color: C.amber }}>{n} </span><span style={{ color: '#caa' }}>0x{hex4(vm.ar[i])}</span></div>
            ))}
          </div>
          <div style={{ fontSize: '10px', display: 'flex', gap: '10px', flexWrap: 'wrap', marginBottom: '12px' }}>
            <span><span style={{ color: '#1a4a1a' }}>PC </span><span style={{ color: C.bright }}>0x{hex4(vm.pc)}</span></span>
            <span><span style={{ color: '#1a4a1a' }}>SP </span><span style={{ color: C.sp }}>0x{hex4(vm.sp)}</span></span>
            <span style={{ color: '#1a3a1a', fontSize: '9px' }}>Z={vm.flags.z ? 1 : 0} N={vm.flags.neg ? 1 : 0} G={vm.flags.gt ? 1 : 0}</span>
          </div>

          <div style={panelHead}>NEXT @ 0x{hex4(vm.pc)}</div>
          <div style={{ fontSize: '12px', color: C.bright, textShadow: '0 0 5px rgba(0,255,65,0.35)' }}>{decode64(vm.memory, vm.pc, cts)}</div>
          <div style={{ fontSize: '8.5px', color: '#2a5a4a', marginTop: '3px' }}>{getInstrLen64(op)}-byte instruction</div>
        </div>

        {/* AI snapshot */}
        <div style={{ flex: '1 1 280px', maxWidth: '360px', minWidth: '250px' }}>
          <div style={{ ...panelHead, color: C.ai, borderColor: C.aiDim }}>▸ AI STREAM · V_AI(VM-64)</div>
          <pre style={{
            margin: 0, fontSize: '9.5px', lineHeight: '1.4', color: C.ai, fontFamily: 'inherit',
            whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'rgba(0,40,60,0.18)',
            border: `1px solid ${C.aiDim}`, borderRadius: '2px', padding: '8px 10px', maxHeight: '340px', overflowY: 'auto',
          }}>{JSON.stringify(snap, null, 2)}</pre>
        </div>
      </div>

      <div style={{ marginTop: '10px', fontSize: '9px', color: C.muted }}>
        T: {vm.ticks} · {vm.halted ? '■ HALTED' : running ? `● ${speed}` : '○ PAUSED'} · {prog.description}
      </div>
    </Screen>
  );
}

const btn = (disabled, active) => ({
  background: 'none', border: `1px solid ${disabled ? '#0a1c0a' : active ? '#00ff41' : '#1a4a1a'}`,
  cursor: disabled ? 'not-allowed' : 'pointer', fontSize: '10px', fontFamily: '"Courier New",monospace',
  padding: '2px 9px', color: disabled ? '#0a1c0a' : active ? '#00ff41' : '#1a4a1a', letterSpacing: '1px',
});

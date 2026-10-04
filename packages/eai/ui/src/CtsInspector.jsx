import { useState } from 'react';
import {
  PROGRAM_FIBONACCI, PROGRAM_COUNTER, PROGRAM_XOR_CIPHER,
  resolveCTS, traceWithSnapshots, augmentCTSFromTrace, buildStringTable,
  makeVMState, decode, hex2 as h, OPCODE_TABLE,
} from '../../eml-vm16-core';
import { C, panelHead, Screen, TabTitle } from './theme.jsx';

const PROGRAMS = { FIBONACCI: PROGRAM_FIBONACCI, COUNTER: PROGRAM_COUNTER, XOR_CIPHER: PROGRAM_XOR_CIPHER };

function Layer({ n, name, children, accent = C.fg }) {
  return (
    <div style={{ flex: '1 1 240px', minWidth: '210px', marginBottom: '4px' }}>
      <div style={{ ...panelHead, color: accent }}>
        <span style={{ color: '#163a30' }}>L{n}</span> · {name}
      </div>
      <div style={{ fontSize: '9.5px', color: '#3a7a5a', lineHeight: '1.55' }}>{children}</div>
    </div>
  );
}

export default function CtsInspector() {
  const [name, setName] = useState('FIBONACCI');
  const prog = PROGRAMS[name];

  // Static CTS, then dynamic augmentation (recovers register-indirect readers/writers).
  const staticCts = resolveCTS(prog);
  const { trace, memSnapshots, accesses } = traceWithSnapshots(prog, 4000);
  const dynCts = augmentCTSFromTrace(staticCts, trace, memSnapshots, accesses);
  const strings = buildStringTable(makeVMState(prog).memory);

  // Which opcodes the program actually uses (Layer 1 in context).
  const usedOps = new Set();
  for (let i = 0; i + 1 < prog.code.length; i += 2) usedOps.add(prog.code[i]);

  const xref = [...dynCts.crossRefTable.entries()]
    .filter(([, e]) => e.callers.length || e.dataReaders.length || e.dataWriters.length)
    .sort((a, b) => a[0] - b[0]);

  return (
    <Screen>
      <TabTitle accent={C.fg} title="CTS INSPECTOR"
        sub="Correspondence Table System · the 6 layers that make Φ : M × CTS → V — “Visible ≡ Visualizable”" />

      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '14px' }}>
        {Object.keys(PROGRAMS).map(k => (
          <button key={k} onClick={() => setName(k)} style={{
            background: 'none', cursor: 'pointer',
            border: `1px solid ${name === k ? C.bright : '#1a4a1a'}`,
            color: name === k ? C.bright : '#1a4a1a',
            fontSize: '10px', fontFamily: 'inherit', padding: '3px 10px', letterSpacing: '1px', borderRadius: '2px',
          }}>{PROGRAMS[k].label}</button>
        ))}
        <span style={{ marginLeft: '8px', color: '#163a30', fontSize: '9px', alignSelf: 'center' }}>
          {prog.code.length} B program · {trace.length} ticks traced
        </span>
      </div>

      <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <Layer n={1} name="opcodeTable (ISA)">
          <div>{OPCODE_TABLE.size} ops defined · {usedOps.size} used here</div>
          {[...usedOps].sort((a, b) => a - b).map(op => (
            <div key={op}><span style={{ color: C.fg }}>0x{h(op)}</span> {OPCODE_TABLE.get(op)?.mnemonic} <span style={{ color: '#2a5a4a' }}>{OPCODE_TABLE.get(op)?.description}</span></div>
          ))}
        </Layer>

        <Layer n={2} name="symbolTable (addr → name)" accent={C.amber}>
          {[...staticCts.symbolTable.entries()].map(([a, s]) => (
            <div key={a}><span style={{ color: C.amber }}>0x{h(a)}</span> {s.name} <span style={{ color: '#2a5a4a' }}>{s.region}/{s.type} ·{s.size}B</span></div>
          ))}
        </Layer>

        <Layer n={3} name="typeTable (region map)">
          {staticCts.typeTable.map((r, i) => (
            <div key={i}><span style={{ color: r.colorHint || C.fg }}>0x{h(r.start)}–0x{h(r.end)}</span> {r.kind}</div>
          ))}
        </Layer>

        <Layer n={4} name="stringTable (decoded ASCII)" accent={C.sem}>
          {strings.size === 0
            ? <span style={{ color: '#2a5a4a' }}>no printable-ASCII runs ≥3 in this program</span>
            : [...strings.entries()].map(([a, s]) => <div key={a}><span style={{ color: C.sem }}>0x{h(a)}</span> "{s}"</div>)}
        </Layer>

        <Layer n={5} name="commentTable (annotation)">
          {[...staticCts.commentTable.entries()].map(([a, c]) => (
            <div key={a}><span style={{ color: C.fg }}>0x{h(a)}</span> <span style={{ color: '#2a5a4a', fontStyle: 'italic' }}>; {c}</span></div>
          ))}
        </Layer>

        <Layer n={6} name="crossRefTable (computation graph)" accent={C.ai}>
          <div style={{ fontSize: '8.5px', color: '#1a3a44', marginBottom: '3px' }}>
            static + dynamic augmentCTSFromTrace (recovers register-indirect access)
          </div>
          {xref.map(([a, e]) => {
            const st = staticCts.crossRefTable.get(a) ?? { callers: [], dataReaders: [], dataWriters: [] };
            const dyn = (arr, base) => arr.map(x => {
              const isNew = !base.includes(x);
              return <span key={x} style={{ color: isNew ? C.ai : '#3a7a5a' }}>0x{h(x)}{isNew ? '*' : ''} </span>;
            });
            return (
              <div key={a} style={{ marginBottom: '2px' }}>
                <span style={{ color: C.amber }}>0x{h(a)}</span>
                {e.callers.length > 0 && <span> ← callers {dyn(e.callers, st.callers)}</span>}
                {e.dataReaders.length > 0 && <span> ← reads {dyn(e.dataReaders, st.dataReaders)}</span>}
                {e.dataWriters.length > 0 && <span> ← writes {dyn(e.dataWriters, st.dataWriters)}</span>}
              </div>
            );
          })}
          <div style={{ fontSize: '8px', color: '#1a3a44', marginTop: '4px' }}>
            <span style={{ color: C.ai }}>cyan*</span> = recovered dynamically (static analysis missed it)
          </div>
        </Layer>
      </div>
    </Screen>
  );
}

import { useState } from 'react';
// v0.5 semantic layer — the operational equivalence judge + per-instruction meaning.
import { semanticEquiv, describeEffect } from '../../eml-semantic';
import { decode, hex2 as h } from '../../eml-vm16-core';
// Self-validating trace: the judge emits a vm:equiv event we surface verbatim.
import { createEmitter, memorySink } from '../../stream/phosphor-stream';
import { C, Screen, panelHead as head, parseBytes, alpha } from './theme.jsx';

// A · B byte sequences (arg = [dst:4|src:4]). Each preset tells one v0.5 story.
const PRESETS = [
  { name: 'ADD ≡ commuted', tag: 'same effect, different bytes',
    a: '20 01 01 00', b: '10 20 10 01 20 02 01 00', inputs: 2 },
  { name: 'ADD vs SUB', tag: 'different effect → counterexample',
    a: '20 01 01 00', b: '22 01 01 00', inputs: 2 },
  { name: 'identity ≡ ¬¬R0', tag: 'EXHAUSTIVE proof over all 256 inputs',
    a: '01 00', b: '33 00 33 00 01 00', inputs: 1 },
  { name: 'diverges only @4', tag: 'value 4 is outside the curated set — exhaustive catches it',
    a: '11 00 01 00', b: '11 14 40 01 51 0A 11 00 50 0C 11 01 01 00', inputs: 1 },
];

const inp = {
  width: '58px', background: '#040c04', color: '#5af0c8', border: '1px solid #13312a',
  fontFamily: '"Courier New",monospace', fontSize: '10px', padding: '2px 4px', textAlign: 'center',
};

// Fixed 2-byte ISA → walk pairs, decode + attach operational meaning.
function disassemble(bytes) {
  const rows = [];
  for (let i = 0; i < bytes.length; i += 2) {
    const op = bytes[i], arg = bytes[i + 1] ?? 0;
    rows.push({ addr: i, text: decode(op, arg), meaning: describeEffect(op, arg).summary });
  }
  return rows;
}

function Editor({ label, value, onChange, accent }) {
  const dis = disassemble(parseBytes(value));
  return (
    <div style={{ flex: '1 1 240px', minWidth: '220px' }}>
      <div style={{ ...head, color: accent }}>{label} · machine code (hex)</div>
      <textarea value={value} onChange={e => onChange(e.target.value)} spellCheck={false} style={{
        width: '100%', boxSizing: 'border-box', height: '46px', resize: 'vertical',
        background: 'rgba(0,30,10,0.25)', border: `1px solid ${C.dim}`, borderRadius: '2px',
        color: accent, fontFamily: 'inherit', fontSize: '12px', letterSpacing: '1px', padding: '6px 8px',
      }} />
      <div style={{ marginTop: '5px' }}>
        {dis.map((r, i) => (
          <div key={i} style={{ fontSize: '9.5px', display: 'flex', gap: '6px', marginBottom: '1px' }}>
            <span style={{ color: '#143514', flexShrink: 0, width: '24px' }}>{h(r.addr)}:</span>
            <span style={{ color: C.fg, flexShrink: 0, width: '92px' }}>{r.text}</span>
            <span style={{ color: '#2f6a5a' }}>{r.meaning}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function EquivLab() {
  const [aText, setAText] = useState(PRESETS[0].a);
  const [bText, setBText] = useState(PRESETS[0].b);
  const [nIn, setNIn]     = useState(PRESETS[0].inputs);
  const [maxSteps, setMaxSteps]     = useState(100000);  // non-termination cutoff
  const [mixedTrials, setMixedTrials] = useState(64);    // sampled-mode coverage
  const [forceExh, setForceExh]     = useState(false);   // force full enumeration (≤2 inputs)
  const [res, setRes]     = useState(null);
  const [evt, setEvt]     = useState(null);
  const [err, setErr]     = useState(null);

  function loadPreset(p) {
    setAText(p.a); setBText(p.b); setNIn(p.inputs); setRes(null); setEvt(null); setErr(null);
  }

  function run() {
    setErr(null);
    try {
      const a = parseBytes(aText), b = parseBytes(bText);
      if (!a.length || !b.length) { setErr('both sequences need at least one byte'); return; }
      const inputs  = Array.from({ length: nIn }, (_, i) => ({ kind: 'reg', index: i }));
      const outputs = [{ kind: 'reg', index: 0 }];
      const sink = memorySink();
      const em = createEmitter({ stream: 'phosphor-ui', sink });
      const result = semanticEquiv(a, b, {
        inputs, outputs,
        maxSteps: Math.max(1, maxSteps | 0),
        mixedTrials: Math.max(0, mixedTrials | 0),
        exhaustive: forceExh,
      }, em);
      setRes(result);
      setEvt(sink.events.find(e => e.type === 'vm:equiv') ?? null);
    } catch (e) {
      setErr(String(e?.message ?? e));
    }
  }

  const verdictStyle = res && (
    res.verdict === 'equivalent'     ? { c: C.ok,  bg: C.okBg,  label: '≡  EQUIVALENT' } :
    res.verdict === 'not-equivalent' ? { c: C.no,  bg: C.noBg,  label: '≠  NOT EQUIVALENT' } :
                                       { c: C.inx, bg: C.inxBg, label: '⊘  INEXPRESSIBLE' }
  );

  return (
    <Screen>
        {/* Title + thesis */}
        <div style={{ marginBottom: '10px' }}>
          <span style={{ color: C.sem, fontSize: '13px', letterSpacing: '2px', textShadow: `0 0 10px ${alpha(C.sem, 50)}` }}>
            ▸ SEMANTIC EQUIVALENCE
          </span>
          <span style={{ color: '#163a30', fontSize: '9px', marginLeft: '10px', letterSpacing: '0.5px' }}>
            v0.5 · do two byte sequences MEAN the same thing? — run both, compare observable output
          </span>
        </div>

        {/* Presets */}
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '12px' }}>
          {PRESETS.map(p => (
            <button key={p.name} onClick={() => loadPreset(p)} title={p.tag} style={{
              background: 'none', border: `1px solid #1a4a3a`, color: C.sem, cursor: 'pointer',
              fontSize: '9.5px', fontFamily: 'inherit', padding: '3px 9px', letterSpacing: '0.5px', borderRadius: '2px',
            }}>{p.name}</button>
          ))}
        </div>

        {/* Editors */}
        <div style={{ display: 'flex', gap: '18px', flexWrap: 'wrap', marginBottom: '12px' }}>
          <Editor label="A" value={aText} onChange={setAText} accent={C.fg} />
          <Editor label="B" value={bText} onChange={setBText} accent={C.ai} />
        </div>

        {/* Controls */}
        <div style={{ display: 'flex', gap: '14px', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap' }}>
          <span style={{ fontSize: '9.5px', color: '#2a5a4a' }}>
            inputs:&nbsp;
            {[1, 2].map(n => (
              <button key={n} onClick={() => { setNIn(n); setRes(null); }} style={{
                background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '10px',
                color: nIn === n ? C.sem : '#1a4a3a', textShadow: nIn === n ? '0 0 5px rgba(90,240,200,0.4)' : 'none',
              }}>{nIn === n ? '◉' : '○'} R0{n === 2 ? ',R1' : ''}</button>
            ))}
            <span style={{ color: '#163a30', marginLeft: '8px' }}>→ observe R0{(nIn === 1 || (forceExh && nIn <= 2)) ? '  (exhaustive proof)' : '  (sampled)'}</span>
          </span>
          <span style={{ fontSize: '9px', color: '#2a5a4a', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            maxSteps <input value={maxSteps} onChange={e => setMaxSteps(Number(e.target.value) || 0)} style={inp} />
            mixedTrials <input value={mixedTrials} onChange={e => setMixedTrials(Number(e.target.value) || 0)} style={inp} />
            <button onClick={() => setForceExh(v => !v)} title="enumerate the whole input space when ≤2 inputs (≤65536)" style={{
              background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', fontSize: '10px',
              color: forceExh ? C.sem : '#1a4a3a', textShadow: forceExh ? '0 0 5px rgba(90,240,200,0.4)' : 'none',
            }}>{forceExh ? '☑' : '☐'} force exhaustive</button>
          </span>
          <button onClick={run} style={{
            background: 'rgba(90,240,200,0.08)', border: `1px solid ${C.sem}`, color: C.sem, cursor: 'pointer',
            fontSize: '11px', fontFamily: 'inherit', padding: '4px 16px', letterSpacing: '1px', borderRadius: '2px',
            textShadow: '0 0 6px rgba(90,240,200,0.4)',
          }}>▶ JUDGE</button>
        </div>

        {err && (
          <div style={{ fontSize: '10px', color: C.no, marginBottom: '10px' }}>⚠ {err}</div>
        )}

        {/* Verdict */}
        {res && verdictStyle && (
          <div style={{ display: 'flex', gap: '16px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flex: '1 1 300px', minWidth: '260px' }}>
              <div style={{
                border: `1px solid ${verdictStyle.c}`, background: verdictStyle.bg, borderRadius: '3px',
                padding: '10px 12px', marginBottom: '10px',
              }}>
                <div style={{ color: verdictStyle.c, fontSize: '15px', letterSpacing: '1.5px', textShadow: `0 0 8px ${alpha(verdictStyle.c, 40)}` }}>
                  {verdictStyle.label}
                </div>
                <div style={{ fontSize: '9.5px', color: '#4a8a6a', marginTop: '5px', lineHeight: '1.5' }}>
                  {res.reason}
                </div>
                <div style={{ fontSize: '9px', color: '#2a5a4a', marginTop: '6px', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
                  <span>trials <span style={{ color: C.fg }}>{res.trials}</span></span>
                  <span>distinct outputs <span style={{ color: C.fg }}>{res.distinctOutputs}</span></span>
                  <span>coverage <span style={{ color: res.exhaustive ? C.ok : C.inx }}>{res.exhaustive ? '✓ exhaustive (proof)' : 'sampled'}</span></span>
                </div>
              </div>

              {res.counterexample && (
                <div style={{ border: `1px solid ${C.noBg}`, borderRadius: '3px', padding: '8px 11px' }}>
                  <div style={{ ...head, color: C.no }}>COUNTEREXAMPLE</div>
                  <div style={{ fontSize: '10.5px', display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
                    <span>input <span style={{ color: C.fg }}>[{res.counterexample.input.join(', ')}]</span></span>
                    <span>A → <span style={{ color: C.fg }}>{res.counterexample.outputA}</span></span>
                    <span>B → <span style={{ color: C.ai }}>{res.counterexample.outputB}</span></span>
                  </div>
                </div>
              )}
            </div>

            {/* Self-validating vm:equiv event */}
            {evt && (
              <div style={{ flex: '1 1 280px', maxWidth: '380px', minWidth: '250px' }}>
                <div style={{ ...head, color: C.ai, borderColor: C.aiDim }}>
                  ▸ vm:equiv  <span style={{ color: '#1a3a44', fontSize: '8px' }}>self-validating trace (phosphor-jsonl-v1)</span>
                </div>
                <pre style={{
                  margin: 0, fontSize: '10px', lineHeight: '1.45', color: C.ai, fontFamily: 'inherit',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'rgba(0,40,60,0.18)',
                  border: `1px solid ${C.aiDim}`, borderRadius: '2px', padding: '8px 10px',
                  textShadow: '0 0 3px rgba(0,210,255,0.25)',
                }}>{JSON.stringify(evt, null, 2)}</pre>
                <div style={{ fontSize: '8px', color: '#1a3a44', marginTop: '5px' }}>
                  ok ⟺ certified equivalent · findAnomalies() flags ok:false automatically
                </div>
              </div>
            )}
          </div>
        )}

        {!res && !err && (
          <div style={{ fontSize: '10px', color: C.dim, marginTop: '6px' }}>
            — load a preset or paste two byte sequences, then press JUDGE —
          </div>
        )}
    </Screen>
  );
}

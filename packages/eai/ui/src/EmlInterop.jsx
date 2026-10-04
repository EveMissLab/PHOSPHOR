import { useState } from 'react';
import { ingestEmlTrace } from '../../stream/eml-consumer';
import { parseEmlCts, digestEmlCts } from '../../eml-cts-interop';
import { C, panelHead, Screen, TabTitle } from './theme.jsx';

// Real `eml trace --deterministic` output, captured from the EML repo examples.
const TRACES = {
  sum: [
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":1,"ts":"1970-01-01T00:00:00.000Z","type":"eml:run:start","mono":1,"file":"sum.eml","statements":3}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":2,"ts":"1970-01-01T00:00:00.000Z","type":"eml:assign","mono":2,"name":"N","value":"100","declares":true}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":3,"ts":"1970-01-01T00:00:00.000Z","type":"eml:sum","mono":3,"iterator":"i","count":100,"result":"338350"}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":4,"ts":"1970-01-01T00:00:00.000Z","type":"eml:assign","mono":4,"name":"r","value":"338350","declares":true}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":5,"ts":"1970-01-01T00:00:00.000Z","type":"eml:output","mono":5,"text":"338350"}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":6,"ts":"1970-01-01T00:00:00.000Z","type":"eml:run:done","mono":6,"ok":true,"outputs":1,"anomalies":0}',
  ].join('\n'),
  square_sum: [
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":1,"ts":"1970-01-01T00:00:00.000Z","type":"eml:run:start","mono":1,"file":"square_sum.eml","statements":5}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":2,"ts":"1970-01-01T00:00:00.000Z","type":"eml:def","mono":2,"fn":"square_sum","params":["N"],"temperature":"cold","async":false}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":3,"ts":"1970-01-01T00:00:00.000Z","type":"eml:def","mono":3,"fn":"greet","params":["name"],"temperature":"hot","async":false}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":4,"ts":"1970-01-01T00:00:00.000Z","type":"eml:call","mono":4,"fn":"square_sum","args":["100"],"temperature":"cold"}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":5,"ts":"1970-01-01T00:00:00.000Z","type":"eml:sum","mono":5,"iterator":"i","count":100,"result":"338350"}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":7,"ts":"1970-01-01T00:00:00.000Z","type":"eml:cache:miss","mono":7,"fn":"square_sum","args":["100"]}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":10,"ts":"1970-01-01T00:00:00.000Z","type":"eml:output","mono":10,"text":"338350"}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":14,"ts":"1970-01-01T00:00:00.000Z","type":"eml:run:done","mono":14,"ok":true,"outputs":2,"anomalies":0}',
  ].join('\n'),
  // Temporal: interpreter defers (incomplete), then --run splices the real Python.
  'wait (--run)': [
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":1,"ts":"1970-01-01T00:00:00.000Z","type":"eml:run:start","mono":1,"file":"wait.eml","statements":5}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":2,"ts":"1970-01-01T00:00:00.000Z","type":"eml:def","mono":2,"fn":"wait_ready","params":["flag"],"temperature":"neutral","async":true}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":3,"ts":"1970-01-01T00:00:00.000Z","type":"eml:unsupported","mono":3,"construct":"call run_temporal()","reason":"temporal runtime intrinsic — real Python only"}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":4,"ts":"1970-01-01T00:00:00.000Z","type":"eml:run:incomplete","mono":4,"reason":"unsupported","construct":"call run_temporal()"}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":5,"ts":"1970-01-01T00:00:00.000Z","type":"eml:temporal:start","mono":5,"fn":"wait_ready"}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":6,"ts":"1970-01-01T00:00:00.000Z","type":"eml:temporal:done","mono":6,"fn":"wait_ready","ok":true}',
    '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":7,"ts":"1970-01-01T00:00:00.000Z","type":"eml:python:exit","mono":7,"code":0}',
  ].join('\n'),
};

// Real `eml cts square_sum.eml` output (PHOSPHOR-compatible Cts).
const CTS_SQSUM = {
  file: 'square_sum.eml',
  symbols: {
    def:     { type: 'function',    meaning: 'function_def',    target: 'def {name}({params}): ...' },
    '@cold': { type: 'temperature', meaning: 'cold_logic',      target: '@functools.cache' },
    'Σ':     { type: 'algebraic',   meaning: 'summation',       target: 'sum({expr} for {iter} in {range})' },
    '@hot':  { type: 'temperature', meaning: 'hot_state',       target: '# @hot (dynamic state, not cached)' },
    '^0':    { type: 'control',     meaning: 'output',          target: 'print({value})' },
    '=>':    { type: 'assignment',  meaning: 'bind',            target: '{target} = {expr}' },
  },
  nodes: [
    { id: 'node_001', source: '@cold def square_sum(N)', python: '@functools.cache', dependencies: [], semanticType: 'function.cold' },
    { id: 'node_002', source: '@hot def greet(name)', python: 'def greet(name)', dependencies: [], semanticType: 'function.hot' },
    { id: 'node_003', source: 'square_sum(100) => total', python: 'total = square_sum(100)', dependencies: ['square_sum'], semanticType: 'binding.call' },
  ],
  functions: [
    { name: 'square_sum', temperature: 'cold', pure: true,  astHash: 'ada149ff', cached: false, importance: { callFrequency: 1, riskLevel: 0.2, dependencyDepth: 1, score: 0.28 }, sideEffects: [] },
    { name: 'greet',      temperature: 'hot',  pure: false, astHash: '835e9a9d', cached: false, importance: { callFrequency: 1, riskLevel: 0.8, dependencyDepth: 1, score: 0.52 }, sideEffects: ['輸出語句 ^0（print，I/O 副作用）'] },
  ],
  loops: [{ loopKind: 'algebraic_sum', deterministic: true, terminating: true, source: 'Σ(i^2, i in [1:N]) => r' }],
  commentTable: { node_001: '冷邏輯函數（可快取純函數）' },
  crossRefTable: { total: ['square_sum(100)'] },
};

const head2 = { ...panelHead, color: C.ai, borderColor: C.aiDim };
const kv = { fontSize: '10px', display: 'flex', gap: '6px', marginBottom: '1px' };

function Tag({ c, children }) {
  return <span style={{ color: c, border: `1px solid ${c}55`, borderRadius: '2px', padding: '0 5px', fontSize: '9px' }}>{children}</span>;
}

export default function EmlInterop() {
  const [traceText, setTraceText] = useState(TRACES.square_sum);
  const [report, setReport] = useState(null);
  const [ctsText, setCtsText] = useState(JSON.stringify(CTS_SQSUM, null, 2));
  const [digest, setDigest] = useState(null);
  const [err, setErr] = useState(null);

  function analyzeTrace() {
    setErr(null);
    try { setReport(ingestEmlTrace(traceText)); } catch (e) { setErr(String(e?.message ?? e)); }
  }
  function analyzeCts() {
    setErr(null);
    const cts = parseEmlCts(ctsText);
    if (!cts) { setErr('not a valid EML Cts JSON'); setDigest(null); return; }
    setDigest(digestEmlCts(cts));
  }

  return (
    <Screen>
      <TabTitle accent={C.ai} title="EML INTEROP"
        sub="v0.5 · PHOSPHOR consumes EML's phosphor-jsonl-v1 traces & source-Cts — the wired EML → PHOSPHOR loop" />

      <div style={{ display: 'flex', gap: '20px', flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* ── Trace consumer ──────────────────────────────────────────────── */}
        <div style={{ flex: '1 1 360px', minWidth: '300px' }}>
          <div style={head2}>① TRACE CONSUMER · ingestEmlTrace()</div>
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '6px' }}>
            {Object.keys(TRACES).map(k => (
              <button key={k} onClick={() => { setTraceText(TRACES[k]); setReport(null); }} style={{
                background: 'none', border: '1px solid #1a3a44', color: C.ai, cursor: 'pointer',
                fontSize: '9.5px', fontFamily: 'inherit', padding: '2px 8px', borderRadius: '2px',
              }}>{k}</button>
            ))}
          </div>
          <textarea value={traceText} onChange={e => setTraceText(e.target.value)} spellCheck={false} style={{
            width: '100%', boxSizing: 'border-box', height: '120px', resize: 'vertical',
            background: 'rgba(0,40,60,0.18)', border: `1px solid ${C.aiDim}`, borderRadius: '2px',
            color: C.ai, fontFamily: 'inherit', fontSize: '9.5px', padding: '6px 8px', lineHeight: '1.4',
          }} />
          <button onClick={analyzeTrace} style={{
            marginTop: '6px', background: 'rgba(0,210,255,0.08)', border: `1px solid ${C.ai}`, color: C.ai,
            cursor: 'pointer', fontSize: '11px', fontFamily: 'inherit', padding: '4px 16px', letterSpacing: '1px', borderRadius: '2px',
          }}>▶ ANALYZE</button>

          {report && (
            <div style={{ marginTop: '10px', fontSize: '10px', color: '#4a8a6a', lineHeight: '1.6' }}>
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '6px' }}>
                <Tag c={C.fg}>{report.summary.total} events</Tag>
                <Tag c={report.invalidLines.length ? C.no : C.ok}>{report.invalidLines.length} invalid envelope</Tag>
                <Tag c={report.anomalies.length ? C.amber : C.ok}>{report.anomalies.length} anomalies</Tag>
              </div>
              <div style={{ ...kv }}>lifecycle:&nbsp;
                {report.lifecycle.started && <Tag c={C.fg}>started</Tag>}{' '}
                {report.lifecycle.done && <Tag c={C.ok}>done</Tag>}{' '}
                {report.lifecycle.incomplete && <Tag c={C.amber}>interp-incomplete</Tag>}{' '}
                {report.lifecycle.splicedComplete && <Tag c={C.ok}>python-complete</Tag>}{' '}
                {report.lifecycle.errored && <Tag c={C.no}>errored</Tag>}
              </div>
              {report.equiv.length > 0 && <div style={kv}>eml:equiv: {report.equiv.map((e, i) => <Tag key={i} c={e.ok ? C.ok : C.no}>{e.ok ? 'ok' : `${e.actual}≠${e.expected}`}</Tag>)}</div>}
              {report.bugs.length > 0 && <div style={kv}>bugs: {report.bugs.map((b, i) => <Tag key={i} c={C.no}>{b.level}</Tag>)}</div>}
              {report.temporal.length > 0 && <div style={kv}>temporal: {report.temporal.map((t, i) => <Tag key={i} c={C.sem}>{t.type.replace('eml:temporal:', '')}{t.ok ? '✓' : ''}</Tag>)}</div>}
              {report.pythonExit !== null && <div style={kv}>python exit: <Tag c={report.pythonExit === 0 ? C.ok : C.no}>{report.pythonExit}</Tag></div>}
              <div style={{ fontSize: '9px', color: '#2a5a4a', marginTop: '4px' }}>
                by type: {Object.entries(report.summary.byType).map(([t, n]) => `${t}×${n}`).join('  ')}
              </div>
            </div>
          )}
        </div>

        {/* ── Cts bridge ──────────────────────────────────────────────────── */}
        <div style={{ flex: '1 1 320px', minWidth: '280px' }}>
          <div style={{ ...panelHead, color: C.sem, borderColor: C.semDim }}>② Cts BRIDGE · digestEmlCts()</div>
          <textarea value={ctsText} onChange={e => setCtsText(e.target.value)} spellCheck={false} style={{
            width: '100%', boxSizing: 'border-box', height: '120px', resize: 'vertical',
            background: 'rgba(0,40,30,0.18)', border: `1px solid ${C.semDim}`, borderRadius: '2px',
            color: C.sem, fontFamily: 'inherit', fontSize: '9px', padding: '6px 8px', lineHeight: '1.35',
          }} />
          <button onClick={analyzeCts} style={{
            marginTop: '6px', background: 'rgba(90,240,200,0.08)', border: `1px solid ${C.sem}`, color: C.sem,
            cursor: 'pointer', fontSize: '11px', fontFamily: 'inherit', padding: '4px 16px', letterSpacing: '1px', borderRadius: '2px',
          }}>▶ BRIDGE</button>

          {digest && (
            <div style={{ marginTop: '10px', fontSize: '10px', color: '#4a8a6a' }}>
              <div style={{ fontSize: '8.5px', color: '#2f6a5a', marginBottom: '3px' }}>SYMBOLS → meta:dictionary ({Object.keys(digest.dictionary).length})</div>
              {Object.entries(digest.dictionary).slice(0, 6).map(([t, spec]) => (
                <div key={t} style={{ fontSize: '9px', marginBottom: '1px' }}>
                  <span style={{ color: C.sem }}>{t}</span> <span style={{ color: '#2a5a4a' }}>{spec.description}</span>
                </div>
              ))}
              <div style={{ fontSize: '8.5px', color: '#2f6a5a', margin: '6px 0 3px' }}>FUNCTIONS → attention (by importance)</div>
              {digest.attention.map(a => (
                <div key={a.name} style={{ fontSize: '9.5px', marginBottom: '1px', display: 'flex', gap: '6px' }}>
                  <Tag c={a.temperature === 'hot' ? C.amber : C.sem}>{a.temperature}</Tag>
                  <span style={{ color: C.fg }}>{a.name}</span>
                  <span style={{ color: '#2a5a4a' }}>score {a.importanceScore} · {a.pure ? 'pure' : 'impure'}</span>
                </div>
              ))}
              <div style={{ fontSize: '8.5px', color: '#2f6a5a', margin: '6px 0 3px' }}>LOOPS → control-flow hints</div>
              {digest.loops.map((l, i) => (
                <div key={i} style={{ fontSize: '9.5px' }}>
                  <span style={{ color: C.sem }}>{l.loopKind}</span>
                  <span style={{ color: '#2a5a4a' }}> · {l.deterministic ? 'deterministic' : 'nondet'} · {l.terminating ? 'terminating' : 'maybe-∞'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {err && <div style={{ fontSize: '10px', color: C.no, marginTop: '10px' }}>⚠ {err}</div>}
    </Screen>
  );
}

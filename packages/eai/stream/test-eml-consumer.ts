/**
 * EML trace consumer — verification harness
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 *   run:  npm run verify:eml   (== npx tsx stream/test-eml-consumer.ts)
 *
 * Verifies that PHOSPHOR can consume an EML `@eml/trace` phosphor-jsonl-v1 stream:
 *  1. a REAL committed EML trace (captured verbatim from the EML repo,
 *     examples/phase2-cold-hot/square_sum.trace.jsonl) passes PHOSPHOR's own v1
 *     envelope validation with ZERO violations — proving the two independent
 *     implementations are wire-compatible, not just claimed to be;
 *  2. EML-specific semantics (eml:equiv verdicts, eml:bug levels, run lifecycle)
 *     are extracted; and
 *  3. EML anomalies (a failed eml:equiv, a CRITICAL eml:bug, an eml:run:error) are
 *     surfaced by PHOSPHOR's findAnomalies, while a malformed/foreign line is
 *     reported as invalid (so the compatibility check is not vacuous).
 */

import { ingestEmlTrace } from './eml-consumer';
import {
  parseEmlCts, isEmlCts, emlCtsToDictionary, emlCtsAttention, emlCtsLoops,
  classifyEmlNode, digestEmlCts, type EmlCts,
} from '../eml-cts-interop';

let passed = 0, failed = 0;
const failures: string[] = [];
function check(label: string, cond: boolean, detail = ''): void {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${label}${detail ? `  \x1b[2m${detail}\x1b[0m` : ''}`); }
  else { failed++; failures.push(label); console.log(`  \x1b[31m✗ ${label}\x1b[0m${detail ? `  ${detail}` : ''}`); }
}
const head = (t: string) => console.log(`\n\x1b[36m${t}\x1b[0m`);

// Captured verbatim from EML examples/phase2-cold-hot/square_sum.trace.jsonl
// (`eml trace --deterministic`). Embedded (not read across repos) so this test is
// self-contained; it is REAL EML emitter output, not a hand-mocked shape.
const REAL_EML_TRACE = [
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":1,"ts":"1970-01-01T00:00:00.000Z","type":"eml:run:start","mono":1,"file":"square_sum.eml","statements":5}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":2,"ts":"1970-01-01T00:00:00.000Z","type":"eml:def","mono":2,"fn":"square_sum","params":["N"],"temperature":"cold","async":false}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":3,"ts":"1970-01-01T00:00:00.000Z","type":"eml:def","mono":3,"fn":"greet","params":["name"],"temperature":"hot","async":false}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":4,"ts":"1970-01-01T00:00:00.000Z","type":"eml:call","mono":4,"fn":"square_sum","args":["100"],"temperature":"cold"}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":5,"ts":"1970-01-01T00:00:00.000Z","type":"eml:sum","mono":5,"iterator":"i","count":100,"result":"338350"}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":6,"ts":"1970-01-01T00:00:00.000Z","type":"eml:assign","mono":6,"name":"r","value":"338350","declares":true}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":7,"ts":"1970-01-01T00:00:00.000Z","type":"eml:cache:miss","mono":7,"fn":"square_sum","args":["100"]}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":8,"ts":"1970-01-01T00:00:00.000Z","type":"eml:return","mono":8,"fn":"square_sum","value":"338350"}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":9,"ts":"1970-01-01T00:00:00.000Z","type":"eml:assign","mono":9,"name":"total","value":"338350","declares":true}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":10,"ts":"1970-01-01T00:00:00.000Z","type":"eml:output","mono":10,"text":"338350"}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":11,"ts":"1970-01-01T00:00:00.000Z","type":"eml:call","mono":11,"fn":"greet","args":["338350"],"temperature":"hot"}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":12,"ts":"1970-01-01T00:00:00.000Z","type":"eml:output","mono":12,"text":"338350"}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":13,"ts":"1970-01-01T00:00:00.000Z","type":"eml:return","mono":13,"fn":"greet","value":"338350"}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":14,"ts":"1970-01-01T00:00:00.000Z","type":"eml:run:done","mono":14,"ok":true,"outputs":2,"anomalies":0}',
].join('\n');

// EML-shaped lines for events the clean committed traces don't contain: a failed
// execution-truth check (eml:equiv ok:false), a CRITICAL bug, and a run error.
// Same envelope as @eml/trace emits (see stream/EML-INTEROP.md).
const EML_TRACE_WITH_ANOMALIES = [
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":1,"ts":"1970-01-01T00:00:00.000Z","type":"eml:run:start","mono":1,"file":"buggy.eml","statements":2}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":2,"ts":"1970-01-01T00:00:00.000Z","type":"eml:equiv","mono":2,"actual":"7","expected":"7","ok":true}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":3,"ts":"1970-01-01T00:00:00.000Z","type":"eml:equiv","mono":3,"actual":"6","expected":"7","ok":false}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":4,"ts":"1970-01-01T00:00:00.000Z","type":"eml:bug","mono":4,"level":"CRITICAL","code":"E_RUNTIME","message":"ZeroDivisionError","ok":false}',
  '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":5,"ts":"1970-01-01T00:00:00.000Z","type":"eml:run:error","mono":5,"ok":false,"error":{"type":"ZeroDivisionError","message":"division by zero"}}',
].join('\n');

function main(): void {
  console.log('\x1b[1m\nEML trace consumer — verification\x1b[0m');

  // ── 1. A real EML trace is wire-compatible with PHOSPHOR's v1 envelope ────────
  head('Real EML trace · envelope compatibility');
  {
    const r = ingestEmlTrace(REAL_EML_TRACE);
    check('all 14 lines parse', r.summary.total === 14, `total=${r.summary.total}`);
    check('ZERO envelope violations on real EML output', r.invalidLines.length === 0,
      `invalid=${JSON.stringify(r.invalidLines)}`);
    check('event vocabulary counted', r.summary.byType['eml:def'] === 2 && r.summary.byType['eml:run:start'] === 1,
      `def=${r.summary.byType['eml:def']} start=${r.summary.byType['eml:run:start']}`);
    check('clean trace has no anomalies', r.anomalies.length === 0, `anomalies=${r.anomalies.length}`);
    check('lifecycle: started + done, not errored', r.lifecycle.started && r.lifecycle.done && !r.lifecycle.errored);
    // Deterministic traces share one ts + omit writer → mergeOrder falls back to mono.
    check('mergeOrder is total + stable (mono order)', r.ordered.length === 14 && r.ordered[0].seq === 1 && r.ordered[13].seq === 14,
      `[0]=${r.ordered[0].seq} [13]=${r.ordered[13].seq}`);
  }

  // ── 2. EML semantics + anomalies surface through PHOSPHOR machinery ───────────
  head('EML semantics · equiv / bug / error extraction');
  {
    const r = ingestEmlTrace(EML_TRACE_WITH_ANOMALIES);
    check('still zero envelope violations', r.invalidLines.length === 0, `invalid=${r.invalidLines.length}`);
    check('two eml:equiv verdicts extracted', r.equiv.length === 2, `equiv=${r.equiv.length}`);
    check('equiv verdicts carry the right ok/expected/actual',
      r.equiv[0].ok === true && r.equiv[1].ok === false && r.equiv[1].expected === '7' && r.equiv[1].actual === '6');
    check('one CRITICAL eml:bug extracted', r.bugs.length === 1 && r.bugs[0].level === 'CRITICAL',
      `bugs=${JSON.stringify(r.bugs.map(b => b.level))}`);
    // findAnomalies should catch: equiv ok:false, bug ok:false, run:error (:error$).
    check('findAnomalies flags the 3 EML anomalies', r.anomalies.length === 3,
      `anomalies=${r.anomalies.map(a => a.type).join(',')}`);
    check('eml:run:error is flagged by the :error$ rule',
      r.anomalies.some(a => a.type === 'eml:run:error'));
    check('lifecycle: started + errored, not done', r.lifecycle.started && r.lifecycle.errored && !r.lifecycle.done);
  }

  // ── 2b. `eml trace --run`: interpreter deferred, then real Python completed ───
  head('EML --run splice · incomplete interpreter + completed Python');
  {
    // Real wait.trace.jsonl prefix (interpreter defers an async @temporal_loop),
    // then the spliced real-Python execution events `eml trace --run` appends.
    const SPLICED = [
      '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":1,"ts":"1970-01-01T00:00:00.000Z","type":"eml:run:start","mono":1,"file":"wait.eml","statements":5}',
      '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":2,"ts":"1970-01-01T00:00:00.000Z","type":"eml:def","mono":2,"fn":"wait_ready","params":["flag"],"temperature":"neutral","async":true}',
      '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":3,"ts":"1970-01-01T00:00:00.000Z","type":"eml:unsupported","mono":3,"construct":"call run_temporal()","reason":"temporal runtime intrinsic — real Python only"}',
      '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":4,"ts":"1970-01-01T00:00:00.000Z","type":"eml:run:incomplete","mono":4,"reason":"unsupported","construct":"call run_temporal()"}',
      '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":5,"ts":"1970-01-01T00:00:00.000Z","type":"eml:temporal:start","mono":5,"fn":"wait_ready"}',
      '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":6,"ts":"1970-01-01T00:00:00.000Z","type":"eml:temporal:done","mono":6,"fn":"wait_ready","ok":true}',
      '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":7,"ts":"1970-01-01T00:00:00.000Z","type":"eml:python:exit","mono":7,"code":0}',
    ].join('\n');
    const r = ingestEmlTrace(SPLICED);
    check('lifecycle: interpreter incomplete BUT real run completed (splicedComplete)',
      r.lifecycle.started && r.lifecycle.incomplete && !r.lifecycle.done && r.lifecycle.splicedComplete,
      `started=${r.lifecycle.started} incomplete=${r.lifecycle.incomplete} done=${r.lifecycle.done} spliced=${r.lifecycle.splicedComplete}`);
    check('temporal events extracted (start + done ok:true)',
      r.temporal.length === 2 && r.temporal[1].ok === true, `temporal=${JSON.stringify(r.temporal.map(t => t.type))}`);
    check('pythonExit code captured (0)', r.pythonExit === 0, `pythonExit=${r.pythonExit}`);
    check('a --run-completed temporal program is NOT an anomaly', r.anomalies.length === 0, `anomalies=${r.anomalies.length}`);
  }

  // ── 3. The compatibility check is not vacuous — a foreign line is rejected ────
  head('Validation is real · a non-v1 line is reported');
  {
    const mixed = [
      '{"stream":"eml","proto":"phosphor-jsonl-v1","seq":1,"ts":"1970-01-01T00:00:00.000Z","type":"eml:output","mono":1,"text":"ok"}',
      '{"stream":"x","proto":"some-other-proto","seq":1,"ts":"1970-01-01T00:00:00.000Z","type":"x:y"}',
      '{"stream":"x","proto":"phosphor-jsonl-v1","ts":"1970-01-01T00:00:00.000Z","type":"NotADomainAction"}',
      'this is not json at all',
      '',
    ].join('\n');
    const r = ingestEmlTrace(mixed);
    check('malformed/non-json line is skipped (not parsed)', r.summary.total === 3, `parsed=${r.summary.total}`);
    check('the two invalid envelopes are reported', r.invalidLines.length === 2, `invalid=${r.invalidLines.length}`);
    check('the valid eml line is not flagged invalid',
      !r.invalidLines.some(v => v.index === 0));
  }

  // ── 4. EML Cts (source-level) bridges into PHOSPHOR machine-CTS views ────────
  head('EML Cts interop · symbols → dictionary, functions → attention, loops');
  {
    // Real `eml cts examples/phase2-cold-hot/square_sum.eml` output, as a typed
    // object literal (avoids JSON-escaping the embedded newlines/unicode).
    const CTS: EmlCts = {
      file: 'square_sum.eml',
      symbols: {
        def:     { type: 'function',    meaning: 'function_def',     target: 'def {name}({params}): ...' },
        '@cold': { type: 'temperature', meaning: 'cold_logic',       target: '@functools.cache' },
        'Σ':     { type: 'algebraic',   meaning: 'summation',        target: 'sum({expr} for {iter} in {range})' },
        '∈':     { type: 'range',       meaning: 'in_range',         target: 'range({start}, {end_plus_one})' },
        '[:]':   { type: 'range',       meaning: 'inclusive_range',  target: 'range({start}, {end} + 1)' },
        '=>':    { type: 'assignment',  meaning: 'bind',             target: '{target} = {expr}' },
        '@hot':  { type: 'temperature', meaning: 'hot_state',        target: '# @hot (dynamic state, not cached)' },
        '^0':    { type: 'control',     meaning: 'output',           target: 'print({value})' },
      },
      nodes: [
        { id: 'node_001', source: '@cold\ndef square_sum(N): ...', python: '@functools.cache\ndef square_sum(N): ...', dependencies: [], semanticType: 'function.cold' },
        { id: 'node_002', source: '@hot\ndef greet(name): ...',    python: 'def greet(name): ...',                    dependencies: [], semanticType: 'function.hot' },
        { id: 'node_003', source: 'square_sum(100) => total',      python: 'total = square_sum(100)',                 dependencies: ['square_sum'], semanticType: 'binding.call' },
        { id: 'node_004', source: 'total^0',                       python: 'print(total)',                           dependencies: ['total'], semanticType: 'control.output' },
        { id: 'node_005', source: 'greet(total)',                  python: 'greet(total)',                           dependencies: ['greet', 'total'], semanticType: 'expression' },
      ],
      functions: [
        { name: 'square_sum', temperature: 'cold', pure: true,  astHash: 'ada149ff', cached: false, importance: { callFrequency: 1, riskLevel: 0.2, dependencyDepth: 1, score: 0.28 }, sideEffects: [] },
        { name: 'greet',      temperature: 'hot',  pure: false, astHash: '835e9a9d', cached: false, importance: { callFrequency: 1, riskLevel: 0.8, dependencyDepth: 1, score: 0.52 }, sideEffects: ['輸出語句 ^0（print，I/O 副作用）'] },
      ],
      loops: [
        { loopKind: 'algebraic_sum', deterministic: true, terminating: true, source: 'Σ(i^2, i in [1:N]) => r' },
      ],
      commentTable: { node_001: '冷邏輯函數（可快取純函數）', node_004: '輸出指定值' },
      crossRefTable: { total: ['square_sum(100)'] },
    };

    check('parseEmlCts round-trips a real EML Cts JSON', isEmlCts(parseEmlCts(JSON.stringify(CTS))!));
    check('parseEmlCts rejects non-JSON / non-Cts', parseEmlCts('nope') === null && parseEmlCts('{"foo":1}') === null);

    const dict = emlCtsToDictionary(CTS);
    check('symbols → dictionary (8 tokens)', Object.keys(dict).length === 8, `keys=${Object.keys(dict).length}`);
    check('dictionary entry carries type + meaning + target',
      dict['@cold'].description.includes('temperature') && dict['@cold'].description.includes('cold_logic') && dict['@cold'].description.includes('@functools.cache'),
      dict['@cold'].description);

    const att = emlCtsAttention(CTS);
    check('functions → attention, sorted by importance desc', att.length === 2 && att[0].name === 'greet' && att[1].name === 'square_sum',
      att.map(a => `${a.name}:${a.importanceScore}`).join(' '));
    check('hot function flagged impure + high risk', att[0].temperature === 'hot' && att[0].pure === false && att[0].riskLevel === 0.8);
    check('cold function flagged pure', att[1].temperature === 'cold' && att[1].pure === true);

    const loops = emlCtsLoops(CTS);
    check('loops → control-flow hints (algebraic_sum, det+term)',
      loops.length === 1 && loops[0].loopKind === 'algebraic_sum' && loops[0].deterministic && loops[0].terminating);

    check('classifyEmlNode splits domain.action (NOT coerced to a DataType)',
      classifyEmlNode('function.cold').domain === 'function' && classifyEmlNode('function.cold').action === 'cold'
      && classifyEmlNode('expression').action === null);

    const dg = digestEmlCts(CTS);
    check('digestEmlCts summarizes the three transferable views',
      dg.file === 'square_sum.eml' && dg.nodeCount === 5 && Object.keys(dg.dictionary).length === 8 && dg.attention.length === 2 && dg.loops.length === 1);
  }

  console.log('\x1b[1m\n── Summary ──\x1b[0m');
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log('\x1b[31m  failures: ' + failures.join('; ') + '\x1b[0m');
    process.exitCode = 1;
  } else {
    console.log('\x1b[32m  EML interop verified (trace + Cts) — EML → PHOSPHOR loop wired\x1b[0m');
  }
}

main();

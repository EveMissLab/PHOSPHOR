import { useMemo, useRef, useState } from 'react';
import {
  EAI_PROTO, VMController,
  PROGRAM_FIBONACCI, PROGRAM_COUNTER, PROGRAM_XOR_CIPHER,
} from '../../eml-vm16-core';
import { createCallableVM, PROGRAM_FUNCTIONS } from '../../eml-vm16-callable';
import { buildHeadlessSnapshot, headlessSnapshotToStreamFields } from '../../headless-snapshot';
import { createEmitter, memorySink, mergeOrder, findAnomalies } from '../../stream/phosphor-stream';
import {
  buildPhosphorWorkbook, sheetToCsv, workbookToSpreadsheetML,
} from '../../spreadsheet/phosphor-sheet';
import {
  CONTROL_COMMANDS, appendControlRow, executeControlSheet, parseControlSheet,
  withControlSheet,
} from '../../spreadsheet/phosphor-control';
import { controlHandlersFromHost } from '../../spreadsheet/phosphor-control-host';
import { readControlCommandsFromXlsxFile } from '../../spreadsheet/phosphor-control-xlsx';
import { workbookToXlsxBytes } from '../../spreadsheet/phosphor-xlsx';
import { C, panelHead, Screen, TabTitle } from './theme.jsx';

const PROGRAMS = { fibonacci: PROGRAM_FIBONACCI, counter: PROGRAM_COUNTER, xor: PROGRAM_XOR_CIPHER };
const VM_ID = 'sheet-vm';

function download(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function createSession(program) {
  const sink = memorySink();
  const root = createEmitter({ stream: 'phosphor-sheet-ui', sink });
  const sessionId = `sheet-${program.id}-${Date.now().toString(36)}`;
  const emitter = root.child({ session_id: sessionId });
  const controller = new VMController(program, VM_ID);
  let previousMemory = new Uint8Array(controller.getState().memory);
  let paused = false;
  let running = false;

  const snapshot = (prevMem = previousMemory) => buildHeadlessSnapshot({
    id: VM_ID,
    state: controller.getState(),
    mode: 'ai',
    arch: 'EML-VM-16',
    cts: program.cts,
    prevMem,
  });

  const emitSnapshot = prevMem => {
    const snap = snapshot(prevMem);
    emitter.emit('vm:tick', headlessSnapshotToStreamFields(snap));
    if (snap.halted) emitter.emit('vm:halt', headlessSnapshotToStreamFields(snap));
    previousMemory = new Uint8Array(controller.getState().memory);
    return snap;
  };

  const ensureTarget = target => {
    if (target !== VM_ID) throw new Error(`unknown VM target: ${target}`);
  };

  return {
    program, sink, emitter, controller, sessionId,
    inspect(target) {
      ensureTarget(target);
      return snapshot();
    },
    async step(target, count) {
      ensureTarget(target);
      if (running) throw new Error('VM is already running');
      paused = false;
      let steps = 0;
      let snap = snapshot();
      while (!controller.getState().halted && steps < count) {
        const prev = new Uint8Array(controller.getState().memory);
        controller.step();
        snap = emitSnapshot(prev);
        steps++;
      }
      return { steps, halted: snap.halted, snapshot: snap };
    },
    async run(target, maxSteps) {
      ensureTarget(target);
      if (running) throw new Error('VM is already running');
      running = true; paused = false;
      let steps = 0;
      let snap = snapshot();
      try {
        while (!paused && !controller.getState().halted && steps < maxSteps) {
          const prev = new Uint8Array(controller.getState().memory);
          controller.step();
          snap = emitSnapshot(prev);
          steps++;
          if (steps % 2000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
      } finally { running = false; }
      return { steps, halted: snap.halted, paused, snapshot: snap };
    },
    pause(target) {
      ensureTarget(target);
      paused = true;
      emitter.emit('vm:pause', { vm_id: VM_ID, vm_tick: controller.getState().ticks });
      return { paused: true, tick: controller.getState().ticks };
    },
    reset(target) {
      ensureTarget(target);
      if (running) throw new Error('cannot reset while VM is running');
      const prev = new Uint8Array(controller.getState().memory);
      controller.reset(); paused = false;
      emitter.emit('vm:reset', { vm_id: VM_ID, program: program.id });
      const snap = emitSnapshot(prev);
      return { reset: true, snapshot: snap };
    },
    async call(target, name, args) {
      if (target !== 'callable' && target !== VM_ID) throw new Error(`unknown call target: ${target}`);
      const vm = createCallableVM(PROGRAM_FUNCTIONS);
      const result = await vm.call(name, args);
      emitter.emit('vm:call', { function: name, args, return_value: result.returnValue, steps: result.steps });
      return { function: name, args, returnValue: result.returnValue, steps: result.steps };
    },
    replay(args) {
      const events = mergeOrder(sink.events);
      const from = Number(args.from_seq ?? 0);
      const to = Number(args.to_seq ?? Number.MAX_SAFE_INTEGER);
      const selected = events.filter(event => Number(event.seq ?? 0) >= from && Number(event.seq ?? 0) <= to);
      return { events: selected.length, anomalies: findAnomalies(selected).length, from_seq: from, to_seq: to };
    },
  };
}

export default function SheetWorkbench() {
  const [program, setProgram] = useState('fibonacci');
  const [maxSteps, setMaxSteps] = useState(120);
  const [workbook, setWorkbook] = useState(null);
  const [sheetId, setSheetId] = useState('manifest');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [draft, setDraft] = useState({ command: 'vm:inspect', target: VM_ID, args: '{}', requestedBy: 'human', approved: false });
  const sessionRef = useRef(null);
  const importRef = useRef(null);
  const commandSeqRef = useRef(0);

  const active = useMemo(
    () => workbook?.sheets.find(s => s.id === sheetId) ?? workbook?.sheets[0] ?? null,
    [workbook, sheetId],
  );
  const controls = useMemo(() => workbook ? parseControlSheet(workbook) : [], [workbook]);

  function rebuild(session, controlRows = controls) {
    const model = buildPhosphorWorkbook({
      events: session.sink.events,
      cts: session.program.cts,
      controlRows,
      manifest: {
        eai_proto: EAI_PROTO,
        stream_proto: 'phosphor-jsonl-v1',
        program: session.program.id,
        vm_id: VM_ID,
        session_id: session.sessionId,
        source: 'PHOSPHOR UI',
      },
    });
    setWorkbook(model);
    return model;
  }

  async function build() {
    setBusy(true); setMessage('');
    try {
      const session = createSession(PROGRAMS[program]);
      sessionRef.current = session;
      await session.run(VM_ID, Math.max(1, Math.min(50000, maxSteps | 0)));
      rebuild(session, []);
      setSheetId('manifest');
      setMessage(`session ${session.sessionId} built`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  function addCommand() {
    if (!workbook) return;
    const now = new Date().toISOString();
    const row = {
      command_id: `cmd-${Date.now().toString(36)}-${++commandSeqRef.current}`,
      command: draft.command,
      target: draft.target,
      args_json: draft.args || '{}',
      requested_by: draft.requestedBy,
      approved: draft.approved,
      status: draft.approved ? 'APPROVED' : 'QUEUED',
      created_at: now,
      executed_at: '', result_json: '', error: '',
    };
    setWorkbook(appendControlRow(workbook, row));
    setSheetId('control');
    setMessage(`queued ${row.command_id}`);
  }

  function updateControl(index, key, value) {
    if (!workbook) return;
    const rows = parseControlSheet(workbook).map((row, i) => i === index ? { ...row, [key]: value } : row);
    setWorkbook(withControlSheet(workbook, rows));
  }

  async function executePending() {
    if (!workbook) return;
    let session = sessionRef.current;
    if (!session) {
      session = createSession(PROGRAMS[program]);
      sessionRef.current = session;
    }
    setBusy(true); setMessage('');
    try {
      const host = {
        inspect: (target, args) => session.inspect(target, args),
        run: (target, steps) => session.run(target, steps),
        pause: target => session.pause(target),
        step: (target, count) => session.step(target, count),
        reset: target => session.reset(target),
        call: (target, name, args) => session.call(target, name, args),
        replay: args => session.replay(args),
        exportSheet: (format, sheet) => {
          const current = workbook;
          if (format === 'xlsx') download('phosphor-workbook.xlsx', workbookToXlsxBytes(current), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
          else if (format === 'xml') download('phosphor-workbook.xml', workbookToSpreadsheetML(current), 'application/xml');
          else {
            const model = current.sheets.find(item => item.id === sheet || item.name === sheet) ?? active;
            if (!model) throw new Error('sheet:export could not resolve a sheet');
            download(`${model.name}.csv`, sheetToCsv(model), 'text/csv;charset=utf-8');
          }
          return { exported: format, sheet: sheet ?? null };
        },
      };
      const result = await executeControlSheet(
        workbook,
        controlHandlersFromHost(host),
        { allowedTargets: [VM_ID, 'callable'] },
        (type, fields) => session.emitter.emit(type, fields),
      );
      const rows = parseControlSheet(result.workbook);
      rebuild(session, rows);
      setSheetId('control');
      setMessage(`${result.processed} processed · ${result.skipped} inert/terminal`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  }

  async function importControl(file) {
    if (!file) return;
    setBusy(true); setMessage('');
    try {
      const rows = await readControlCommandsFromXlsxFile(file);
      const base = workbook ?? buildPhosphorWorkbook({
        events: [], cts: PROGRAMS[program].cts,
        manifest: { eai_proto: EAI_PROTO, program, source: 'Imported XLSX' },
      });
      setWorkbook(withControlSheet(base, rows));
      setSheetId('control');
      setMessage(`imported ${rows.length} control rows from ${file.name}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : String(error)); }
    finally {
      setBusy(false);
      if (importRef.current) importRef.current.value = '';
    }
  }

  return (
    <Screen>
      <TabTitle accent={C.ai} title="SHEET · WORKBOOK + CONTROL"
        sub="Third EAI projection · export execution, edit command intent in Excel, re-import, validate, execute through explicit host handlers, and audit every result" />

      <div style={{ display: 'flex', gap: '7px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '10px' }}>
        {Object.keys(PROGRAMS).map(name => (
          <button key={name} onClick={() => setProgram(name)} style={button(program === name)}>{name}</button>
        ))}
        <span style={{ color: '#2a5a4a', fontSize: '9px' }}>max steps</span>
        <input value={maxSteps} onChange={e => setMaxSteps(Number(e.target.value) || 0)} style={input} />
        <button onClick={build} disabled={busy} style={action}>{busy ? '…' : '▶ BUILD SESSION'}</button>
        {workbook && <>
          <button onClick={() => download('phosphor-workbook.xlsx', workbookToXlsxBytes(workbook), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')} style={exportBtn}>↓ XLSX</button>
          <button onClick={() => download('phosphor-workbook.xml', workbookToSpreadsheetML(workbook), 'application/xml')} style={exportBtn}>↓ XML</button>
          {active && <button onClick={() => download(`${active.name}.csv`, sheetToCsv(active), 'text/csv;charset=utf-8')} style={exportBtn}>↓ CURRENT CSV</button>}
          <button onClick={() => importRef.current?.click()} style={importBtn}>↑ IMPORT XLSX</button>
          <input ref={importRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={e => importControl(e.target.files?.[0])} style={{ display: 'none' }} />
        </>}
      </div>

      {message && <div style={{ marginBottom: '9px', color: message.includes('error') ? C.no : C.sem, fontSize: '9px' }}>{message}</div>}

      {workbook && <div style={{ border: `1px solid ${C.semDim}`, padding: '8px', marginBottom: '12px' }}>
        <div style={{ ...panelHead, color: C.sem, borderColor: C.semDim }}>CONTROL INTENT · DRAFT IS INERT · QUEUED/APPROVED ONLY</div>
        <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={draft.command} onChange={e => setDraft({ ...draft, command: e.target.value })} style={select}>
            {CONTROL_COMMANDS.map(command => <option key={command}>{command}</option>)}
          </select>
          <input value={draft.target} onChange={e => setDraft({ ...draft, target: e.target.value })} placeholder="target" style={{ ...input, width: '92px' }} />
          <input value={draft.args} onChange={e => setDraft({ ...draft, args: e.target.value })} placeholder="Args JSON" style={{ ...input, width: '250px' }} />
          <input value={draft.requestedBy} onChange={e => setDraft({ ...draft, requestedBy: e.target.value })} placeholder="requested by" style={{ ...input, width: '92px' }} />
          <label style={{ color: C.sem, fontSize: '9px' }}><input type="checkbox" checked={draft.approved} onChange={e => setDraft({ ...draft, approved: e.target.checked })} /> approved</label>
          <button onClick={addCommand} disabled={busy} style={exportBtn}>＋ ADD COMMAND</button>
          <button onClick={executePending} disabled={busy} style={action}>▶ EXECUTE READY</button>
        </div>
      </div>}

      {!workbook ? (
        <div style={{ ...panelHead, color: '#2a5a4a' }}>Build a VM session, then export or control it through the same workbook model.</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px,220px) minmax(0,1fr)', gap: '12px' }}>
          <div style={{ border: `1px solid ${C.aiDim}`, padding: '7px', minHeight: '420px' }}>
            <div style={{ ...panelHead, color: C.ai, borderColor: C.aiDim }}>WORKBOOK · {workbook.proto}</div>
            {workbook.sheets.map(s => (
              <button key={s.id} onClick={() => setSheetId(s.id)} style={{
                display: 'block', width: '100%', textAlign: 'left', marginBottom: '4px',
                background: s.id === active?.id ? 'rgba(0,210,255,0.09)' : 'none',
                border: `1px solid ${s.id === active?.id ? C.ai : '#12333a'}`,
                color: s.id === active?.id ? C.ai : '#2a6670', cursor: 'pointer',
                fontFamily: 'inherit', fontSize: '9px', padding: '5px 7px',
              }}>{s.name} <span style={{ float: 'right', opacity: 0.6 }}>{s.rows.length}</span></button>
            ))}
          </div>

          {active && <div style={{ minWidth: 0 }}>
            <div style={{ ...panelHead, color: C.ai, borderColor: C.aiDim }}>{active.name} · {active.description}</div>
            {active.id === 'control'
              ? <ControlEditor rows={controls} update={updateControl} />
              : <SheetPreview active={active} />}
          </div>}
        </div>
      )}
    </Screen>
  );
}

function ControlEditor({ rows, update }) {
  return <div style={{ overflow: 'auto', maxHeight: '560px', border: `1px solid ${C.aiDim}` }}>
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '9px' }}>
      <thead><tr>{['ID','Command','Target','Args JSON','Requested By','Approved','Status','Executed At','Result','Error'].map(label => <th key={label} style={th}>{label}</th>)}</tr></thead>
      <tbody>{rows.map((row, i) => <tr key={`${row.command_id}-${i}`}>
        <td style={td}><input value={row.command_id} onChange={e => update(i, 'command_id', e.target.value)} style={cellInput} /></td>
        <td style={td}><select value={row.command} onChange={e => update(i, 'command', e.target.value)} style={cellInput}>{['', ...CONTROL_COMMANDS].map(v => <option key={v}>{v}</option>)}</select></td>
        <td style={td}><input value={row.target} onChange={e => update(i, 'target', e.target.value)} style={cellInput} /></td>
        <td style={td}><input value={row.args_json} onChange={e => update(i, 'args_json', e.target.value)} style={{ ...cellInput, minWidth: '190px' }} /></td>
        <td style={td}><input value={row.requested_by} onChange={e => update(i, 'requested_by', e.target.value)} style={cellInput} /></td>
        <td style={td}><input type="checkbox" checked={row.approved} onChange={e => update(i, 'approved', e.target.checked)} /></td>
        <td style={td}><select value={row.status} onChange={e => update(i, 'status', e.target.value)} style={cellInput}>{['DRAFT','QUEUED','APPROVED','EXECUTED','REJECTED','FAILED'].map(v => <option key={v}>{v}</option>)}</select></td>
        <td style={td}>{row.executed_at}</td><td style={td}>{row.result_json}</td><td style={{ ...td, color: row.error ? C.no : td.color }}>{row.error}</td>
      </tr>)}</tbody>
    </table>
  </div>;
}

function SheetPreview({ active }) {
  return <>
    <div style={{ overflow: 'auto', maxHeight: '520px', border: `1px solid ${C.aiDim}` }}>
      <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '9px' }}>
        <thead><tr>{active.columns.map(c => <th key={c.key} style={th}>{c.label}</th>)}</tr></thead>
        <tbody>{active.rows.slice(0, 250).map((row, i) => (
          <tr key={i}>{active.columns.map((c, j) => <td key={c.key} style={td}>{format(row[j])}</td>)}</tr>
        ))}</tbody>
      </table>
    </div>
    {active.rows.length > 250 && <div style={{ color: '#2a5a4a', fontSize: '8px', marginTop: '4px' }}>UI preview capped at 250 rows; exports contain all rows.</div>}
  </>;
}

function format(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}
const button = active => ({
  background: active ? 'rgba(0,210,255,0.08)' : 'none', border: `1px solid ${active ? C.ai : '#1a3a44'}`,
  color: active ? C.ai : '#1a3a44', cursor: 'pointer', fontSize: '9px', fontFamily: 'inherit', padding: '3px 8px',
});
const action = { background: 'rgba(0,210,255,0.08)', border: `1px solid ${C.ai}`, color: C.ai, cursor: 'pointer', fontSize: '10px', fontFamily: 'inherit', padding: '4px 12px' };
const exportBtn = { ...action, color: C.sem, border: `1px solid ${C.sem}`, background: 'rgba(90,240,200,0.06)' };
const importBtn = { ...action, color: C.amber, border: `1px solid ${C.amber}`, background: 'rgba(255,180,40,0.06)' };
const input = { width: '58px', background: '#040c04', color: C.ai, border: '1px solid #13313a', fontFamily: 'inherit', fontSize: '10px', padding: '3px 5px' };
const select = { ...input, width: '130px' };
const cellInput = { background: '#040c04', color: C.sem, border: '1px solid #13312a', fontFamily: 'inherit', fontSize: '9px', padding: '2px 3px', width: '100%', minWidth: '90px' };
const th = { position: 'sticky', top: 0, background: '#07130c', color: C.ai, border: '1px solid #12333a', padding: '4px 6px', textAlign: 'left', whiteSpace: 'nowrap' };
const td = { color: '#58a88a', border: '1px solid #0e2a25', padding: '3px 6px', verticalAlign: 'top', whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxWidth: '420px' };

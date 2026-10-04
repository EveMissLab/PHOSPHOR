import assert from 'node:assert/strict';
import {
  SHEET_PROTO, buildPhosphorWorkbook, isAnomaly, orderEvents,
  sheetToCsv, snapshotsFromEvents, workbookToCsvMap, workbookToSpreadsheetML,
} from './phosphor-sheet.ts';

let checks = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); checks++; }
function eq<T>(actual: T, expected: T, message: string) { assert.deepEqual(actual, expected, message); checks++; }

const events = [
  { stream: 'demo', proto: 'phosphor-jsonl-v1', seq: 2, mono: 2, writer: 'w1', ts: '2026-01-01T00:00:01Z', type: 'vm:halt', vm_tick: 2, vm_id: 'vm0', arch: 'EML-VM-16', pc: '0x02', instruction: 'HALT', registers: { R0: 8, R1: 5 }, flags: { Z: false, N: false, G: true }, changed: [], halted: true },
  { stream: 'demo', proto: 'phosphor-jsonl-v1', seq: 1, mono: 1, writer: 'w1', ts: '2026-01-01T00:00:00Z', type: 'vm:tick', vm_tick: 1, vm_id: 'vm0', arch: 'EML-VM-16', pc: '0x00', pc_symbol: 'start', instruction: 'ADD R0,R1', registers: { R0: 8, R1: 5 }, flags: { Z: false, N: false, G: true }, changed: [{ addr: '0x20', symbol: 'result', before: 3, after: 8 }], halted: false },
  { stream: 'demo', proto: 'phosphor-jsonl-v1', seq: 3, mono: 3, writer: 'w1', ts: '2026-01-01T00:00:02Z', type: 'compute:check', expected: 13, actual: 12, ok: false },
  { stream: 'demo', proto: 'phosphor-jsonl-v1', seq: 4, mono: 4, writer: 'w1', ts: '2026-01-01T00:00:03Z', type: 'meta:dictionary', dictionary: { 'compute:check': { description: 'Compare result.', fields: { expected: 'ground truth', actual: 'observed' } } } },
];

const ordered = orderEvents(events);
eq(ordered[0].seq, 1, 'events are ordered by timestamp/writer/mono');
eq(snapshotsFromEvents(events).length, 2, 'vm events become snapshots');
ok(isAnomaly(events[2]), 'failed check is anomaly');
ok(!isAnomaly(events[0]), 'normal halt is not anomaly');

const wb = buildPhosphorWorkbook({
  events,
  cts: { symbolTable: { '0x20': { name: 'result' } }, segments: ['code', 'data'] },
  manifest: { eai_proto: 'EML-EAI-2026-v0.5', program: 'demo' },
  generatedAt: '2026-01-01T00:00:00Z',
});

eq(wb.proto, SHEET_PROTO, 'workbook protocol');
eq(wb.generated_at, '2026-01-01T00:00:00Z', 'deterministic generated_at');
eq(wb.sheets.length, 10, 'ten canonical sheets');
eq(wb.manifest.snapshot_count, 2, 'manifest snapshot count');
eq(wb.manifest.event_count, 4, 'manifest event count');
eq(wb.manifest.anomaly_count, 1, 'manifest anomaly count');

const tick = wb.sheets.find(s => s.id === 'ticks')!;
eq(tick.rows.length, 2, 'tick ledger rows');
eq(tick.rows[0][3], 1, 'tick order preserved');
const regs = wb.sheets.find(s => s.id === 'registers')!;
eq(regs.columns.map(c => c.key), ['vm_id', 'tick', 'R0', 'R1'], 'dynamic register columns');
const mem = wb.sheets.find(s => s.id === 'memory')!;
eq(mem.rows[0].slice(2), ['0x20', 'result', 3, 8, 5], 'memory before/after/delta');
const stream = wb.sheets.find(s => s.id === 'events')!;
eq(stream.rows.length, 4, 'event stream rows');
const dict = wb.sheets.find(s => s.id === 'dictionary')!;
eq(dict.rows[0], ['compute:check', 'Compare result.', 'expected', 'ground truth'], 'dictionary expanded');
const anomalies = wb.sheets.find(s => s.id === 'anomalies')!;
eq(anomalies.rows.length, 1, 'anomaly sheet rows');
const intent = wb.sheets.find(s => s.id === 'intent')!;
eq(intent.rows.length, 1, 'intent/actual rows');
const cts = wb.sheets.find(s => s.id === 'cts')!;
ok(cts.rows.some(row => row[0] === 'symbolTable.0x20.name'), 'CTS object flattened');

const csv = sheetToCsv(tick);
ok(csv.startsWith('\uFEFF'), 'CSV has UTF-8 BOM');
ok(csv.includes('VM ID,Architecture,Mode,Tick'), 'CSV header');
const csvMap = workbookToCsvMap(wb);
eq(Object.keys(csvMap).length, 10, 'CSV map has one file per sheet');
ok('00_Manifest.csv' in csvMap, 'manifest CSV named by sheet');
const control = wb.sheets.find(s => s.id === 'control')!;
eq(control.name, '09_Control', 'control sheet is canonical');
eq(control.rows[0][6], 'DRAFT', 'control template begins in DRAFT');
const xml = workbookToSpreadsheetML(wb);
ok(xml.includes('Excel.Sheet'), 'SpreadsheetML declares Excel application');
ok(xml.includes('ss:Name="01_Tick_Ledger"'), 'SpreadsheetML contains tick sheet');
ok(xml.includes('ss:Type="Boolean">1</Data>'), 'SpreadsheetML serializes booleans');
ok(!xml.includes('[object Object]'), 'structured values are JSON before XML export');

console.log(`PHOSPHOR-SHEET verification: ${checks} checks passed`);

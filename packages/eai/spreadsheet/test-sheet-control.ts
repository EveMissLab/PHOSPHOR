import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPhosphorWorkbook } from './phosphor-sheet.ts';
import { workbookToXlsxBytes } from './phosphor-xlsx.ts';
import {
  executeControlSheet, parseControlSheet, validateControlCommand, withControlSheet,
  type ControlRow,
} from './phosphor-control.ts';
import { controlHandlersFromHost } from './phosphor-control-host.ts';
import { readControlCommandsFromXlsxBytes as readBrowserControl } from './phosphor-control-xlsx.ts';
import { readControlCommandsFromXlsx, readControlCommandsFromXlsxBytes } from './phosphor-control-xlsx-node.ts';

let checks = 0;
function ok(value: unknown, message: string) { assert.ok(value, message); checks++; }
function eq<T>(actual: T, expected: T, message: string) { assert.deepEqual(actual, expected, message); checks++; }

const base = buildPhosphorWorkbook({ events: [], generatedAt: '2026-07-14T00:00:00Z' });
eq(base.sheets.length, 10, 'canonical workbook includes control sheet');
eq(base.sheets.at(-1)?.name, '09_Control', 'control sheet is final canonical sheet');

const rows: ControlRow[] = [
  {
    command_id: 'cmd-draft', command: 'vm:inspect', target: 'vm0', args_json: '{}',
    requested_by: 'tester', approved: false, status: 'DRAFT', created_at: '', executed_at: '', result_json: '', error: '',
  },
  {
    command_id: 'cmd-read', command: 'vm:inspect', target: 'vm0', args_json: '{}',
    requested_by: 'tester', approved: false, status: 'QUEUED', created_at: '', executed_at: '', result_json: '', error: '',
  },
  {
    command_id: 'cmd-step', command: 'vm:step', target: 'vm0', args_json: '{"count":2}',
    requested_by: 'tester', approved: true, status: 'APPROVED', created_at: '', executed_at: '', result_json: '', error: '',
  },
  {
    command_id: 'cmd-bad-args', command: 'vm:step', target: 'vm0', args_json: '{"count":0}',
    requested_by: 'tester', approved: true, status: 'APPROVED', created_at: '', executed_at: '', result_json: '', error: '',
  },
  {
    command_id: 'cmd-denied', command: 'vm:reset', target: 'vm0', args_json: '{}',
    requested_by: 'tester', approved: false, status: 'QUEUED', created_at: '', executed_at: '', result_json: '', error: '',
  },
];
const workbook = withControlSheet(base, rows);
eq(parseControlSheet(workbook).length, 5, 'control rows parse from workbook model');
ok(validateControlCommand(rows[0]).valid, 'read-only inspect validates structurally');
ok(validateControlCommand(rows[2]).valid, 'approved mutating command validates');
ok(!validateControlCommand(rows[3]).valid, 'command-specific argument range is enforced');
ok(!validateControlCommand(rows[4]).valid, 'unapproved mutating command is rejected');
ok(!validateControlCommand({ ...rows[1], target: '../unsafe' }).valid, 'unsafe target is rejected');
ok(!validateControlCommand({ ...rows[1], command_id: 'bad id' }).valid, 'unsafe command id is rejected');

const bytes = workbookToXlsxBytes(workbook);
eq(String.fromCharCode(bytes[0], bytes[1]), 'PK', 'real XLSX starts with ZIP signature');
ok(bytes.length > 5000, 'XLSX package has OOXML payload');
ok(new TextDecoder().decode(bytes).includes('<dataValidations count="3">'), 'control sheet includes Excel data validation rules');
const imported = readControlCommandsFromXlsxBytes(bytes);
eq(imported.map(row => row.command_id), rows.map(row => row.command_id), 'Node XLSX control rows round-trip');
eq(imported[2].approved, true, 'boolean approval round-trips');
eq(imported[2].args_json, '{"count":2}', 'JSON args round-trip');
const browserImported = await readBrowserControl(bytes);
eq(browserImported.map(row => row.command_id), rows.map(row => row.command_id), 'browser-safe XLSX reader imports stored OOXML');

const dir = mkdtempSync(join(tmpdir(), 'phosphor-sheet-'));
const file = join(dir, 'control.xlsx');
writeFileSync(file, bytes);
eq(readControlCommandsFromXlsx(file).length, 5, 'Node path reader imports XLSX');
ok(readFileSync(file).length === bytes.length, 'XLSX persisted without mutation');
rmSync(dir, { recursive: true, force: true });

const calls: string[] = [];
const handlers = controlHandlersFromHost({
  inspect: target => { calls.push(`inspect:${target}`); return { target, state: 'ready' }; },
  step: (target, count) => { calls.push(`step:${target}:${count}`); return { target, steps: count }; },
  reset: target => { calls.push(`reset:${target}`); return { target, reset: true }; },
});
const emitted: { type: string; fields: Record<string, unknown> }[] = [];
const executed = await executeControlSheet(
  workbook,
  handlers,
  { allowedTargets: ['vm0'] },
  (type, fields) => emitted.push({ type, fields }),
  (() => { let n = 0; return () => `2026-07-14T00:00:0${n++}Z`; })(),
);
eq(executed.processed, 4, 'only QUEUED/APPROVED commands are processed');
eq(executed.skipped, 1, 'DRAFT command remains inert');
const finalRows = parseControlSheet(executed.workbook);
eq(finalRows[0].status, 'DRAFT', 'draft command is not executed');
eq(finalRows[1].status, 'EXECUTED', 'queued read-only command executed');
eq(finalRows[2].status, 'EXECUTED', 'approved mutation executed');
eq(finalRows[3].status, 'REJECTED', 'invalid command args rejected');
eq(finalRows[4].status, 'REJECTED', 'unapproved mutation rejected');
ok(finalRows[1].result_json.includes('ready'), 'handler result stored in ledger');
ok(finalRows[3].error.includes('count must be an integer'), 'argument rejection reason stored');
ok(finalRows[4].error.includes('approval required'), 'approval rejection reason stored');
eq(calls, ['inspect:vm0', 'step:vm0:2'], 'host adapter exposes only commands that passed governance');
ok(emitted.some(item => item.type === 'sheet:command_executed'), 'execution audit event emitted');
ok(emitted.some(item => item.type === 'sheet:command_rejected'), 'rejection audit event emitted');
eq(executed.events.every(event => event.proto === 'phosphor-jsonl-v1'), true, 'control audit reuses phosphor stream envelope');

console.log(`PHOSPHOR-SHEET interactive control/XLSX verification: ${checks} checks passed`);

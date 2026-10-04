/**
 * PHOSPHOR-SHEET control plane.
 *
 * Spreadsheet rows express command intent. They never call VM operations
 * directly. A host supplies an explicit handler map, and every decision is
 * emitted back to phosphor-stream for deterministic audit.
 */

import type { EventLike, SheetCell, SheetModel, WorkbookModel } from './phosphor-sheet.ts';

export const CONTROL_SHEET_ID = 'control';
export const CONTROL_SHEET_NAME = '09_Control';

export const CONTROL_COMMANDS = [
  'vm:inspect', 'vm:run', 'vm:pause', 'vm:step', 'vm:reset', 'vm:call',
  'stream:replay', 'sheet:export', 'wasm:apply_optimization',
] as const;
export type ControlCommandName = typeof CONTROL_COMMANDS[number];
export type ControlStatus = 'DRAFT' | 'QUEUED' | 'APPROVED' | 'EXECUTED' | 'REJECTED' | 'FAILED';

export interface ControlRow {
  command_id: string;
  command: string;
  target: string;
  args_json: string;
  requested_by: string;
  approved: boolean;
  status: ControlStatus;
  created_at: string;
  executed_at: string;
  result_json: string;
  error: string;
}

export interface ValidatedControlCommand extends ControlRow {
  command: ControlCommandName;
  args: Record<string, unknown>;
}

export interface ControlPolicy {
  allowed?: readonly ControlCommandName[];
  allowedTargets?: readonly string[];
  requireApprovalForMutations?: boolean;
  maxArgsBytes?: number;
}

export type ControlHandler = (command: ValidatedControlCommand) => unknown | Promise<unknown>;
export type ControlHandlers = Partial<Record<ControlCommandName, ControlHandler>>;
export type ControlEmit = (type: string, fields: Record<string, unknown>) => void;

const MUTATING = new Set<ControlCommandName>(['vm:run', 'vm:pause', 'vm:step', 'vm:reset', 'vm:call', 'wasm:apply_optimization']);
const TERMINAL = new Set<ControlStatus>(['EXECUTED', 'REJECTED', 'FAILED']);
const READY = new Set<ControlStatus>(['QUEUED', 'APPROVED']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const CONTROL_COLUMNS = [
  { key: 'command_id', label: 'Command ID' },
  { key: 'command', label: 'Command' },
  { key: 'target', label: 'Target' },
  { key: 'args_json', label: 'Args JSON', kind: 'json' as const },
  { key: 'requested_by', label: 'Requested By' },
  { key: 'approved', label: 'Approved', kind: 'boolean' as const },
  { key: 'status', label: 'Status' },
  { key: 'created_at', label: 'Created At', kind: 'timestamp' as const },
  { key: 'executed_at', label: 'Executed At', kind: 'timestamp' as const },
  { key: 'result_json', label: 'Result JSON', kind: 'json' as const },
  { key: 'error', label: 'Error' },
];

/**
 * Reject a 09_Control sheet whose header row doesn't match CONTROL_COLUMNS
 * position-for-position. The XLSX readers map data cells by column index, so
 * a column inserted/reordered/removed in Excel would otherwise silently
 * shift every field one slot — fail loud instead of guessing.
 */
export function assertControlHeader(header: SheetCell[]): void {
  CONTROL_COLUMNS.forEach((expected, index) => {
    const actual = String(header[index] ?? '').trim();
    if (actual !== expected.label) {
      throw new Error(
        `Unsupported 09_Control layout: column ${index + 1} is "${actual || '(empty)'}", expected "${expected.label}". `
        + 'Columns must not be inserted, removed, or reordered before re-importing.',
      );
    }
  });
}

export function blankControlRow(id = 'cmd-001'): ControlRow {
  return {
    command_id: id, command: '', target: '', args_json: '{}', requested_by: '',
    approved: false, status: 'DRAFT', created_at: '', executed_at: '', result_json: '', error: '',
  };
}

export function controlSheet(rows: ControlRow[] = [blankControlRow()]): SheetModel {
  return {
    id: CONTROL_SHEET_ID,
    name: CONTROL_SHEET_NAME,
    description: 'Validated command intent. DRAFT rows are inert; mutating commands require approval and host-provided handlers.',
    columns: CONTROL_COLUMNS,
    rows: rows.map(row => CONTROL_COLUMNS.map(column => row[column.key as keyof ControlRow] as SheetCell)),
  };
}

export function withControlSheet(workbook: WorkbookModel, rows?: ControlRow[]): WorkbookModel {
  const sheets = workbook.sheets.filter(sheet => sheet.id !== CONTROL_SHEET_ID && sheet.name !== CONTROL_SHEET_NAME);
  return { ...workbook, sheets: [...sheets, controlSheet(rows)] };
}

export function appendControlRow(workbook: WorkbookModel, row: ControlRow): WorkbookModel {
  return withControlSheet(workbook, [...parseControlSheet(workbook), row]);
}

function rowObject(sheet: SheetModel, row: SheetCell[]): Record<string, SheetCell> {
  return Object.fromEntries(sheet.columns.map((column, index) => [column.key, row[index] ?? null]));
}

function status(value: unknown): ControlStatus {
  const normalized = String(value || 'DRAFT').toUpperCase();
  return ['DRAFT', 'QUEUED', 'APPROVED', 'EXECUTED', 'REJECTED', 'FAILED'].includes(normalized)
    ? normalized as ControlStatus : 'DRAFT';
}

export function parseControlSheet(workbook: WorkbookModel): ControlRow[] {
  const sheet = workbook.sheets.find(item => item.id === CONTROL_SHEET_ID || item.name === CONTROL_SHEET_NAME);
  if (!sheet) return [];
  return sheet.rows.map(row => {
    const value = rowObject(sheet, row);
    return {
      command_id: String(value.command_id ?? '').trim(),
      command: String(value.command ?? '').trim(),
      target: String(value.target ?? '').trim(),
      args_json: String(value.args_json ?? '{}').trim() || '{}',
      requested_by: String(value.requested_by ?? '').trim(),
      approved: value.approved === true || String(value.approved).toLowerCase() === 'true' || value.approved === 1,
      status: status(value.status),
      created_at: String(value.created_at ?? ''),
      executed_at: String(value.executed_at ?? ''),
      result_json: String(value.result_json ?? ''),
      error: String(value.error ?? ''),
    };
  }).filter(row => row.command_id || row.command);
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  command?: ValidatedControlCommand;
}

function integer(value: unknown, key: string, min: number, max: number, errors: string[]): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    errors.push(`${key} must be an integer in [${min},${max}]`);
  }
}

function validateArgs(name: ControlCommandName, args: Record<string, unknown>, errors: string[]): void {
  if (name === 'vm:step') integer(args.count, 'count', 1, 10_000, errors);
  if (name === 'vm:run') {
    integer(args.maxSteps, 'maxSteps', 1, 1_000_000, errors);
    integer(args.max_steps, 'max_steps', 1, 1_000_000, errors);
  }
  if (name === 'vm:call') {
    const fn = args.name ?? args.function;
    if (typeof fn !== 'string' || !SAFE_ID.test(fn)) errors.push('vm:call requires a safe string name/function');
    if (!Array.isArray(args.args)) errors.push('vm:call requires args as an array');
    else {
      if (args.args.length > 8) errors.push('vm:call supports at most 8 arguments');
      args.args.forEach((value, index) => integer(value, `args[${index}]`, 0, 255, errors));
    }
  }
  if (name === 'stream:replay') {
    integer(args.from_seq, 'from_seq', 0, Number.MAX_SAFE_INTEGER, errors);
    integer(args.to_seq, 'to_seq', 0, Number.MAX_SAFE_INTEGER, errors);
  }
  if (name === 'sheet:export') {
    const format = args.format ?? 'xlsx';
    if (!['xlsx', 'xml', 'csv'].includes(String(format))) errors.push('sheet:export format must be xlsx, xml, or csv');
    if (args.sheet !== undefined && typeof args.sheet !== 'string') errors.push('sheet must be a string');
  }
  if (name === 'wasm:apply_optimization') {
    if (typeof args.variant !== 'string' || !SAFE_ID.test(args.variant)) errors.push('wasm:apply_optimization requires a safe string variant');
    // Hard gate, not just an approval formality: a proposal the equivalence
    // judge did NOT certify 'equivalent' is refused regardless of the
    // Approved column — human sign-off is for the discretionary "do we want
    // this (proven-safe) change", not a way to override a failed proof.
    if (args.verdict !== 'equivalent') {
      errors.push(`wasm:apply_optimization refuses a proposal the equivalence judge did not certify (verdict: ${args.verdict ?? '(missing)'})`);
    }
  }
}

export function validateControlCommand(row: ControlRow, policy: ControlPolicy = {}): ValidationResult {
  const errors: string[] = [];
  const allowed = new Set(policy.allowed ?? CONTROL_COMMANDS);
  if (!row.command_id) errors.push('command_id is required');
  else if (!SAFE_ID.test(row.command_id)) errors.push('command_id contains unsafe characters or is too long');
  if (row.requested_by.length > 128) errors.push('requested_by is too long');
  if (!CONTROL_COMMANDS.includes(row.command as ControlCommandName)) errors.push(`unsupported command: ${row.command || '(blank)'}`);
  else if (!allowed.has(row.command as ControlCommandName)) errors.push(`command blocked by policy: ${row.command}`);
  if (row.command.startsWith('vm:')) {
    if (!row.target) errors.push('target is required for vm commands');
    else if (!SAFE_ID.test(row.target)) errors.push('target contains unsafe characters or is too long');
  }
  if (policy.allowedTargets?.length && row.target && !policy.allowedTargets.includes(row.target)) {
    errors.push(`target blocked by policy: ${row.target}`);
  }
  const maxArgsBytes = policy.maxArgsBytes ?? 65_536;
  if (new TextEncoder().encode(row.args_json || '').length > maxArgsBytes) errors.push(`args_json exceeds ${maxArgsBytes} bytes`);

  let args: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.args_json || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) errors.push('args_json must be a JSON object');
    else args = parsed as Record<string, unknown>;
  } catch { errors.push('args_json is not valid JSON'); }

  const name = row.command as ControlCommandName;
  if (CONTROL_COMMANDS.includes(name)) validateArgs(name, args, errors);
  if ((policy.requireApprovalForMutations ?? true) && MUTATING.has(name) && !row.approved) {
    errors.push(`approval required for mutating command: ${name}`);
  }
  return errors.length ? { valid: false, errors } : {
    valid: true,
    errors: [],
    command: { ...row, command: name, args },
  };
}

function event(type: string, row: ControlRow, extra: Record<string, unknown> = {}): EventLike {
  return {
    stream: 'phosphor-sheet-control', proto: 'phosphor-jsonl-v1', seq: 0,
    ts: new Date().toISOString(), type,
    command_id: row.command_id, command: row.command, target: row.target,
    requested_by: row.requested_by, approved: row.approved, ...extra,
  };
}

export interface ControlExecutionResult {
  workbook: WorkbookModel;
  events: EventLike[];
  processed: number;
  skipped: number;
}

export async function executeControlSheet(
  workbook: WorkbookModel,
  handlers: ControlHandlers,
  policy: ControlPolicy = {},
  emit?: ControlEmit,
  now: () => string = () => new Date().toISOString(),
): Promise<ControlExecutionResult> {
  const rows = parseControlSheet(workbook);
  // Seed with ids already at a terminal status anywhere in the sheet, not just
  // ones this run processes — otherwise a QUEUED/APPROVED row re-using a
  // previously EXECUTED/REJECTED/FAILED command_id would re-execute instead
  // of being rejected as a duplicate.
  const seen = new Set<string>(rows.filter(row => TERMINAL.has(row.status)).map(row => row.command_id));
  const events: EventLike[] = [];
  const output: ControlRow[] = [];
  let processed = 0;
  let skipped = 0;

  const push = (type: string, row: ControlRow, fields: Record<string, unknown> = {}) => {
    const item = { ...event(type, row, fields), ts: now(), seq: events.length + 1, mono: events.length + 1 };
    events.push(item);
    emit?.(type, Object.fromEntries(Object.entries(item).filter(([key]) => !['stream', 'proto', 'seq', 'ts', 'type', 'mono'].includes(key))));
  };

  for (const original of rows) {
    const row = { ...original };
    if (!row.command || TERMINAL.has(row.status) || !READY.has(row.status)) {
      skipped++;
      output.push(row);
      continue;
    }
    processed++;
    push('sheet:command_requested', row);

    if (seen.has(row.command_id)) {
      row.status = 'REJECTED'; row.error = 'duplicate command_id'; row.executed_at = now();
      push('sheet:command_rejected', row, { errors: [row.error] }); output.push(row); continue;
    }
    seen.add(row.command_id);

    const validation = validateControlCommand(row, policy);
    if (!validation.valid || !validation.command) {
      row.status = 'REJECTED'; row.error = validation.errors.join('; '); row.executed_at = now();
      push('sheet:command_rejected', row, { errors: validation.errors }); output.push(row); continue;
    }

    const handler = handlers[validation.command.command];
    if (!handler) {
      row.status = 'REJECTED'; row.error = `no host handler for ${row.command}`; row.executed_at = now();
      push('sheet:command_rejected', row, { errors: [row.error] }); output.push(row); continue;
    }

    try {
      const result = await handler(validation.command);
      row.status = 'EXECUTED'; row.error = ''; row.executed_at = now();
      row.result_json = JSON.stringify(result ?? null);
      push('sheet:command_executed', row, { result });
    } catch (error) {
      row.status = 'FAILED'; row.executed_at = now();
      row.error = error instanceof Error ? error.message : String(error);
      push('sheet:command_failed', row, { error: row.error });
    }
    output.push(row);
  }

  return { workbook: withControlSheet(workbook, output), events, processed, skipped };
}

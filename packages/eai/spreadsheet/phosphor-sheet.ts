/**
 * PHOSPHOR-SHEET — spreadsheet projection for Execution-as-Interface.
 *
 * A dependency-free, browser-safe projection from PHOSPHOR snapshots,
 * phosphor-jsonl-v1 events, CTS-like metadata, and semantic dictionaries into
 * a deterministic WorkbookModel. The model can be rendered in React, exported
 * as CSV, or serialized as Excel-readable SpreadsheetML without introducing an
 * XLSX dependency into the VM core.
 */

export const SHEET_PROTO = 'phosphor-sheet-v1' as const;

export type SheetCell = string | number | boolean | null;

export interface SheetColumn {
  key: string;
  label: string;
  kind?: 'string' | 'number' | 'boolean' | 'json' | 'timestamp';
  description?: string;
}

export interface SheetModel {
  id: string;
  name: string;
  description: string;
  columns: SheetColumn[];
  rows: SheetCell[][];
}

export interface WorkbookModel {
  proto: typeof SHEET_PROTO;
  generated_at: string;
  manifest: Record<string, SheetCell>;
  sheets: SheetModel[];
}

/** Structural subset of HeadlessSnapshot; avoids a reverse dependency on VM core. */
export interface SnapshotLike {
  mode?: string;
  arch?: string;
  vm_id?: string;
  tick?: number;
  vm_tick?: number;
  pc?: string;
  pc_symbol?: string | null;
  pc_comment?: string | null;
  instruction?: string;
  registers?: Record<string, number>;
  flags?: { Z?: boolean; N?: boolean; G?: boolean; z?: boolean; neg?: boolean; gt?: boolean };
  changed_this_tick?: ChangeLike[];
  changed?: ChangeLike[];
  halted?: boolean;
}

export interface ChangeLike {
  addr?: string;
  symbol?: string | null;
  before?: number;
  after?: number;
}

/** Structural subset of phosphor-jsonl-v1. */
export interface EventLike {
  stream?: string;
  proto?: string;
  seq?: number;
  ts?: string;
  type?: string;
  writer?: string;
  mono?: number;
  [field: string]: unknown;
}

export interface DictionaryEntryLike {
  description?: string;
  fields?: Record<string, string>;
}
export type DictionaryLike = Record<string, DictionaryEntryLike>;

export interface ControlRowLike {
  command_id?: string; command?: string; target?: string; args_json?: string;
  requested_by?: string; approved?: boolean; status?: string; created_at?: string;
  executed_at?: string; result_json?: string; error?: string;
}

export interface BuildWorkbookInput {
  snapshots?: SnapshotLike[];
  events?: EventLike[];
  dictionary?: DictionaryLike;
  cts?: unknown;
  manifest?: Record<string, SheetCell>;
  generatedAt?: string;
  controlRows?: ControlRowLike[];
}

const ENVELOPE = new Set(['stream', 'proto', 'seq', 'ts', 'type', 'writer', 'mono']);

function json(value: unknown): string {
  if (value === undefined) return '';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function sheet(
  id: string,
  name: string,
  description: string,
  columns: SheetColumn[],
  rows: SheetCell[][],
): SheetModel {
  return { id, name, description, columns, rows };
}

function eventTick(e: EventLike): number | null {
  const tick = e.vm_tick ?? e.tick;
  return typeof tick === 'number' ? tick : null;
}

function snapshotTick(s: SnapshotLike): number {
  return Number(s.tick ?? s.vm_tick ?? 0);
}

function flag(s: SnapshotLike, key: 'Z' | 'N' | 'G'): boolean {
  const f = s.flags ?? {};
  if (key === 'Z') return Boolean(f.Z ?? f.z);
  if (key === 'N') return Boolean(f.N ?? f.neg);
  return Boolean(f.G ?? f.gt);
}

export function snapshotsFromEvents(events: EventLike[]): SnapshotLike[] {
  const mapped = events
    .filter(e => e.type === 'vm:tick' || e.type === 'vm:halt')
    .map(e => ({
      mode: typeof e.mode === 'string' ? e.mode : 'ai',
      arch: typeof e.arch === 'string' ? e.arch : '',
      vm_id: typeof e.vm_id === 'string' ? e.vm_id : '',
      tick: eventTick(e) ?? 0,
      pc: typeof e.pc === 'string' ? e.pc : '',
      pc_symbol: typeof e.pc_symbol === 'string' ? e.pc_symbol : null,
      instruction: typeof e.instruction === 'string' ? e.instruction : '',
      registers: (e.registers && typeof e.registers === 'object')
        ? e.registers as Record<string, number> : {},
      flags: (e.flags && typeof e.flags === 'object')
        ? e.flags as SnapshotLike['flags'] : {},
      changed: Array.isArray(e.changed) ? e.changed as ChangeLike[] : [],
      halted: Boolean(e.halted || e.type === 'vm:halt'),
    }));
  // A halting tick emits both vm:tick and vm:halt for the same tick number
  // (see headless-driver.ts) — collapse the resulting adjacent duplicate so
  // the ledger/register/memory sheets don't double-count the final tick.
  return mapped.filter((snap, index) => index === 0 || snap.tick !== mapped[index - 1].tick);
}

export function orderEvents(events: EventLike[]): EventLike[] {
  return [...events].sort((a, b) => {
    const at = String(a.ts ?? ''), bt = String(b.ts ?? '');
    if (at !== bt) return at < bt ? -1 : 1;
    const aw = String(a.writer ?? ''), bw = String(b.writer ?? '');
    if (aw !== bw) return aw < bw ? -1 : 1;
    return Number(a.mono ?? a.seq ?? 0) - Number(b.mono ?? b.seq ?? 0);
  });
}

export function isAnomaly(e: EventLike): boolean {
  if (typeof e.type === 'string' && /:error$/.test(e.type)) return true;
  if (e.type === 'sheet:command_failed' || e.type === 'sheet:command_rejected') return true;
  if (e.ok === false) return true;
  if ('expected' in e && 'actual' in e && json(e.expected) !== json(e.actual)) return true;
  for (const key of ['code', 'exitCode', 'status']) {
    if (typeof e[key] === 'number' && e[key] !== 0) return true;
  }
  return false;
}

function inferDictionary(events: EventLike[], explicit?: DictionaryLike): DictionaryLike {
  if (explicit) return explicit;
  for (const e of events) {
    if (e.type === 'meta:dictionary' && e.dictionary && typeof e.dictionary === 'object') {
      return e.dictionary as DictionaryLike;
    }
  }
  return {};
}

function registerNames(snapshots: SnapshotLike[]): string[] {
  const set = new Set<string>();
  for (const s of snapshots) for (const key of Object.keys(s.registers ?? {})) set.add(key);
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function flattenCts(value: unknown, prefix = '', rows: SheetCell[][] = []): SheetCell[][] {
  if (value === null || value === undefined) {
    rows.push([prefix, 'null', '']);
    return rows;
  }
  if (value instanceof Map) {
    for (const [key, child] of value.entries()) flattenCts(child, `${prefix}[${String(key)}]`, rows);
    return rows;
  }
  if (value instanceof Set) {
    rows.push([prefix, 'set', json([...value])]);
    return rows;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => flattenCts(child, `${prefix}[${index}]`, rows));
    return rows;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) rows.push([prefix, 'object', '{}']);
    for (const [key, child] of entries) flattenCts(child, prefix ? `${prefix}.${key}` : key, rows);
    return rows;
  }
  rows.push([prefix, typeof value, String(value)]);
  return rows;
}

export function buildPhosphorWorkbook(input: BuildWorkbookInput): WorkbookModel {
  const events = orderEvents(input.events ?? []);
  const snapshots = input.snapshots?.length ? input.snapshots : snapshotsFromEvents(events);
  const dictionary = inferDictionary(events, input.dictionary);
  const registers = registerNames(snapshots);
  const anomalies = events.filter(isAnomaly);

  const manifest: Record<string, SheetCell> = {
    sheet_proto: SHEET_PROTO,
    eai_proto: String(input.manifest?.eai_proto ?? ''),
    stream_proto: String(input.manifest?.stream_proto ?? 'phosphor-jsonl-v1'),
    snapshot_count: snapshots.length,
    event_count: events.length,
    anomaly_count: anomalies.length,
    ...input.manifest,
  };

  const sheets: SheetModel[] = [];

  sheets.push(sheet(
    'manifest', '00_Manifest', 'Workbook identity, protocol versions, and projection counts.',
    [
      { key: 'key', label: 'Key', kind: 'string' },
      { key: 'value', label: 'Value', kind: 'string' },
    ],
    Object.entries(manifest).map(([key, value]) => [key, value]),
  ));

  sheets.push(sheet(
    'ticks', '01_Tick_Ledger', 'One row per VM tick from the canonical snapshot projection.',
    [
      { key: 'vm_id', label: 'VM ID' }, { key: 'arch', label: 'Architecture' },
      { key: 'mode', label: 'Mode' }, { key: 'tick', label: 'Tick', kind: 'number' },
      { key: 'pc', label: 'PC' }, { key: 'pc_symbol', label: 'PC Symbol' },
      { key: 'instruction', label: 'Instruction' },
      { key: 'Z', label: 'Z', kind: 'boolean' }, { key: 'N', label: 'N', kind: 'boolean' },
      { key: 'G', label: 'G', kind: 'boolean' }, { key: 'halted', label: 'Halted', kind: 'boolean' },
    ],
    snapshots.map(s => [
      s.vm_id ?? '', s.arch ?? '', s.mode ?? '', snapshotTick(s), s.pc ?? '',
      s.pc_symbol ?? '', s.instruction ?? '', flag(s, 'Z'), flag(s, 'N'), flag(s, 'G'),
      Boolean(s.halted),
    ]),
  ));

  sheets.push(sheet(
    'registers', '02_Registers', 'Register values aligned by tick.',
    [
      { key: 'vm_id', label: 'VM ID' }, { key: 'tick', label: 'Tick', kind: 'number' },
      ...registers.map(name => ({ key: name, label: name, kind: 'number' as const })),
    ],
    snapshots.map(s => [s.vm_id ?? '', snapshotTick(s), ...registers.map(r => s.registers?.[r] ?? null)]),
  ));

  const memoryRows: SheetCell[][] = [];
  for (const s of snapshots) {
    for (const c of (s.changed_this_tick ?? s.changed ?? [])) {
      const before = typeof c.before === 'number' ? c.before : null;
      const after = typeof c.after === 'number' ? c.after : null;
      memoryRows.push([
        s.vm_id ?? '', snapshotTick(s), c.addr ?? '', c.symbol ?? '', before, after,
        before !== null && after !== null ? after - before : null,
      ]);
    }
  }
  sheets.push(sheet(
    'memory', '03_Memory_Changes', 'Only cells that changed; before/after comes from the canonical snapshot builder.',
    [
      { key: 'vm_id', label: 'VM ID' }, { key: 'tick', label: 'Tick', kind: 'number' },
      { key: 'address', label: 'Address' }, { key: 'symbol', label: 'Symbol' },
      { key: 'before', label: 'Before', kind: 'number' }, { key: 'after', label: 'After', kind: 'number' },
      { key: 'delta', label: 'Delta', kind: 'number' },
    ], memoryRows,
  ));

  sheets.push(sheet(
    'events', '04_Event_Stream', 'Deterministically ordered phosphor-jsonl-v1 events.',
    [
      { key: 'stream', label: 'Stream' }, { key: 'proto', label: 'Proto' },
      { key: 'seq', label: 'Seq', kind: 'number' }, { key: 'ts', label: 'Timestamp', kind: 'timestamp' },
      { key: 'writer', label: 'Writer' }, { key: 'mono', label: 'Mono', kind: 'number' },
      { key: 'type', label: 'Type' }, { key: 'payload', label: 'Payload', kind: 'json' },
    ],
    events.map(e => {
      const payload = Object.fromEntries(Object.entries(e).filter(([key]) => !ENVELOPE.has(key)));
      return [e.stream ?? '', e.proto ?? '', Number(e.seq ?? 0), e.ts ?? '', e.writer ?? '',
        Number(e.mono ?? 0), e.type ?? '', json(payload)];
    }),
  ));

  const dictionaryRows: SheetCell[][] = [];
  for (const [type, spec] of Object.entries(dictionary)) {
    const fields = spec.fields ?? {};
    if (!Object.keys(fields).length) dictionaryRows.push([type, spec.description ?? '', '', '']);
    for (const [field, meaning] of Object.entries(fields)) {
      dictionaryRows.push([type, spec.description ?? '', field, meaning]);
    }
  }
  sheets.push(sheet(
    'dictionary', '05_Semantic_Dictionary', 'The stream vocabulary: event meaning and field semantics.',
    [
      { key: 'type', label: 'Event Type' }, { key: 'description', label: 'Description' },
      { key: 'field', label: 'Field' }, { key: 'meaning', label: 'Meaning' },
    ], dictionaryRows,
  ));

  sheets.push(sheet(
    'anomalies', '06_Anomalies', 'Events flagged by the same intent-vs-actual rules as phosphor-stream.',
    [
      { key: 'ts', label: 'Timestamp' }, { key: 'type', label: 'Type' },
      { key: 'reason', label: 'Reason' }, { key: 'expected', label: 'Expected', kind: 'json' },
      { key: 'actual', label: 'Actual', kind: 'json' }, { key: 'payload', label: 'Payload', kind: 'json' },
    ],
    anomalies.map(e => {
      const reason = typeof e.type === 'string' && /:error$/.test(e.type) ? 'error event'
        : e.ok === false ? 'ok=false'
        : ('expected' in e && 'actual' in e) ? 'expected != actual'
        : 'non-zero exit/status';
      return [e.ts ?? '', e.type ?? '', reason, json(e.expected), json(e.actual), json(e)];
    }),
  ));

  sheets.push(sheet(
    'intent', '07_Intent_Actual', 'Explicit checks where intended and observed values can be compared.',
    [
      { key: 'ts', label: 'Timestamp' }, { key: 'type', label: 'Check Type' },
      { key: 'tick', label: 'Tick', kind: 'number' }, { key: 'expected', label: 'Expected', kind: 'json' },
      { key: 'actual', label: 'Actual', kind: 'json' }, { key: 'ok', label: 'OK', kind: 'boolean' },
    ],
    events.filter(e => 'expected' in e || 'actual' in e || typeof e.ok === 'boolean')
      .map(e => [e.ts ?? '', e.type ?? '', eventTick(e), json(e.expected), json(e.actual), Boolean(e.ok)]),
  ));

  sheets.push(sheet(
    'cts', '08_CTS', 'Generic flattening of CTS-like maps/objects without imposing a new CTS schema.',
    [
      { key: 'path', label: 'Path' }, { key: 'kind', label: 'Kind' },
      { key: 'value', label: 'Value', kind: 'json' },
    ],
    input.cts === undefined ? [] : flattenCts(input.cts),
  ));

  const controlRows = input.controlRows?.length ? input.controlRows : [{
    command_id: 'cmd-001', command: '', target: '', args_json: '{}', requested_by: '',
    approved: false, status: 'DRAFT', created_at: '', executed_at: '', result_json: '', error: '',
  }];
  sheets.push(sheet(
    'control', '09_Control', 'Validated command intent. Mutating commands require approval and host-provided handlers.',
    [
      { key: 'command_id', label: 'Command ID' }, { key: 'command', label: 'Command' },
      { key: 'target', label: 'Target' }, { key: 'args_json', label: 'Args JSON', kind: 'json' },
      { key: 'requested_by', label: 'Requested By' }, { key: 'approved', label: 'Approved', kind: 'boolean' },
      { key: 'status', label: 'Status' }, { key: 'created_at', label: 'Created At', kind: 'timestamp' },
      { key: 'executed_at', label: 'Executed At', kind: 'timestamp' },
      { key: 'result_json', label: 'Result JSON', kind: 'json' }, { key: 'error', label: 'Error' },
    ],
    controlRows.map(row => [
      row.command_id ?? '', row.command ?? '', row.target ?? '', row.args_json ?? '{}',
      row.requested_by ?? '', Boolean(row.approved), row.status ?? 'DRAFT', row.created_at ?? '',
      row.executed_at ?? '', row.result_json ?? '', row.error ?? '',
    ]),
  ));

  return {
    proto: SHEET_PROTO,
    generated_at: input.generatedAt ?? new Date().toISOString(),
    manifest,
    sheets,
  };
}

function csvCell(value: SheetCell): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function sheetToCsv(model: SheetModel): string {
  const lines = [model.columns.map(c => csvCell(c.label)).join(',')];
  for (const row of model.rows) lines.push(row.map(csvCell).join(','));
  return '\uFEFF' + lines.join('\r\n') + '\r\n';
}

export function workbookToCsvMap(workbook: WorkbookModel): Record<string, string> {
  return Object.fromEntries(workbook.sheets.map(s => [`${s.name}.csv`, sheetToCsv(s)]));
}

function xmlEscape(value: SheetCell): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function xmlType(value: SheetCell): 'Number' | 'Boolean' | 'String' {
  if (typeof value === 'number' && Number.isFinite(value)) return 'Number';
  if (typeof value === 'boolean') return 'Boolean';
  return 'String';
}

/** Excel-readable SpreadsheetML 2003 document; no runtime dependency required. */
export function workbookToSpreadsheetML(workbook: WorkbookModel): string {
  const worksheets = workbook.sheets.map(model => {
    const header = `<Row>${model.columns.map(c => `<Cell ss:StyleID="Header"><Data ss:Type="String">${xmlEscape(c.label)}</Data></Cell>`).join('')}</Row>`;
    const rows = model.rows.map(row => `<Row>${row.map(value => {
      const type = xmlType(value);
      const data = type === 'Boolean' ? (value ? '1' : '0') : xmlEscape(value);
      return `<Cell><Data ss:Type="${type}">${data}</Data></Cell>`;
    }).join('')}</Row>`).join('');
    return `<Worksheet ss:Name="${xmlEscape(model.name.slice(0, 31))}"><Table>${header}${rows}</Table></Worksheet>`;
  }).join('');
  return `<?xml version="1.0"?>\n<?mso-application progid="Excel.Sheet"?>\n` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" ` +
    `xmlns:o="urn:schemas-microsoft-com:office:office" ` +
    `xmlns:x="urn:schemas-microsoft-com:office:excel" ` +
    `xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">` +
    `<DocumentProperties xmlns="urn:schemas-microsoft-com:office:office"><Title>PHOSPHOR-SHEET</Title>` +
    `<Created>${xmlEscape(workbook.generated_at)}</Created></DocumentProperties>` +
    `<Styles><Style ss:ID="Default" ss:Name="Normal"><Alignment ss:Vertical="Top" ss:WrapText="1"/>` +
    `</Style><Style ss:ID="Header"><Font ss:Bold="1" ss:Color="#FFFFFF"/>` +
    `<Interior ss:Color="#16324F" ss:Pattern="Solid"/></Style></Styles>${worksheets}</Workbook>`;
}

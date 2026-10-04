/**
 * Browser-safe asynchronous reader for the 09_Control worksheet in an XLSX.
 *
 * It supports ZIP method 0 (stored) and method 8 (deflate) through the native
 * DecompressionStream API. No spreadsheet dependency is introduced into VM Core.
 */

import type { SheetCell, SheetModel, WorkbookModel } from './phosphor-sheet.ts';
import {
  assertControlHeader, CONTROL_COLUMNS, CONTROL_SHEET_ID, CONTROL_SHEET_NAME, parseControlSheet,
  type ControlRow,
} from './phosphor-control.ts';

function u16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
function u32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Deflated XLSX requires DecompressionStream support in this browser.');
  }
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (u32(bytes, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Invalid XLSX: EOCD not found');
  const count = u16(bytes, eocd + 10);
  let offset = u32(bytes, eocd + 16);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();

  for (let i = 0; i < count; i++) {
    if (u32(bytes, offset) !== 0x02014b50) throw new Error('Invalid XLSX central directory');
    const method = u16(bytes, offset + 10);
    const compressedSize = u32(bytes, offset + 20);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const localOffset = u32(bytes, offset + 42);
    const name = decoder.decode(bytes.slice(offset + 46, offset + 46 + nameLength));

    if (u32(bytes, localOffset) !== 0x04034b50) throw new Error(`Invalid local header: ${name}`);
    const localNameLength = u16(bytes, localOffset + 26);
    const localExtraLength = u16(bytes, localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.slice(dataStart, dataStart + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = compressed;
    else if (method === 8) data = await inflateRaw(compressed);
    else throw new Error(`Unsupported ZIP method ${method} for ${name}`);
    files.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

function unxml(text: string): string {
  return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function attr(source: string, name: string): string {
  const match = new RegExp(`${name}="([^"]*)"`).exec(source);
  return match ? unxml(match[1]) : '';
}

function texts(source: string): string {
  return [...source.matchAll(/<(?:[A-Za-z_][\w.-]*:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?t>/g)]
    .map(match => unxml(match[1])).join('');
}

function sharedStrings(files: Map<string, Uint8Array>): string[] {
  const bytes = files.get('xl/sharedStrings.xml');
  if (!bytes) return [];
  const source = new TextDecoder().decode(bytes);
  return [...source.matchAll(/<(?:[A-Za-z_][\w.-]*:)?si>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?si>/g)]
    .map(match => texts(match[1]));
}

function worksheetPath(files: Map<string, Uint8Array>, name: string): string {
  const workbook = new TextDecoder().decode(files.get('xl/workbook.xml') ?? new Uint8Array());
  const sheetTag = [...workbook.matchAll(/<(?:[A-Za-z_][\w.-]*:)?sheet\s+([^>]*?)\/?>(?:<\/(?:[A-Za-z_][\w.-]*:)?sheet>)?/g)]
    .map(match => match[1]).find(tag => attr(tag, 'name') === name);
  if (!sheetTag) throw new Error(`Worksheet not found: ${name}`);
  const id = attr(sheetTag, 'r:id');
  const rels = new TextDecoder().decode(files.get('xl/_rels/workbook.xml.rels') ?? new Uint8Array());
  const relTag = [...rels.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Relationship\s+([^>]*?)\/?>(?:<\/(?:[A-Za-z_][\w.-]*:)?Relationship>)?/g)]
    .map(match => match[1]).find(tag => attr(tag, 'Id') === id);
  if (!relTag) throw new Error(`Worksheet relationship not found: ${name}`);
  const target = attr(relTag, 'Target').replace(/^\//, '');
  return target.startsWith('xl/') ? target : `xl/${target}`;
}

function colIndex(ref: string): number {
  const letters = (ref.match(/[A-Z]+/i)?.[0] ?? 'A').toUpperCase();
  let value = 0;
  for (const char of letters) value = value * 26 + char.charCodeAt(0) - 64;
  return value - 1;
}

function parseCell(tag: string, body: string, shared: string[]): SheetCell {
  const type = attr(tag, 't');
  if (type === 'inlineStr') return texts(body);
  const raw = /<(?:[A-Za-z_][\w.-]*:)?v>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?v>/.exec(body)?.[1] ?? '';
  if (type === 's') return shared[Number(raw)] ?? '';
  if (type === 'b') return raw === '1';
  if (type === 'str') return unxml(raw);
  if (raw === '') return '';
  const numeric = Number(raw);
  return Number.isFinite(numeric) ? numeric : unxml(raw);
}

function readSheet(files: Map<string, Uint8Array>, name: string): SheetCell[][] {
  const path = worksheetPath(files, name);
  const source = new TextDecoder().decode(files.get(path) ?? new Uint8Array());
  const shared = sharedStrings(files);
  const rows: SheetCell[][] = [];
  for (const rowMatch of source.matchAll(/<(?:[A-Za-z_][\w.-]*:)?row\s+[^>]*>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?row>/g)) {
    const row: SheetCell[] = [];
    for (const cellMatch of rowMatch[1].matchAll(/<(?:[A-Za-z_][\w.-]*:)?c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:[A-Za-z_][\w.-]*:)?c>)/g)) {
      const tag = cellMatch[1];
      row[colIndex(attr(tag, 'r'))] = parseCell(tag, cellMatch[2] ?? '', shared);
    }
    rows.push(row);
  }
  return rows;
}

export async function controlWorkbookFromXlsxBytes(bytes: Uint8Array): Promise<WorkbookModel> {
  const files = await unzip(bytes);
  const rows = readSheet(files, CONTROL_SHEET_NAME);
  const header = rows.shift() ?? [];
  assertControlHeader(header);
  const columns = header.map((label, index) => ({
    key: CONTROL_COLUMNS[index]?.key ?? String(label || `column_${index + 1}`),
    label: String(label || CONTROL_COLUMNS[index]?.label || ''),
  }));
  const sheet: SheetModel = {
    id: CONTROL_SHEET_ID,
    name: CONTROL_SHEET_NAME,
    description: 'Imported XLSX control commands.',
    columns,
    rows: rows.filter(row => row.some(value => value !== '' && value !== null && value !== undefined)),
  };
  return { proto: 'phosphor-sheet-v1', generated_at: '', manifest: {}, sheets: [sheet] };
}

export async function readControlCommandsFromXlsxBytes(bytes: Uint8Array): Promise<ControlRow[]> {
  return parseControlSheet(await controlWorkbookFromXlsxBytes(bytes));
}

export async function readControlCommandsFromXlsxFile(file: Blob): Promise<ControlRow[]> {
  return readControlCommandsFromXlsxBytes(new Uint8Array(await file.arrayBuffer()));
}

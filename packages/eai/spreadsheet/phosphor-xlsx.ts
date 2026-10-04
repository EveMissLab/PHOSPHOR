/**
 * PHOSPHOR-SHEET · dependency-free OOXML (.xlsx) writer.
 *
 * Browser-safe: builds a standards-compliant XLSX ZIP package using stored
 * entries (no compression). VM Core remains dependency-free; callers receive
 * Uint8Array bytes and decide whether to download, persist, or transmit them.
 */

import type { SheetCell, SheetModel, WorkbookModel } from './phosphor-sheet.ts';

const encoder = new TextEncoder();

function xml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((n, part) => n + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}

function u16(value: number): Uint8Array {
  return new Uint8Array([value & 0xff, (value >>> 8) & 0xff]);
}

function u32(value: number): Uint8Array {
  return new Uint8Array([
    value & 0xff,
    (value >>> 8) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 24) & 0xff,
  ]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

interface ZipEntry { name: string; data: Uint8Array; }

/** Minimal ZIP writer using method 0 (store). Excel accepts uncompressed OOXML. */
function zipStore(entries: ZipEntry[]): Uint8Array {
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(entry.data.length), u32(entry.data.length),
      u16(name.length), u16(0), name, entry.data,
    ]);
    localParts.push(local);

    centralParts.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0),
      u32(crc), u32(entry.data.length), u32(entry.data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length;
  }

  const central = concat(centralParts);
  const end = concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(central.length), u32(offset), u16(0),
  ]);
  return concat([...localParts, central, end]);
}

function columnName(index: number): string {
  let out = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  }
  return out;
}

function safeSheetName(value: string, used: Set<string>): string {
  const cleaned = value.replace(/[\\/?*\[\]:]/g, '_').slice(0, 31) || 'Sheet';
  let name = cleaned;
  let suffix = 1;
  while (used.has(name)) {
    const tail = `_${suffix++}`;
    name = cleaned.slice(0, 31 - tail.length) + tail;
  }
  used.add(name);
  return name;
}

function textCell(ref: string, value: string, style = 0): string {
  const preserve = /^\s|\s$|\n/.test(value) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t${preserve}>${xml(value)}</t></is></c>`;
}

function cellXml(ref: string, value: SheetCell, style = 0): string {
  if (value === null) return `<c r="${ref}"${style ? ` s="${style}"` : ''}/>`;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${style ? ` s="${style}"` : ''}><v>${value}</v></c>`;
  }
  if (typeof value === 'boolean') {
    return `<c r="${ref}" t="b"${style ? ` s="${style}"` : ''}><v>${value ? 1 : 0}</v></c>`;
  }
  return textCell(ref, String(value), style);
}

function estimatedWidth(model: SheetModel, column: number): number {
  let width = model.columns[column]?.label.length ?? 8;
  for (const row of model.rows.slice(0, 300)) {
    const value = row[column];
    if (value !== null && value !== undefined) width = Math.max(width, String(value).length);
  }
  return Math.max(8, Math.min(42, width + 2));
}


function controlValidations(model: SheetModel, maxRow: number): string {
  if (model.id !== 'control' && model.name !== '09_Control') return '';
  const commandList = '"vm:inspect,vm:run,vm:pause,vm:step,vm:reset,vm:call,stream:replay,sheet:export"';
  const statusList = '"DRAFT,QUEUED,APPROVED,EXECUTED,REJECTED,FAILED"';
  const end = Math.max(2, maxRow);
  return `<dataValidations count="3">` +
    `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="B2:B${end}"><formula1>${commandList}</formula1></dataValidation>` +
    `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="F2:F${end}"><formula1>"TRUE,FALSE"</formula1></dataValidation>` +
    `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="G2:G${end}"><formula1>${statusList}</formula1></dataValidation>` +
    `</dataValidations>`;
}

function sheetXml(model: SheetModel): string {
  const maxCol = Math.max(1, model.columns.length);
  const maxRow = Math.max(1, model.rows.length + 1);
  const dimension = `A1:${columnName(maxCol - 1)}${maxRow}`;
  const columns = model.columns.map((_, index) =>
    `<col min="${index + 1}" max="${index + 1}" width="${estimatedWidth(model, index)}" customWidth="1"/>`,
  ).join('');

  const header = `<row r="1" ht="22" customHeight="1">${model.columns.map((c, index) =>
    textCell(`${columnName(index)}1`, c.label, 1),
  ).join('')}</row>`;
  const rows = model.rows.map((row, rowIndex) => {
    const r = rowIndex + 2;
    return `<row r="${r}">${model.columns.map((_, colIndex) =>
      cellXml(`${columnName(colIndex)}${r}`, row[colIndex] ?? null),
    ).join('')}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<dimension ref="${dimension}"/>` +
    `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` +
    `<sheetFormatPr defaultRowHeight="15"/>` +
    `<cols>${columns}</cols><sheetData>${header}${rows}</sheetData>` +
    `<autoFilter ref="A1:${columnName(maxCol - 1)}${maxRow}"/>` +
    controlValidations(model, maxRow) +
    `</worksheet>`;
}

function stylesXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="2"><font><sz val="10"/><name val="Aptos"/></font>` +
    `<font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos"/></font></fonts>` +
    `<fills count="3"><fill><patternFill patternType="none"/></fill>` +
    `<fill><patternFill patternType="gray125"/></fill>` +
    `<fill><patternFill patternType="solid"><fgColor rgb="FF0F766E"/><bgColor indexed="64"/></patternFill></fill></fills>` +
    `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
    `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
    `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
    `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf></cellXfs>` +
    `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
    `</styleSheet>`;
}

/** Build a real OOXML .xlsx payload with no external package dependency. */
export function workbookToXlsxBytes(workbook: WorkbookModel): Uint8Array {
  const used = new Set<string>();
  const names = workbook.sheets.map(s => safeSheetName(s.name, used));
  const sheetOverrides = workbook.sheets.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');
  const sheets = names.map((name, i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('');
  const rels = names.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  ).join('') + `<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`;

  const files: Record<string, string> = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>${sheetOverrides}</Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${sheets}</sheets><calcPr calcId="0"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
    'xl/styles.xml': stylesXml(),
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>PHOSPHOR-SHEET</dc:title><dc:creator>EveMissLab</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${xml(workbook.generated_at)}</dcterms:created></cp:coreProperties>`,
    'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>PHOSPHOR</Application><TitlesOfParts><vt:vector size="${names.length}" baseType="lpstr">${names.map(name => `<vt:lpstr>${xml(name)}</vt:lpstr>`).join('')}</vt:vector></TitlesOfParts></Properties>`,
  };
  workbook.sheets.forEach((model, index) => { files[`xl/worksheets/sheet${index + 1}.xml`] = sheetXml(model); });
  return zipStore(Object.entries(files).map(([name, text]) => ({ name, data: encoder.encode(text) })));
}

export function workbookToXlsxBlob(workbook: WorkbookModel): Blob {
  return new Blob([workbookToXlsxBytes(workbook) as Uint8Array<ArrayBuffer>], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

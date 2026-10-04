# PHOSPHOR-SHEET

**Spreadsheet projection for Execution-as-Interface.**

PHOSPHOR currently exposes one execution state through two first-class surfaces:

- Human mode: the React CRT interface.
- AI mode: `phosphor-jsonl-v1`.

PHOSPHOR-SHEET adds a third deterministic projection:

```text
Φsheet : Snapshot × EventLedger × CTS → WorkbookModel
```

It does not rebuild VM state and it does not put spreadsheet logic inside the VM core. It consumes the canonical `HeadlessSnapshot` shape and the existing event envelope.

## Canonical workbook

| Sheet | Meaning |
|---|---|
| `00_Manifest` | protocol and run identity |
| `01_Tick_Ledger` | one row per VM tick |
| `02_Registers` | register values aligned by tick |
| `03_Memory_Changes` | address, symbol, before, after, delta |
| `04_Event_Stream` | deterministic `phosphor-jsonl-v1` ledger |
| `05_Semantic_Dictionary` | event vocabulary and field meanings |
| `06_Anomalies` | intent/actual and error signals |
| `07_Intent_Actual` | explicit checks |
| `08_CTS` | generic CTS flattening without schema replacement |
| `09_Control` | untrusted command intent, approval, execution result, and error ledger |

## Design boundaries

1. **Single source of truth.** Snapshot rows come from the same shape used by the headless driver and UI.
2. **Dependency-free core.** `WorkbookModel`, CSV, and SpreadsheetML work in Node and browsers.
3. **Untrusted control intent.** Spreadsheet commands remain inert until they enter a ready state, pass validation and approval policy, and are mapped to an explicit host handler.
4. **Structural compatibility.** The projector uses structural interfaces, so Veritaxa and other `phosphor-jsonl-v1` applications can reuse it.
5. **Excel is a projection, not the database.** Large artifacts remain outside the workbook and are referenced by path/hash in domain-specific extensions.

## API

```ts
import {
  buildPhosphorWorkbook,
  workbookToCsvMap,
  workbookToSpreadsheetML,
} from './spreadsheet/phosphor-sheet';

const workbook = buildPhosphorWorkbook({
  snapshots,
  events,
  dictionary,
  cts,
  manifest: { eai_proto: EAI_PROTO, program: 'fibonacci' },
});

const excelXml = workbookToSpreadsheetML(workbook); // opens in Excel
const csvFiles = workbookToCsvMap(workbook);         // one CSV per sheet
```

The dependency-free OOXML writer emits a true `.xlsx` without changing `WorkbookModel` or introducing a spreadsheet package into VM Core.

## v1.1 — real XLSX and validated control plane

PHOSPHOR-SHEET now exports a real OOXML `.xlsx` package through the browser-safe,
dependency-free `workbookToXlsxBytes()` function. It uses a minimal ZIP/OOXML
writer and does not add a spreadsheet package to VM Core.

The canonical workbook adds:

| Sheet | Meaning |
|---|---|
| `09_Control` | command intent, approval, execution status, result and error ledger |

A control row is not an instruction to the VM by itself. It is an untrusted
request that must pass:

1. command allowlist;
2. target and JSON argument validation;
3. approval for mutating VM commands;
4. a host-provided handler;
5. idempotent terminal-state checks.

The control processor emits `sheet:command_requested`,
`sheet:command_rejected`, `sheet:command_executed`, or
`sheet:command_failed` through the existing `phosphor-jsonl-v1` envelope.

Node hosts may import Excel-edited commands with
`readControlCommandsFromXlsx()`. The reader accepts both uncompressed OOXML
created by PHOSPHOR and deflated XLSX files saved by Excel.


## v1.2 — interactive round-trip control

PHOSPHOR-SHEET now completes the browser round trip:

```text
VM / event stream → WorkbookModel → XLSX
                             ↓ edit in Excel
Browser import ← validated 09_Control rows
        ↓
explicit host handlers → VM actions → phosphor-jsonl-v1 audit → rebuilt workbook
```

### Execution-state gate

Control status is now operational rather than decorative:

- `DRAFT` is inert and is never executed.
- `QUEUED` and `APPROVED` are eligible for processing.
- `EXECUTED`, `REJECTED`, and `FAILED` are terminal and idempotently skipped.
- Mutating VM commands still require `Approved = TRUE`.

### Command-specific validation

In addition to the command allowlist and JSON-object requirement, v1.2 validates:

- safe command and target identifiers;
- `vm:step.count` in `[1,10000]`;
- `vm:run.maxSteps` / `max_steps` in `[1,1000000]`;
- `vm:call` function name and up to eight byte arguments;
- replay sequence bounds;
- `sheet:export` formats (`xlsx`, `xml`, `csv`);
- maximum argument payload size and optional target allowlists.

### Browser XLSX import

`phosphor-control-xlsx.ts` reads `09_Control` directly in modern browsers. It accepts both stored OOXML produced by PHOSPHOR and deflated XLSX files re-saved by Excel by using the platform `DecompressionStream` API.

### Host capability boundary

`controlHandlersFromHost()` converts a narrow `SheetControlHost` interface into command handlers. The spreadsheet module still has no ambient VM authority: the UI or another host explicitly supplies `inspect`, `step`, `run`, `pause`, `reset`, `call`, replay, and export capabilities.

The React `SHEET` tab provides an editable control grid, XLSX import, command queuing, real VM execution through `VMController`, and audit events in the existing `phosphor-jsonl-v1` stream.

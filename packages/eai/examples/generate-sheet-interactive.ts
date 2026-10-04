import { writeFileSync } from 'node:fs';
import { buildPhosphorWorkbook } from '../spreadsheet/phosphor-sheet.ts';
import { workbookToXlsxBytes } from '../spreadsheet/phosphor-xlsx.ts';

const workbook = buildPhosphorWorkbook({
  generatedAt: '2026-07-14T00:00:00.000Z',
  manifest: {
    eai_proto: 'EML-EAI-2026-v0.5',
    stream_proto: 'phosphor-jsonl-v1',
    program: 'fibonacci',
    vm_id: 'sheet-vm',
    sample: 'PHOSPHOR-SHEET v1.2 interactive control',
  },
  events: [
    {
      stream: 'sample', proto: 'phosphor-jsonl-v1', seq: 1,
      ts: '2026-07-14T00:00:01.000Z', type: 'vm:tick', writer: 'sample', mono: 1,
      arch: 'EML-VM-16', mode: 'ai', vm_id: 'sheet-vm', vm_tick: 1,
      pc: '0x02', pc_symbol: null, instruction: 'MOVI R0, #0',
      registers: { R0: 0, R1: 0 }, flags: { Z: false, N: false, G: false },
      changed: [], halted: false,
    },
  ],
  controlRows: [
    {
      command_id: 'cmd-draft-note', command: 'vm:inspect', target: 'sheet-vm', args_json: '{}',
      requested_by: 'Neo.K', approved: false, status: 'DRAFT',
      created_at: '2026-07-14T00:00:02.000Z', executed_at: '', result_json: '', error: '',
    },
    {
      command_id: 'cmd-inspect', command: 'vm:inspect', target: 'sheet-vm', args_json: '{}',
      requested_by: 'Neo.K', approved: false, status: 'QUEUED',
      created_at: '2026-07-14T00:00:03.000Z', executed_at: '', result_json: '', error: '',
    },
    {
      command_id: 'cmd-step', command: 'vm:step', target: 'sheet-vm', args_json: '{"count":1}',
      requested_by: 'Neo.K', approved: true, status: 'APPROVED',
      created_at: '2026-07-14T00:00:04.000Z', executed_at: '', result_json: '', error: '',
    },
  ],
});

writeFileSync(process.argv[2] ?? 'PHOSPHOR-SHEET-v1.2-sample.xlsx', workbookToXlsxBytes(workbook));

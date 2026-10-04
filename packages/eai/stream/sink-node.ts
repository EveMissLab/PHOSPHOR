/**
 * phosphor-stream — Node.js sinks (file with rotation, stdout)
 * EveMissLab (一言諾科技有限公司) · 2026
 *
 * Node-only; keep these out of browser bundles. All sinks are best-effort:
 * a write failure is swallowed (optionally surfaced via onError) and must
 * never propagate into the host application.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Sink, PhosphorEvent } from './phosphor-stream';

export interface FileSinkOptions {
  /** Rotate once the active file would exceed this many bytes. Default 5 MiB. */
  maxBytes?: number;
  /** Keep this many rotated files (file.1 … file.N). Default 3. */
  maxFiles?: number;
  /** Surface swallowed write errors (default: noop). */
  onError?: (err: unknown) => void;
}

/**
 * Append-only JSONL file sink with size-based rotation.
 *
 * Rotation fixes the unbounded-growth flaw of the hand-rolled v1 monitor:
 * when the active file would exceed `maxBytes`, it is rolled to `<file>.1`
 * (and `.1`→`.2`, …, oldest dropped), then writing continues on a fresh file.
 */
export function fileSink(filePath: string, opts: FileSinkOptions = {}): Sink {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  const maxFiles = Math.max(1, opts.maxFiles ?? 3);
  const onError  = opts.onError ?? (() => { /* noop */ });

  // Seed the byte counter from any existing file so rotation survives restarts.
  let bytes = 0;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (fs.existsSync(filePath)) bytes = fs.statSync(filePath).size;
  } catch (err) { onError(err); }

  const rotate = (): void => {
    try {
      for (let i = maxFiles - 1; i >= 1; i--) {
        const from = `${filePath}.${i}`;
        const to   = `${filePath}.${i + 1}`;
        if (fs.existsSync(from)) {
          if (i + 1 > maxFiles) fs.rmSync(from, { force: true });
          else fs.renameSync(from, to);
        }
      }
      if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
      bytes = 0;
    } catch (err) { onError(err); }
  };

  return {
    write(event: PhosphorEvent) {
      try {
        const line = JSON.stringify(event) + '\n';
        const size = Buffer.byteLength(line);
        if (bytes > 0 && bytes + size > maxBytes) rotate();
        fs.appendFileSync(filePath, line);
        bytes += size;
      } catch (err) { onError(err); }
    },
  };
}

/** Write one JSON line per event to stdout. */
export function stdoutSink(): Sink {
  return {
    write(event: PhosphorEvent) {
      try { process.stdout.write(JSON.stringify(event) + '\n'); } catch { /* noop */ }
    },
  };
}

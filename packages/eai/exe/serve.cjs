'use strict';
/**
 * PHOSPHOR.exe launcher (Node SEA main).
 *
 * On launch: recover the embedded self-contained UI (single-file index.html),
 * write it to a temp file, open it in the default browser, and exit. No server,
 * no lingering window, no Node install required — the runtime is in the EXE.
 */
const sea  = require('node:sea');
const fs   = require('node:fs');
const os   = require('node:os');
const path = require('node:path');
const { exec } = require('node:child_process');

function loadHtml() {
  if (sea.isSea && sea.isSea()) {
    return sea.getAsset('index.html', 'utf8');
  }
  // Dev fallback when run as a plain script (node serve.cjs).
  return fs.readFileSync(path.join(__dirname, '..', 'ui', 'dist-single', 'index.html'), 'utf8');
}

try {
  const html = loadHtml();
  const out  = path.join(os.tmpdir(), 'phosphor-vm.html');
  fs.writeFileSync(out, html, 'utf8');
  process.stdout.write('PHOSPHOR · EML-VM-16\nopening ' + out + ' in your default browser\n');

  const cmd =
    process.platform === 'win32'  ? `start "" "${out}"` :
    process.platform === 'darwin' ? `open "${out}"`     :
                                    `xdg-open "${out}"`;
  exec(cmd, () => process.exit(0));
  // Safety net: exit even if the opener callback never fires.
  setTimeout(() => process.exit(0), 3000);
} catch (e) {
  process.stderr.write('PHOSPHOR launcher error: ' + (e && e.message) + '\n');
  setTimeout(() => process.exit(1), 100);
}

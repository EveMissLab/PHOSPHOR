/**
 * Build PHOSPHOR.exe — a self-contained Node SEA that embeds the single-file UI.
 *
 *   node exe/build-exe.mjs       (from PHOSPHOR/, or any cwd)
 *
 * Steps:
 *   1. Build the UI as one self-contained index.html (vite + singlefile)
 *   2. Generate the SEA blob (embeds serve.cjs + index.html asset)
 *   3. Copy the running node binary → PHOSPHOR.exe
 *   4. Inject the blob with postject
 */
import { execSync } from 'node:child_process';
import { copyFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ui  = path.join(__dirname, '..', 'ui');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const exe = path.join(__dirname, 'PHOSPHOR.exe');

const run = (cmd, cwd) => { console.log(`\n> ${cmd}`); execSync(cmd, { cwd, stdio: 'inherit' }); };

// 1. single-file UI build
run('npx vite build --config vite.config.exe.js', ui);
if (!existsSync(path.join(ui, 'dist-single', 'index.html'))) {
  throw new Error('single-file build missing: ui/dist-single/index.html');
}

// 2. SEA blob (asset paths in sea-config.json are resolved from this cwd)
run('node --experimental-sea-config sea-config.json', __dirname);

// 3. copy the node runtime
copyFileSync(process.execPath, exe);
console.log(`\ncopied node runtime → ${exe}`);

// 4. inject the blob
run(`npx --yes postject "${exe}" NODE_SEA_BLOB sea-prep.blob --sentinel-fuse ${FUSE}`, __dirname);

console.log(`\n✓ DONE → ${exe}`);
console.log('  double-click it (or run it) to open PHOSPHOR in your browser.');

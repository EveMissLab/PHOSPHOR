import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

// The live playground mounts the ACTUAL PHOSPHOR UI components + engine, aliased
// from the repo root (one source of truth — the site demos the shipped engine).
const phosphorRoot = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@phosphor': phosphorRoot },
    // The aliased PHOSPHOR UI lives under ../ui with its own node_modules; force a
    // single React instance so its hooks share this app's React (no "invalid hook").
    dedupe: ['react', 'react-dom'],
  },
  server: {
    port: 5190,
    // allow importing PHOSPHOR engine/UI sources that live above web/
    fs: { allow: ['..'] },
  },
});

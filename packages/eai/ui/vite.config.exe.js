import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// Single-file build for the EXE: inlines all JS/CSS into one self-contained
// index.html that runs from file:// with no server and no external requests.
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: { fs: { allow: ['..'] } },
  build: {
    outDir: 'dist-single',
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    chunkSizeWarningLimit: 100_000,
  },
});

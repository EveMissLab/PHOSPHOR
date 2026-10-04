import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI imports the verified core/visualization sources from the parent
// PHOSPHOR/ folder directly — no copies. `fs.allow: ['..']` lets Vite read them.
export default defineConfig({
  plugins: [react()],
  server: {
    fs: { allow: ['..'] },
  },
});

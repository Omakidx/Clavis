import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      // shared/ is outside this package: force its `zod` import to this package's copy (design §9).
      { find: /^zod$/, replacement: here('./node_modules/zod/index.js') },
      { find: '@shared', replacement: here('../shared') },
    ],
  },
  server: {
    port: 5173,
    // The API (and the Google OAuth redirect flow) is same-origin in production.
    proxy: {
      '/v1': 'http://localhost:8787',
      '/auth': 'http://localhost:8787',
    },
  },
  build: { outDir: 'dist', sourcemap: false, emptyOutDir: true },
});

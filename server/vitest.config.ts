import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // shared/ is outside this package: force its `zod` import to this package's copy.
    alias: [
      {
        find: /^zod$/,
        replacement: fileURLToPath(new URL('./node_modules/zod/index.js', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});

import { defineConfig } from '@playwright/test';

// E2E for the built extension (.output/chrome-mv3). The extension is loaded by the fixture in
// tests/e2e/fixtures.ts with a persistent context, so there is no browser project or webServer here.
// Build first: `npm run build`, then `npm run e2e:install` once, then `npm run test:e2e`.
export default defineConfig({
  testDir: 'tests/e2e',
  outputDir: 'test-results',
  // Persistent Chromium contexts are heavy and each test owns a fresh profile; keep CI deterministic.
  fullyParallel: false,
  ...(process.env.CI ? { workers: 1 } : {}),
  retries: process.env.CI ? 1 : 0,
  forbidOnly: Boolean(process.env.CI),
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: process.env.CI
    ? [['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
  },
});

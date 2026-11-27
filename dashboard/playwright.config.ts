import { defineConfig, devices } from '@playwright/test';
import { API_ORIGIN } from './e2e/support/stack';

// Dashboard e2e against the real API (which serves dashboard/dist) + fake Google + a throwaway database.
// Build first (`npm run build`), then `npm run e2e` (needs the dev Postgres and MinIO from
// server/docker-compose.dev.yml). Ports 8797/8798, so the extension e2e on 8787/8788 can run alongside.
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  globalSetup: './e2e/global-setup.ts',
  // One worker: sign-ins share one per-IP rate limit and one database.
  workers: 1,
  fullyParallel: false,
  retries: process.env['CI'] ? 1 : 0,
  forbidOnly: Boolean(process.env['CI']),
  timeout: 45_000,
  expect: { timeout: 7_000 },
  reporter: [['list']],
  use: {
    baseURL: API_ORIGIN,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
});

import { mkdirSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { fixturePath } from './p7-reader-support/helpers';
import { startProfile, type Profile } from './p11-support/profile';
import { buildExtension, leftoverDatabases, startStack, type Stack } from './p11-support/stack';

// Reader: the S-08 redesign, "Save to account" and opening a stored PDF on a second profile
// (docs/clavis-sync-design.md 6.6, 7.7). Same local stack as p11: the real API, Postgres, the fake
// Google and MinIO (S3) for the file bytes. Ports 8787/8788 must be free.

const ALICE = 'alice@example.test';
const PDF = 'text-100pages.pdf';
const SHOTS = 'test-results/p12-screens';
const S3_ENV = {
  S3_ENDPOINT: 'http://127.0.0.1:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'clavis-dev',
  S3_ACCESS_KEY_ID: 'clavis-dev',
  S3_SECRET_ACCESS_KEY: 'clavis-dev-only',
  S3_FORCE_PATH_STYLE: '1',
};

test.describe.configure({ mode: 'serial', timeout: 120_000 });

let stack: Stack;
let a: Profile;
let b: Profile;
const cleanups: (() => Promise<void>)[] = [];

const readerUrl = (p: Profile, query = ''): string =>
  `chrome-extension://${p.ext.extensionId}/reader.html${query}`;

async function signIn(p: Profile): Promise<void> {
  const options = await p.options();
  await options.getByTestId('account-sign-in').click();
  await expect(options.getByTestId('account-email')).toContainText(ALICE, { timeout: 30_000 });
  await options.close();
}

const apiRequests = (p: Profile): string[] =>
  p.evidence.api.filter((line) => line.includes('localhost:8787'));

async function shot(page: Page, name: string, theme: 'light' | 'dark'): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate((value) => {
    document.documentElement.dataset['previewTheme'] = value;
  }, theme);
  await page.screenshot({ path: `${SHOTS}/${name}-${theme}.png` });
  await page.evaluate(() => delete document.documentElement.dataset['previewTheme']);
}

test.beforeAll(async () => {
  test.setTimeout(240_000);
  Object.assign(process.env, S3_ENV);
  stack = await startStack();
  const built = await buildExtension(ALICE);
  cleanups.push(built.cleanup);
  a = await startProfile(built.dir);
  b = await startProfile(built.dir);
});

test.afterAll(async () => {
  test.setTimeout(120_000);
  await Promise.allSettled([a?.close(), b?.close()]);
  await Promise.allSettled(cleanups.map((f) => f()));
  await stack?.stop();
  expect(await leftoverDatabases()).toEqual([]);
});

test('1. signed out: the redesigned reader works and never contacts the API', async () => {
  const page = await a.ext.context.newPage();
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto(readerUrl(a));
  await expect(page.getByTestId('state-empty')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await shot(page, 'empty', 'light');
  await shot(page, 'empty', 'dark');

  await page.getByTestId('file-input').setInputFiles(fixturePath(PDF));
  await expect(page.locator('.reader[data-phase="ready"]')).toBeVisible();
  await expect(page.getByTestId('file-name')).toContainText(PDF);
  await expect(page.getByTestId('page-count')).toContainText('100');
  await expect(page.getByTestId('cloud-save')).toHaveCount(0);
  // The highlights panel can be hidden and shown again.
  const toggle = page.getByTestId('highlights-toggle');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await toggle.click();
  await expect(page.locator('#reader-sidebar')).toBeHidden();
  await toggle.click();
  await expect(page.locator('#reader-sidebar')).toBeVisible();
  await shot(page, 'document', 'light');
  await shot(page, 'document', 'dark');
  await page.setViewportSize({ width: 390, height: 780 });
  await shot(page, 'document-narrow', 'light');
  expect(apiRequests(a)).toEqual([]);
  await page.close();
});

test('2. signed in: Save to account stores the PDF and the page syncs', async () => {
  await signIn(a);
  const page = await a.ext.context.newPage();
  await page.setViewportSize({ width: 1200, height: 760 });
  await page.goto(readerUrl(a));
  await page.getByTestId('file-input').setInputFiles(fixturePath(PDF));
  await expect(page.locator('.reader[data-phase="ready"]')).toBeVisible();
  await page.getByTestId('page-input').fill('7');
  await page.getByTestId('page-input').press('Enter');
  await expect(page.getByTestId('page-input')).toHaveValue('7');
  // Progress is saved 2 s after the last change; closing the page flushes it too.
  await page.waitForTimeout(2500);
  await expect(page.getByTestId('cloud-save')).toBeVisible();
  await page.getByTestId('cloud-save').click();
  await expect(page.getByTestId('cloud-stored')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('cloud-status')).toHaveText('Saved to your account.');
  await shot(page, 'document-stored', 'light');
  await page.close();

  const rows = await stack.sql<{ storage_state: string }>(
    `SELECT d.storage_state FROM documents d JOIN users u ON u.id = d.user_id WHERE u.email = $1`,
    [ALICE],
  );
  expect(rows.map((r) => r.storage_state)).toEqual(['stored']);
  // The reading position reaches the server through the normal sync (kicked by the progress save).
  await expect
    .poll(
      async () =>
        (
          await stack.sql<{ last_page: number | null }>(
            `SELECT d.last_page FROM documents d JOIN users u ON u.id = d.user_id WHERE u.email = $1`,
            [ALICE],
          )
        ).map((r) => r.last_page),
      { timeout: 30_000 },
    )
    .toEqual([7]);
});

test('3. a second profile opens it from Continue reading and lands on the synced page', async () => {
  await signIn(b);
  const options = await b.options();
  await options.getByTestId('account-sync-now').click();
  await options.close();

  const page = await b.ext.context.newPage();
  await page.setViewportSize({ width: 1200, height: 760 });
  await expect(async () => {
    await page.goto(readerUrl(b));
    await expect(page.getByTestId('reader-continue-cloud')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 45_000 });
  await shot(page, 'empty-continue', 'light');
  await shot(page, 'empty-continue', 'dark');
  await page.getByTestId('reader-continue-cloud').click();
  await expect(page.locator('.reader[data-phase="ready"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('cloud-stored')).toBeVisible();
  await expect(page.getByTestId('page-input')).toHaveValue('7', { timeout: 15_000 });
  await page.close();
});

test('4. a ?doc= link with a bad fingerprint is ignored; an unknown one says so', async () => {
  const bad = await b.ext.context.newPage();
  await bad.goto(readerUrl(b, '?doc=not-a-fingerprint'));
  await expect(bad.getByTestId('state-empty')).toBeVisible();
  await bad.close();

  const missing = await b.ext.context.newPage();
  await missing.goto(readerUrl(b, `?doc=${'b'.repeat(64)}`));
  await expect(missing.getByTestId('state-cloud')).toHaveAttribute('data-kind', 'error', {
    timeout: 30_000,
  });
  await missing.close();
});

import { chromium, expect, test, type Browser, type Page } from '@playwright/test';
import { build } from 'esbuild';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';

// Security review LOW-4, in a REAL browser: text a reader cannot see must not flow into
// contextBefore/contextAfter. The unit tests mock layout; this bundles the production
// `lib/selection/context.ts` and runs it against genuinely hidden text (CSS, not mocks).
let server: FixtureServer;
let browser: Browser;
let bundle = '';

test.beforeAll(async () => {
  server = await startFixtureServer();
  browser = await chromium.launch({ channel: 'chromium' });
  const result = await build({
    entryPoints: ['lib/selection/context.ts'],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: '__context',
    platform: 'browser',
  });
  bundle = result.outputFiles[0]?.text ?? '';
});

test.afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function contextAround(page: Page, id: string): Promise<{ before: string; after: string }> {
  await page.addScriptTag({ content: bundle });
  return page.evaluate((targetId) => {
    const node = document.getElementById(targetId) as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(node);
    return (
      window as unknown as {
        __context: { extractContext(r: Range): { before: string; after: string } };
      }
    ).__context.extractContext(range);
  }, id);
}

test('hidden text never reaches the context, visible text does', async () => {
  const page = await browser.newPage();
  await page.goto(`${server.origin}/context-hiding.html`);
  const { before, after } = await contextAround(page, 'target');
  const all = `${before} | ${after}`;
  expect(all).not.toMatch(/S_[A-Z_]+/);
  expect(before).toBe('Visible before. KEEP_VISIBLE');
  expect(after).toBe('AFTER_START after visible.');
  await page.close();
});

test('every hiding technique is individually excluded (none leaks, none removes visible neighbours)', async () => {
  const page = await browser.newPage();
  await page.goto(`${server.origin}/context-hiding.html`);
  const names = await page.evaluate(() =>
    Array.from(document.querySelectorAll('#p span'))
      .map((el) => el.textContent?.trim() ?? '')
      .filter((text) => text.startsWith('S_')),
  );
  expect(names.length).toBeGreaterThanOrEqual(14);
  for (const name of names) {
    // Keep only this one hidden span: every technique must be caught on its own.
    await page.goto(`${server.origin}/context-hiding.html`);
    await page.evaluate((keep) => {
      for (const el of Array.from(document.querySelectorAll('#p span'))) {
        const text = el.textContent?.trim() ?? '';
        if (text.startsWith('S_') && text !== keep) el.remove();
      }
    }, name);
    const { before } = await contextAround(page, 'target');
    expect(before, `${name} must be excluded`).toBe('Visible before. KEEP_VISIBLE');
  }
  await page.close();
});

test('text merely scrolled out of view inside a scroll container is still visible text', async () => {
  const page = await browser.newPage();
  await page.goto(`${server.origin}/context-hiding.html`);
  const { before } = await contextAround(page, 'inside');
  expect(before).toBe('KEEP_SCROLLED_OUT');
  await page.close();
});

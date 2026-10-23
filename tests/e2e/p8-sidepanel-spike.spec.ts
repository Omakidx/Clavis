import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { launchExtension, type LaunchedExtension } from './spike-b-support/extension';
import { contentOrigin, moveAndClick, realUiEnabled } from './spike-b-support/native-ui';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';

// Phase 8 spike (FR-042): which hand-off patterns can open a per-tab side panel from the
// background when a trusted click happened in a content-script card (or an extension page)?
// Real Chromium, real mouse clicks (xdotool), a scratch extension (p8-sidepanel-support/spike-ext).
// Findings: docs/decisions/p8-sidepanel-spike.md
//
//   CLAVIS_E2E_REAL_UI=1 xvfb-run -a -s "-screen 0 1920x1080x24" \
//     npx playwright test tests/e2e/p8-sidepanel-spike.spec.ts --workers=1
test.skip(!realUiEnabled, 'opt-in: set CLAVIS_E2E_REAL_UI=1 and run under xvfb-run -a');

const SPIKE_DIR = fileURLToPath(new URL('./p8-sidepanel-support/spike-ext/', import.meta.url));

let server: FixtureServer;
let ext: LaunchedExtension;

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchExtension({ headed: true, buildDir: SPIKE_DIR });
});
test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

interface LogEntry {
  kind: string;
  variant?: string;
  ok?: boolean;
  err?: string;
  url?: string;
  hasTab?: boolean;
  frameId?: number;
  getCurrent?: unknown;
  origin?: string;
}
const readLog = async (): Promise<LogEntry[]> =>
  (await ext.serviceWorker.evaluate('globalThis.log')) as LogEntry[];

async function article(): Promise<Page> {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/article.html`);
  await page.bringToFront();
  await page.waitForTimeout(600);
  return page;
}

/** Click the spike button at index `i` (A..E) with the real mouse. */
async function realClick(page: Page, index: number): Promise<void> {
  const origin = await contentOrigin(page);
  moveAndClick(origin.x + 10 + 30 + index * 66, origin.y + 60 + 20);
}

async function tabIdOf(page: Page): Promise<number> {
  return (await ext.serviceWorker.evaluate(
    `chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === ${JSON.stringify(page.url())})?.id)`,
  )) as number;
}

async function panelContexts(): Promise<number> {
  return (await ext.serviceWorker.evaluate(
    `chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).then((c) => c.length)`,
  )) as number;
}

async function resultFor(variant: string, timeout = 8000): Promise<LogEntry> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = (await readLog()).find((e) => e.kind === 'result' && e.variant === variant);
    if (hit !== undefined) return hit;
    if (Date.now() > deadline) throw new Error(`no result for ${variant}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('A: setOptions (not awaited) + open in the same task, from a trusted click', async () => {
  const page = await article();
  const tabId = await tabIdOf(page);
  await realClick(page, 0);
  expect(await resultFor('A')).toMatchObject({ ok: true });
  await expect.poll(panelContexts).toBeGreaterThan(0);
  await expect
    .poll(async () =>
      (await readLog()).some(
        (e) => e.kind === 'panel-loaded' && e.url?.endsWith(`panel.html?tab=${tabId}`),
      ),
    )
    .toBe(true);
});

test('B: awaited setOptions, then open, from a trusted click', async () => {
  const page = await article();
  await realClick(page, 1);
  const result = await resultFor('B');
  console.log('B result', JSON.stringify(result));
  expect(typeof result.ok).toBe('boolean');
});

test('C: open only, after an earlier prepare (setOptions without a gesture)', async () => {
  const page = await article();
  await page.evaluate(() =>
    document.dispatchEvent(
      new CustomEvent('spike-send', { detail: JSON.stringify({ type: 'prepare' }) }),
    ),
  );
  await page.waitForTimeout(300);
  await realClick(page, 2);
  const result = await resultFor('C');
  console.log('C result', JSON.stringify(result));
  expect(result.ok).toBe(true);
});

test('D: open six seconds after the click (gesture expired)', async () => {
  const page = await article();
  await realClick(page, 3);
  const result = await resultFor('D', 15_000);
  console.log('D result', JSON.stringify(result));
  expect(typeof result.ok).toBe('boolean');
});

for (const [variant, type, delay] of [
  ['E', 'E-open-no-gesture', 1500],
  ['E', 'E-open-no-gesture', 7000],
  ['E2', 'E2-microtask-then-open', 7000],
  ['E3', 'E3-open-only-never-prepared', 7000],
] as const) {
  test(`${variant} (+${delay} ms): no click at all`, async () => {
    const before = (await readLog()).filter((e) => e.variant === variant).length;
    const page = await ext.context.newPage();
    await page.goto(`${server.origin}/article.html#auto=${type}@${delay}`);
    await page.bringToFront();
    const deadline = Date.now() + delay + 6000;
    let result: LogEntry | undefined;
    while (result === undefined && Date.now() < deadline) {
      result = (await readLog()).filter((e) => e.kind === 'result' && e.variant === variant)[
        before
      ];
      if (result === undefined) await new Promise((r) => setTimeout(r, 150));
    }
    console.log(variant, delay, JSON.stringify(result));
    expect(result).toBeDefined();
  });
}

test('F: an extension page opens its own tab panel straight from a click', async () => {
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${ext.extensionId}/page.html`);
  await page.bringToFront();
  await page.waitForTimeout(500);
  const origin = await contentOrigin(page);
  const box = (await page.locator('#f1').boundingBox())!;
  moveAndClick(origin.x + box.x + box.width / 2, origin.y + box.y + box.height / 2);
  await expect(page.locator('#out')).toContainText('F1', { timeout: 8000 });
  console.log('F1', await page.locator('#out').textContent());
  await expect
    .poll(async () => (await readLog()).filter((e) => e.kind === 'panel-loaded').length)
    .toBeGreaterThan(0);
  const loaded = (await readLog()).filter((e) => e.kind === 'panel-loaded').at(-1);
  console.log('panel sender shape', JSON.stringify(loaded));
});

test('G: a per-tab panel after the tab navigates, and in another tab', async () => {
  const page = await article();
  const tabId = await tabIdOf(page);
  await realClick(page, 0);
  expect(await resultFor('A')).toBeDefined();
  await expect.poll(panelContexts).toBeGreaterThan(0);
  const options = (id: number) =>
    ext.serviceWorker.evaluate(`chrome.sidePanel.getOptions({ tabId: ${id} })`);
  console.log('G options before nav', JSON.stringify(await options(tabId)));
  await page.goto(`${server.origin}/long.html`);
  await page.waitForTimeout(800);
  console.log('G options after nav', JSON.stringify(await options(tabId)));
  console.log('G panel contexts after nav', await panelContexts());
  const other = await ext.context.newPage();
  await other.goto(`${server.origin}/article.html?other=1`);
  await other.bringToFront();
  const otherId = await tabIdOf(other);
  await other.waitForTimeout(500);
  console.log('G other tab options', JSON.stringify(await options(otherId)));
  console.log('G panel contexts with other tab active', await panelContexts());
});

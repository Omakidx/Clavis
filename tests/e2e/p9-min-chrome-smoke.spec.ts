import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type BrowserContext } from '@playwright/test';
import { extensionPath } from './fixtures';
import { contentWorld } from './p3-support/content-world';
import { FAKE_KEY, openExtensionPage, send } from './p3-support/background';
import { CARD, cardOf, selectWord } from './p5-card-support/harness';
import { fakeGroq } from './p5-support/groq';
import { openFixtureReady } from './p7-reader-support/helpers';
import { waitForRegistration } from './spike-b-support/extension';
import { startFixtureServer } from './spike-b-support/server';
import { tb } from './spike-b-support/toolbar';
import { installLedger } from './p9-support/ledger';

// Phase 9 and the Phase 1 follow-up "add the minimum-Chrome smoke test against a pinned Chrome for
// Testing 147 build (D-14, D-18), including the content-script storage-denial check".
//
// The same spec runs on whatever browser `CLAVIS_CHROME_PATH` names (a Chrome for Testing 147
// binary in CI or on a release machine) and, when it is not set, on Playwright's own Chromium, so
// it is also a plain smoke test of the production build on that browser. It proves, on THAT
// browser: the web APIs the bundle needs exist (the D-18 floor: Math.sumPrecise, Promise.try,
// URL.parse, Uint8Array base64), the extension loads and its worker runs, the content script cannot
// read storage, a selection shows the toolbar and Explain costs one request, and the PDF reader
// opens a file. The detected major version is attached to the report.
//
//   CLAVIS_CHROME_PATH=/opt/chrome-147/chrome CLAVIS_EXTENSION_DIR=.output/chrome-mv3 \
//     npx playwright test tests/e2e/p9-min-chrome-smoke.spec.ts --output=test-results/p9-min-chrome
//
// (Chrome-branded builds 137+ ignore --load-extension; use Chrome for Testing or Chromium.)

const MIN_MAJOR = 147;

test.describe.configure({ timeout: 90_000 });

// Playwright requires an object-destructuring first parameter, even when it has no dependencies.
// eslint-disable-next-line no-empty-pattern
test('the production build works on the minimum supported browser: APIs, storage denial, toolbar, Explain, PDF reader', async ({}, testInfo) => {
  const root = await mkdtemp(path.join(tmpdir(), 'clavis-p9-min-'));
  const dir = path.join(root, 'ext');
  await cp(extensionPath, dir, { recursive: true });
  // Site access as granted (stand-in for the permission prompt), exactly like the other specs.
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    host_permissions?: string[];
    optional_host_permissions?: string[];
    minimum_chrome_version?: string;
  };
  manifest.host_permissions = [
    ...(manifest.host_permissions ?? []),
    ...(manifest.optional_host_permissions ?? []),
  ];
  delete manifest.optional_host_permissions;
  await writeFile(manifestPath, JSON.stringify(manifest));

  const server = await startFixtureServer();
  const executablePath = process.env['CLAVIS_CHROME_PATH'];
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      ...(executablePath === undefined ? { channel: 'chromium' as const } : { executablePath }),
      headless: process.env['CLAVIS_E2E_HEADED'] !== '1',
      args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
    });
    const serviceWorker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent('serviceworker', { timeout: 20_000 }));
    const extensionId = new URL(serviceWorker.url()).host;
    const groq = await fakeGroq(context);
    const ledger = await installLedger(context);
    await waitForRegistration(serviceWorker);

    // ---- which browser this is, and that it has what the bundle needs ------------------------------
    const version = context.browser()?.version() ?? '0';
    const major = Number(version.split('.')[0]);
    testInfo.annotations.push({
      type: 'browser',
      description: `${executablePath ?? 'playwright chromium'} ${version}`,
    });
    expect(
      major,
      `browser ${version} is older than the minimum ${MIN_MAJOR}`,
    ).toBeGreaterThanOrEqual(Number(manifest.minimum_chrome_version ?? MIN_MAJOR));
    const page0 = await context.newPage();
    await page0.goto(`${server.origin}/article.html`);
    const apis = await page0.evaluate(() => ({
      sumPrecise: typeof (Math as unknown as { sumPrecise?: unknown }).sumPrecise,
      promiseTry: typeof (Promise as unknown as { try?: unknown }).try,
      urlParse: typeof (URL as unknown as { parse?: unknown }).parse,
      base64: typeof (Uint8Array as unknown as { fromBase64?: unknown }).fromBase64,
    }));
    expect(apis).toEqual({
      sumPrecise: 'function',
      promiseTry: 'function',
      urlParse: 'function',
      base64: 'function',
    });
    await page0.close();

    // ---- key, then the content-script storage-denial check -----------------------------------------
    const options = await openExtensionPage(context, extensionId, 'options');
    await send(options, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
    await send(options, { v: 1, type: 'ACCEPT_DISCLOSURE' });
    groq.reset();

    const page = await context.newPage();
    const world = await contentWorld(page);
    await page.goto(`${server.origin}/article.html`);
    await world.ready();
    const access = await world.evaluate<string[]>(
      `Promise.all(['local', 'session'].map((area) => chrome.storage[area].get(null).then(() => 'readable', () => 'denied')))`,
    );
    expect(access).toEqual(['denied', 'denied']);

    // ---- toolbar and one Explain ----------------------------------------------------------------------
    const mark = ledger.mark();
    await selectWord(page, 'cartographer');
    expect(ledger.since(mark)).toEqual([]);
    await tb(page).click('explain');
    await cardOf(page).waitFor(CARD.ready('core'));
    expect(ledger.chats(mark)).toHaveLength(1);
    expect(groq.chats()[0]?.authorization).toBe(`Bearer ${FAKE_KEY}`);
    await world.dispose();

    // ---- the PDF reader (workers, wasm decoders under the extension CSP) --------------------------------
    const reader = await context.newPage();
    await reader.goto(`chrome-extension://${extensionId}/reader.html`);
    await openFixtureReady(reader, 'text-1page.pdf');
    expect(ledger.blocked).toEqual([]);
  } finally {
    await context?.close().catch(() => undefined);
    await server.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
      () => undefined,
    );
  }
});

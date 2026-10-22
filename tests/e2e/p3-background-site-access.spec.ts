import { expect, test, type Page } from '@playwright/test';
import {
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from './spike-b-support/extension';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { contentWorld } from './p3-support/content-world';
import { openExtensionPage, send } from './p3-support/background';

// Phase 3 site-access lifecycle in the built extension: preferences drive the registration
// (per-site exclusions, on-demand mode) and a newly registered observer reaches tabs that
// are already open. Chrome's permission prompt cannot be clicked from Playwright, so access
// stands in as granted via the manifest copy; everything downstream is the real code.

let ext: LaunchedExtension;
let server: FixtureServer;
let options: Page;

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchExtension({ grantedSiteAccess: true });
  await waitForRegistration(ext.serviceWorker);
  options = await openExtensionPage(ext.context, ext.extensionId, 'options');
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

const registered = () =>
  ext.serviceWorker.evaluate(() =>
    chrome.scripting
      .getRegisteredContentScripts()
      .then((scripts) =>
        scripts.map((s) => ({ id: s.id, excludeMatches: [...(s.excludeMatches ?? [])].sort() })),
      ),
  );

const update = (patch: object) => send(options, { v: 1, type: 'UPDATE_PREFERENCES', patch });

/** Whether the observer runs in the page's content-script world. */
async function observerRuns(page: Page, waitMs = 1_500): Promise<boolean> {
  const world = await contentWorld(page);
  try {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      try {
        const running = await world.evaluate<boolean>(
          `typeof globalThis[Symbol.for('clavis.observer')] !== 'undefined'`,
        );
        if (running) return true;
      } catch {
        // No isolated world yet: the content script has not started.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
  } finally {
    await world.dispose();
  }
}

test('the registration starts automatic with only the Web Store excluded', async () => {
  expect(await registered()).toEqual([
    {
      id: 'clavis-observer',
      excludeMatches: [
        'https://chrome.google.com/webstore/*',
        'https://chromewebstore.google.com/*',
      ],
    },
  ]);
  expect(await send(options, { v: 1, type: 'GET_SITE_ACCESS_STATUS' })).toEqual({
    ok: true,
    data: { granted: true, registered: true, choice: 'unset' },
  });
});

test('per-site disable rewrites excludeMatches and the observer skips that site (FR-009)', async () => {
  await update({ disabledSites: ['127.0.0.1'] });
  // Chrome returns the patterns sorted.
  expect((await registered())[0]?.excludeMatches).toEqual([
    '*://127.0.0.1/*',
    'https://chrome.google.com/webstore/*',
    'https://chromewebstore.google.com/*',
  ]);
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/article.html`);
  expect(await observerRuns(page)).toBe(false);
  // Another host is unaffected: localhost is a different hostname.
  const other = await ext.context.newPage();
  await other.goto(server.crossOrigin + '/article.html');
  expect(await observerRuns(other)).toBe(true);

  await update({ disabledSites: [] });
  expect((await registered())[0]?.excludeMatches).toHaveLength(2);
  await page.reload();
  expect(await observerRuns(page)).toBe(true);
  await page.close();
  await other.close();
});

test('on-demand mode keeps the observer unregistered; switching back registers it and reaches open tabs', async () => {
  await update({ tooltipBehavior: 'on-demand' });
  expect(await registered()).toEqual([]);
  expect(await send(options, { v: 1, type: 'GET_SITE_ACCESS_STATUS' })).toMatchObject({
    data: { granted: true, registered: false },
  });

  // A page opened in on-demand mode has no observer (right-click / popup / shortcut still work).
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/article.html`);
  expect(await observerRuns(page, 800)).toBe(false);

  // Back to automatic: registered again AND injected into this already-open tab (no reload).
  await update({ tooltipBehavior: 'automatic' });
  expect((await registered()).map((s) => s.id)).toEqual(['clavis-observer']);
  expect(await observerRuns(page, 5_000)).toBe(true);
  await page.close();
});

test('RESET_PREFERENCES re-applies the policy: automatic again, disabled sites kept', async () => {
  await update({ tooltipBehavior: 'on-demand', disabledSites: ['a.test'] });
  expect(await registered()).toEqual([]);
  await send(options, { v: 1, type: 'RESET_PREFERENCES' });
  const [script] = await registered();
  // Defaults are automatic; the disabled-sites list is kept (managed separately).
  expect(script?.excludeMatches).toContain('*://a.test/*');
  await update({ disabledSites: [] });
});

/** Per frame of the tab showing `url`: its own href and whether the observer runs in it. */
async function observersIn(url: string): Promise<{ href: string; observer: boolean }[]> {
  return ext.serviceWorker.evaluate(async (target) => {
    const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === target);
    if (tab?.id === undefined) throw new Error('tab not found');
    const frames = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => ({
        href: location.href,
        observer:
          (globalThis as Record<symbol, unknown>)[Symbol.for('clavis.observer')] !== undefined,
      }),
    });
    return frames.map((frame) => frame.result as { href: string; observer: boolean });
  }, url);
}

test('open-tab injection skips disabled sites in iframes and `host.` URLs (LOW-1)', async () => {
  const port = new URL(server.origin).port;
  await update({ tooltipBehavior: 'on-demand' });
  await update({ disabledSites: ['localhost'] });

  // A 127.0.0.1 page that embeds a localhost iframe (cross-origin), plus a trailing-dot host.
  const framedUrl = `${server.origin}/iframe.html`;
  const dottedUrl = `http://localhost.:${port}/article.html`;
  const framed = await ext.context.newPage();
  await framed.goto(framedUrl);
  const dotted = await ext.context.newPage();
  await dotted.goto(dottedUrl);

  // Automatic again: the observer is registered and pushed into the open tabs.
  await update({ tooltipBehavior: 'automatic' });
  await expect
    .poll(async () => (await observersIn(framedUrl)).find((f) => f.href === framedUrl)?.observer, {
      timeout: 8_000,
    })
    .toBe(true);
  // Give the dotted tab's injection time to happen if it were going to.
  await new Promise((resolve) => setTimeout(resolve, 500));

  const framedFrames = await observersIn(framedUrl);
  const disabledFrames = framedFrames.filter((f) => new URL(f.href).hostname === 'localhost');
  expect(disabledFrames.length, 'the localhost iframe is present').toBeGreaterThan(0);
  for (const frame of disabledFrames) expect(frame.observer, frame.href).toBe(false);
  // Subframes are never injected by the open-tab pass: they get the observer on their next load.
  for (const frame of framedFrames.filter((f) => f.href !== framedUrl)) {
    expect(frame.observer, frame.href).toBe(false);
  }

  const dottedFrames = await observersIn(dottedUrl);
  expect(dottedFrames.map((f) => f.observer)).toEqual([false]);

  await update({ disabledSites: [] });
  await framed.close();
  await dotted.close();
});

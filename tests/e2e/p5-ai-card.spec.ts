import { access, cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { EXPLAIN_CARD_SCRIPT_FILE } from '../../lib/config/constants';
import {
  defaultBuildDir,
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from './spike-b-support/extension';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { contentWorld, type ContentWorld } from './p3-support/content-world';
import { openExtensionPage, send, type Reply } from './p3-support/background';
import { frameWorld, type FrameWorld } from './p5-support/frame-world';

// Phase 5: LOAD_EXPLAIN_CARD and OPEN_SETTINGS in the BUILT extension. The card entrypoint belongs
// to another workstream, so a copy of the build gets a STAND-IN script at the configured card path
// that only leaves a counter in the isolated world: the test is about WHERE and HOW OFTEN the
// background injects, not about the card itself.

const MARKER = 'clavis.p5.card-stub';
// An IIFE, like a real bundle: a second injection into the same world must not redeclare globals.
const STUB = `(() => {
  const key = Symbol.for('${MARKER}');
  const state = globalThis[key] ?? { loads: 0 };
  state.loads += 1;
  state.href = location.href;
  globalThis[key] = state;
})();
`;

let ext: LaunchedExtension;
let server: FixtureServer;
let buildCopy: string;

test.beforeAll(async () => {
  server = await startFixtureServer();
  buildCopy = await mkdtemp(path.join(tmpdir(), 'clavis-p5-build-'));
  await cp(defaultBuildDir, buildCopy, { recursive: true });
  await writeFile(path.join(buildCopy, EXPLAIN_CARD_SCRIPT_FILE), STUB);
  ext = await launchExtension({ grantedSiteAccess: true, buildDir: buildCopy });
  await waitForRegistration(ext.serviceWorker);
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
  await rm(buildCopy, { recursive: true, force: true }).catch(() => undefined);
});

const load = { v: 1, type: 'LOAD_EXPLAIN_CARD' };
const call = (world: ContentWorld | FrameWorld, message: unknown): Promise<Reply | undefined> =>
  world.evaluate(`chrome.runtime.sendMessage(${JSON.stringify(message)})`);

/** How often the stand-in ran in each frame of the tab showing `url` (null = it never ran). */
async function cardLoads(url: string): Promise<{ href: string; loads: number | null }[]> {
  return ext.serviceWorker.evaluate(
    async ([target, marker]) => {
      const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === target);
      if (tab?.id === undefined) throw new Error('tab not found');
      const frames = await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: (m: string) => {
          const key = Symbol.for(m);
          const state = (globalThis as Record<symbol, { loads: number } | undefined>)[key];
          return { href: location.href, loads: state?.loads ?? null };
        },
        args: [marker as string],
      });
      return frames.map((f) => f.result as { href: string; loads: number | null });
    },
    [url, MARKER] as const,
  );
}

async function openFramesPage(): Promise<{ page: Page; url: string }> {
  const page = await ext.context.newPage();
  const url = `${server.origin}/iframe.html`;
  await page.goto(url);
  return { page, url };
}

test.describe('LOAD_EXPLAIN_CARD', () => {
  test('the configured card script path exists in the real build', async () => {
    expect(EXPLAIN_CARD_SCRIPT_FILE).toBe('content-scripts/explain-card.js');
    const real = await access(path.join(defaultBuildDir, EXPLAIN_CARD_SCRIPT_FILE)).then(
      () => true,
      () => false,
    );
    expect(real, `${EXPLAIN_CARD_SCRIPT_FILE} must be produced by the build`).toBe(true);
  });

  test('injects into exactly the sender document, and again whenever asked', async () => {
    const { page, url } = await openFramesPage();
    const main = await frameWorld(page, undefined);
    const inner = await frameWorld(
      page,
      (u) => u.endsWith('/iframe-inner.html') && u.startsWith(server.origin),
    );
    await main.ready();
    await inner.ready();

    // From the top frame: only the top frame gets the card.
    expect(await call(main, load)).toEqual({ ok: true, data: { loaded: true } });
    let frames = await cardLoads(url);
    expect(frames.find((f) => f.href === url)?.loads).toBe(1);
    expect(frames.filter((f) => f.href !== url).map((f) => f.loads)).toEqual([null, null, null]);

    // The background remembers nothing: asking again injects again (the real card script guards
    // itself with its own global, and the loader only asks when that global is missing).
    for (let i = 0; i < 3; i++) expect(await call(main, load)).toMatchObject({ ok: true });
    frames = await cardLoads(url);
    expect(frames.find((f) => f.href === url)?.loads).toBe(4);

    // A card the page tore down comes back on the next request (nothing is skipped as "loaded").
    await main.evaluate(`delete globalThis[Symbol.for('${MARKER}')]`);
    expect((await cardLoads(url)).find((f) => f.href === url)?.loads).toBeNull();
    expect(await call(main, load)).toMatchObject({ ok: true });
    expect((await cardLoads(url)).find((f) => f.href === url)?.loads).toBe(1);

    // From the same-origin iframe: only that iframe is added.
    expect(await call(inner, load)).toEqual({ ok: true, data: { loaded: true } });
    frames = await cardLoads(url);
    expect(frames.find((f) => f.href === url)?.loads).toBe(1);
    expect(
      frames.find((f) => f.href.endsWith('/iframe-inner.html') && f.href.startsWith(server.origin))
        ?.loads,
    ).toBe(1);
    // The cross-origin iframe and the srcdoc frame were never targeted.
    expect(
      frames
        .filter((f) => !f.href.startsWith(server.origin) && f.href !== url)
        .every((f) => f.loads === null),
    ).toBe(true);

    await main.dispose();
    await inner.dispose();
    await page.close();
  });

  test('a new document of the same tab is injected again', async () => {
    const { page, url } = await openFramesPage();
    const main = await frameWorld(page, undefined);
    await main.ready();
    expect(await call(main, load)).toMatchObject({ ok: true });
    await page.reload();
    await main.ready();
    expect(await call(main, load)).toMatchObject({ ok: true });
    expect((await cardLoads(url)).find((f) => f.href === url)?.loads).toBe(1);
    await main.dispose();
    await page.close();
  });

  test('the target cannot be chosen by the message, and extension pages are refused', async () => {
    const { page, url } = await openFramesPage();
    const main = await frameWorld(page, undefined);
    await main.ready();
    for (const extra of [{ tabId: 1 }, { frameId: 0 }, { allFrames: true }, { files: ['x.js'] }]) {
      expect(await call(main, { ...load, ...extra })).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
    }
    for (const name of ['practice', 'reader', 'options']) {
      const extensionPage = await openExtensionPage(ext.context, ext.extensionId, name);
      expect(await send(extensionPage, load)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_REQUEST' },
      });
      await extensionPage.close();
    }
    expect((await cardLoads(url)).every((f) => f.loads === null)).toBe(true);
    await main.dispose();
    await page.close();
  });

  test('the page itself cannot ask (no message channel from the main world)', async () => {
    const { page } = await openFramesPage();
    expect(
      await page.evaluate(
        () =>
          typeof (globalThis as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome
            ?.runtime?.sendMessage,
      ),
    ).toBe('undefined');
    await page.close();
  });
});

test.describe('OPEN_SETTINGS', () => {
  test('a content script opens Settings, at a section, and cannot spam tabs', async () => {
    const page = await ext.context.newPage();
    const world = await contentWorld(page);
    await page.goto(`${server.origin}/article.html`);
    await world.ready();
    const optionsPrefix = `chrome-extension://${ext.extensionId}/options.html`;

    const opened = ext.context.waitForEvent('page', { timeout: 5_000 });
    expect(
      await world.evaluate(
        `chrome.runtime.sendMessage({ v: 1, type: 'OPEN_SETTINGS', section: 'privacy' })`,
      ),
    ).toEqual({ ok: true, data: { opened: true } });
    const settings = await opened;
    await settings.waitForLoadState();
    expect(settings.url()).toBe(`${optionsPrefix}#section-privacy`);

    // A second call right away is limited and opens nothing.
    const before = ext.context.pages().length;
    expect(
      await world.evaluate(
        `chrome.runtime.sendMessage({ v: 1, type: 'OPEN_SETTINGS', section: 'key' })`,
      ),
    ).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED' } });
    expect(ext.context.pages()).toHaveLength(before);

    // A bad section is a shape error and opens nothing either.
    expect(
      await world.evaluate(
        `chrome.runtime.sendMessage({ v: 1, type: 'OPEN_SETTINGS', section: '../popup.html' })`,
      ),
    ).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
    expect(ext.context.pages()).toHaveLength(before);

    await settings.close();
    await world.dispose();
    await page.close();
  });

  test('without a section it opens the options page; the practice page may ask, the options page may not', async () => {
    const practice = await openExtensionPage(ext.context, ext.extensionId, 'practice');
    const opened = ext.context.waitForEvent('page', { timeout: 5_000 });
    expect(await send(practice, { v: 1, type: 'OPEN_SETTINGS' })).toEqual({
      ok: true,
      data: { opened: true },
    });
    const settings = await opened;
    await settings.waitForLoadState();
    expect(settings.url()).toMatch(
      new RegExp(`^chrome-extension://${ext.extensionId}/options\\.html`),
    );

    expect(await send(settings, { v: 1, type: 'OPEN_SETTINGS' })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    await settings.close();
    await practice.close();
  });
});

import { expect, test } from '@playwright/test';
import type { LaunchedExtension } from './spike-b-support/extension';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { SEL, tb } from './spike-b-support/toolbar';
import { launchWithHostAccess } from './p3-support/launch';

// Phase 4: right-click "Explain with Clavis" inside a CROSS-ORIGIN iframe when only the page's
// own origin is accessible (the activeTab situation). Chrome refuses the frame, so the
// background falls back to the top frame and shows a notice instead of failing silently.
//
// iframe.html (127.0.0.1) embeds a localhost iframe. The manifest copy grants 127.0.0.1 only,
// like activeTab would. The context-menu click is delivered by dispatching the real
// `contextMenus.onClicked` event inside the service worker, so the real listener runs.

let ext: LaunchedExtension;
let server: FixtureServer;

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchWithHostAccess('http://127.0.0.1/*');
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

/** Probe frame ids: the one Chrome refuses with a permission error is the cross-origin frame. */
function findRefusedFrame(tabUrl: string): Promise<{ tabId: number; frameId: number }> {
  return ext.serviceWorker.evaluate(async (url) => {
    const [tab] = (await chrome.tabs.query({})).filter((t) => t.url === url);
    if (tab?.id === undefined) throw new Error('tab not found');
    for (let frameId = 1; frameId <= 12; frameId++) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id, frameIds: [frameId] },
          func: () => 1,
        });
      } catch (error) {
        if (/Cannot access|must request permission/i.test(String((error as Error).message))) {
          return { tabId: tab.id, frameId };
        }
      }
    }
    throw new Error('no cross-origin frame found');
  }, tabUrl);
}

test('a right-click in a cross-origin iframe shows a notice in the top frame', async () => {
  const url = `${server.origin}/iframe.html`;
  const page = await ext.context.newPage();
  await page.goto(url);
  const { tabId, frameId } = await findRefusedFrame(url);

  // Nothing is registered or injected before the click: the declined path.
  expect(await tb(page).hostCount()).toBe(0);

  await ext.serviceWorker.evaluate(
    ({ tabId: id, frameId: frame, pageUrl }) => {
      const onClicked = chrome.contextMenus.onClicked as unknown as {
        dispatch(info: object, tab: object): void;
      };
      onClicked.dispatch(
        { menuItemId: 'clavis-explain', frameId: frame, pageUrl, selectionText: 'x' },
        { id, url: pageUrl },
      );
    },
    { tabId, frameId, pageUrl: url },
  );

  await tb(page).waitShown(SEL.notice);
  expect(await tb(page).text(SEL.notice)).toContain("can't read text inside this embedded frame");
  await page.close();
});

test('a right-click in the top frame does not show the notice (the grant covers it)', async () => {
  const url = `${server.origin}/article.html`;
  const page = await ext.context.newPage();
  await page.goto(url);
  const tabId = await ext.serviceWorker.evaluate(
    async (target) => (await chrome.tabs.query({})).find((t) => t.url === target)?.id,
    url,
  );
  await ext.serviceWorker.evaluate(
    ({ id, pageUrl }) => {
      const onClicked = chrome.contextMenus.onClicked as unknown as {
        dispatch(info: object, tab: object): void;
      };
      onClicked.dispatch(
        { menuItemId: 'clavis-explain', frameId: 0, pageUrl },
        { id, url: pageUrl },
      );
    },
    { id: tabId, pageUrl: url },
  );
  // The observer is injected (no selection, so no toolbar) and no notice appears.
  await new Promise((resolve) => setTimeout(resolve, 800));
  expect(await tb(page).hostCount()).toBe(0);
  await page.close();
});

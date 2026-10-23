import { expect, test, type Page } from '@playwright/test';
import { FAKE_KEY, openExtensionPage, send } from './p3-support/background';
import { launchWithHostAccess } from './p3-support/launch';
import { CARD, cardOf } from './p5-card-support/harness';
import { fakeGroq, type FakeGroq } from './p5-support/groq';
import { tabIdOf } from './p8-sidepanel-support/panel';
import { type LaunchedExtension } from './spike-b-support/extension';
import { dblclickText } from './spike-b-support/page';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { tb } from './spike-b-support/toolbar';
import { cardText, pause } from './p9-support/card';
import { installLedger, type Ledger } from './p9-support/ledger';

// Phase 9, "E2E tests for the declined-access path: context menu -> Explain -> card" (FR-018,
// UJ-02b, D-02 step 6, requirements section 9 "Site access" row). The user declined all-sites
// access, so nothing is registered and no toolbar appears by itself. The right-click item and the
// popup's "Explain on this page" inject the observer into THAT tab only and start Explain for the
// selection that is already there: the card opens (after the first-send question when it was never
// answered), costing exactly one request.
//
// Headless Chromium cannot grant `activeTab` or click the native context menu. The stand-ins are
// the ones the earlier phases use and agreed on: a manifest copy that grants host access to the
// fixture origin only (what `activeTab` grants: the page's own origin, nothing registered, nothing
// optional granted), and the REAL `contextMenus.onClicked` listener driven by dispatching the
// event inside the service worker. The real native menu, icon and shortcut run in
// p8-accept-realui.spec.ts (journey 2) and p4-matrix-realui.spec.ts under xvfb.

test.describe.configure({ mode: 'serial', timeout: 60_000 });

let ext: LaunchedExtension;
let server: FixtureServer;
let groq: FakeGroq;
let ledger: Ledger;
let options: Page;

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchWithHostAccess('http://127.0.0.1/*');
  groq = await fakeGroq(ext.context);
  ledger = await installLedger(ext.context);
  options = await openExtensionPage(ext.context, ext.extensionId, 'options');
  await send(options, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
  await send(options, { v: 1, type: 'ACCEPT_DISCLOSURE' });
  groq.reset();
});
test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

/** The context menu's "Explain with Clavis" clicked on `tab`: the real listener runs in the worker. */
async function clickContextMenu(page: Page, selectionText?: string): Promise<void> {
  const tabId = await tabIdOf(ext.serviceWorker, page);
  const url = page.url();
  await ext.serviceWorker.evaluate(
    ({ id, pageUrl, text }) => {
      const onClicked = chrome.contextMenus.onClicked as unknown as {
        dispatch(info: object, tab: object): void;
      };
      onClicked.dispatch(
        {
          menuItemId: 'clavis-explain',
          frameId: 0,
          pageUrl,
          ...(text === undefined ? {} : { selectionText: text }),
        },
        { id, url: pageUrl },
      );
    },
    { id: tabId, pageUrl: url, text: selectionText },
  );
}

async function popupExplain(page: Page): Promise<unknown> {
  const tabId = await tabIdOf(ext.serviceWorker, page);
  const popup = await ext.context.newPage();
  await popup.goto(`chrome-extension://${ext.extensionId}/popup.html`);
  const reply = await send(popup, { v: 1, type: 'CLAVIS_INJECT_TAB', tabId, url: page.url() });
  await popup.close();
  return reply;
}

const registered = (): Promise<string[]> =>
  ext.serviceWorker.evaluate(
    `chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id))`,
  ) as Promise<string[]>;

test('declined: nothing is registered, no site access is granted, and a selection shows no toolbar by itself', async () => {
  expect(await registered()).toEqual([]);
  const granted = await ext.serviceWorker.evaluate(
    `chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })`,
  );
  expect(granted).toBe(false);
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/article.html`);
  const mark = ledger.mark();
  await dblclickText(page, page, 'cartographer');
  await pause(700);
  expect(await tb(page).hostCount()).toBe(0);
  expect(ledger.since(mark)).toEqual([]);
  await page.close();
});

test('context menu -> Explain: the card opens for the CURRENT selection with one request, in that tab only', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/article.html`);
  const other = await ext.context.newPage();
  await other.goto(`${server.origin}/long.html`);
  await page.bringToFront();
  await dblclickText(page, page, 'cartographer');
  await pause(500);
  expect(await tb(page).hostCount()).toBe(0);
  const mark = ledger.mark();
  groq.reset();

  await clickContextMenu(page, 'cartographer');
  const card = cardOf(page);
  await card.waitFor(CARD.ready('core'));

  // The card shows the selection the user had, the toolbar is there, and ONE paid request left.
  expect(await card.text(CARD.text)).toBe('cartographer');
  expect(await tb(page).isShown()).toBe(true);
  expect(ledger.chats(mark)).toHaveLength(1);
  expect(groq.chats()[0]?.body?.messages[1]?.content).toContain('(mode: core)');
  expect(groq.chats()[0]?.body?.messages[1]?.content).toContain('cartographer');
  expect(groq.chats()[0]?.authorization).toBe(`Bearer ${FAKE_KEY}`);
  // Nothing else was asked of Groq, nothing went anywhere else.
  expect(ledger.since(mark).filter((e) => e.host !== '127.0.0.1')).toHaveLength(1);
  expect(ledger.blocked).toEqual([]);

  // Still nothing registered, and the other tab got neither a script nor a toolbar.
  expect(await registered()).toEqual([]);
  expect(await tb(other).hostCount()).toBe(0);
  await other.close();

  // The card is the usual one: a lazy tab costs one request, Escape dismisses it.
  await card.click(CARD.tab('etymology'));
  await card.waitFor(CARD.ready('etymology'));
  expect(ledger.chats(mark)).toHaveLength(2);
  await page.keyboard.press('Escape');
  await tb(page).waitHidden();
  await page.close();
});

test('the injection lives with the document: a reload brings no automatic toolbar back, and the next right-click works again', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/article.html`);
  await dblclickText(page, page, 'cartographer');
  await clickContextMenu(page, 'cartographer');
  await cardOf(page).waitFor(CARD.ready('core'));

  await page.reload();
  await dblclickText(page, page, 'river');
  await pause(600);
  expect(await tb(page).hostCount()).toBe(0);

  const mark = ledger.mark();
  await clickContextMenu(page, 'river');
  const card = cardOf(page);
  await card.waitFor(CARD.ready('core'));
  expect(await card.text(CARD.text)).toBe('river');
  expect(ledger.chats(mark)).toHaveLength(1);
  await page.close();
});

test('popup "Explain on this page" -> the same card; with no selection nothing is shown and nothing is sent', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/article.html`);
  const mark = ledger.mark();

  expect(await popupExplain(page)).toMatchObject({ ok: true, shown: false });
  await pause(500);
  expect(ledger.since(mark).filter((e) => e.host === 'api.groq.com')).toEqual([]);

  await dblclickText(page, page, 'cartographer');
  expect(await popupExplain(page)).toMatchObject({ ok: true, shown: true });
  const card = cardOf(page);
  await card.waitFor(CARD.ready('core'));
  expect(await card.text(CARD.text)).toBe('cartographer');
  expect(ledger.chats(mark)).toHaveLength(1);
  await page.close();
});

test('right-click with no selection shows nothing and sends nothing', async () => {
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/article.html`);
  const mark = ledger.mark();
  await clickContextMenu(page);
  await pause(800);
  expect(await tb(page).hostCount()).toBe(0);
  expect(ledger.chats(mark)).toHaveLength(0);
  await page.close();
});

test('first use after skipped setup: the right-click path asks the approved question, sends nothing, and never answers it for the user', async () => {
  await send(options, { v: 1, type: 'CLEAR_ALL_DATA' });
  await send(options, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
  groq.reset();
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/article.html`);
  await dblclickText(page, page, 'cartographer');
  const mark = ledger.mark();
  await clickContextMenu(page, 'cartographer');
  const card = cardOf(page);
  await card.waitFor(CARD.disclosure);
  await pause(800);
  expect(ledger.chats(mark)).toHaveLength(0);
  const settings = await send(options, { v: 1, type: 'GET_SETTINGS' });
  expect(settings?.data?.onboarding?.['disclosureAcceptedAt']).toBeNull();
  // Cancel sends nothing and the question stays open for next time.
  await card.click(CARD.cancel);
  await pause(500);
  expect(ledger.chats(mark)).toHaveLength(0);
  await page.close();
});

test('no key: the right-click path shows "Connect Groq" and sends nothing', async () => {
  await send(options, { v: 1, type: 'CLEAR_ALL_DATA' });
  const page = await ext.context.newPage();
  await page.goto(`${server.origin}/article.html`);
  await dblclickText(page, page, 'cartographer');
  const mark = ledger.mark();
  await clickContextMenu(page, 'cartographer');
  const card = cardOf(page);
  await card.waitFor(CARD.error);
  expect(await card.text(CARD.settings)).toBe('Connect Groq');
  expect(await cardText(card)).not.toContain(FAKE_KEY);
  await pause(600);
  expect(ledger.chats(mark)).toHaveLength(0);
  await page.close();
});

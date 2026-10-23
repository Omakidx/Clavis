import { expect, test } from '@playwright/test';
import { FAKE_KEY, openExtensionPage, send } from './p3-support/background';
import {
  CARD,
  cardOf,
  selectWord,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';
import { openFixtureReady, openReader } from './p7-reader-support/helpers';
import { selectWordByDoubleClick } from './p7-reader-support/select';
import { openPanelPage, tabIdOf } from './p8-sidepanel-support/panel';
import { articleFrame, selectArticleWord } from './p6-listen-support/listen';
import { dblclickText, dragSelect, keyboardExtend } from './spike-b-support/page';
import { SEL, tb } from './spike-b-support/toolbar';
import { chatBody } from './p5-card-support/harness';
import { installScript, pause, type Script } from './p9-support/card';
import { installLedger, type Ledger } from './p9-support/ledger';

// Phase 9 (security, privacy and performance): "Capture Chrome network traffic: zero selection-only
// AI requests" and "Count Groq requests per session in E2E: one per Explain, one per newly opened
// tab, zero on reopen" (FR-017, FR-030, FR-038, success measure "AI cost", abuse case 7).
//
// ONE ledger records every http(s) request the browser makes, from pages, frames, the service worker
// and (through a route) dedicated workers; it also aborts anything that is not the local fixture
// server or the faked Groq, so "zero requests to any host" can be asserted without trusting the
// extension. The journey then walks the surfaces in one session and checks the running total of paid
// requests after every user action.

test.describe.configure({ mode: 'serial', timeout: 90_000 });

let h: CardHarness;
let ledger: Ledger;
let script: Script;

test.beforeAll(async () => {
  h = await startCardHarness();
  ledger = await installLedger(h.ext.context);
  script = await installScript(h.ext.context);
});
test.afterAll(async () => {
  await h?.close();
});

const chats = (): number => ledger.chats().length;

test('one session: highlight sends nothing to any host; one request per Explain, one per newly opened tab, zero on reopen', async () => {
  // ---- 1. Highlighting in every way a person can, then Listen: not one request ----------------
  const first = await h.open();
  const page = first.page;
  const mark = ledger.mark();

  await dblclickText(page, page, 'cartographer'); // word
  await tb(page).waitShown();
  await dragSelect(page, page, 'The old bank', 'river'); // phrase
  await tb(page).waitShown();
  await page.mouse.click(5, 400); // click away
  await tb(page).waitHidden();
  await keyboardExtend(page, page, 'cartographer', 8); // keyboard
  await tb(page).waitShown();
  await page.keyboard.press('Control+a'); // select all
  await pause(300);
  await page.mouse.wheel(0, 200); // scroll with a selection
  await page.mouse.wheel(0, -200);
  await page.keyboard.press('Escape');
  await dblclickText(page, page, 'river');
  await tb(page).waitShown();
  // Listen is local too (the voice, or the no-voice message): it never reaches Groq or anyone.
  await tb(page).click('listen');
  await pause(1200);
  await tb(page).click('slow');
  await pause(300);
  expect(ledger.since(mark), 'highlighting and Listen made network requests').toEqual([]);
  expect(chats()).toBe(0);

  // ---- 2. Explain: exactly one paid request, to the one chat endpoint --------------------------
  await tb(page).click('explain');
  let card = cardOf(page);
  await card.waitFor(CARD.ready('core'));
  expect(chats()).toBe(1);
  expect(h.groq.chats()).toHaveLength(1);
  expect(h.groq.chats()[0]?.authorization).toBe(`Bearer ${FAKE_KEY}`);
  expect(ledger.models()).toHaveLength(0);

  // ---- 3. A newly opened tab: exactly one more; reopening a loaded tab, none ------------------
  await card.click(CARD.tab('etymology'));
  await card.waitFor(CARD.ready('etymology'));
  expect(chats()).toBe(2);
  await card.click(CARD.tab('core'));
  await card.click(CARD.tab('etymology'));
  await card.click(CARD.tab('related_words'));
  await card.waitFor(CARD.ready('related_words'));
  expect(chats()).toBe(3);
  for (const mode of ['core', 'etymology', 'related_words', 'core']) {
    await card.click(CARD.tab(mode));
    await pause(150);
  }
  // Explain pressed again for the same selection shows the same card: no request.
  await tb(page).click('explain');
  await pause(500);
  expect(chats()).toBe(3);
  // An open card left alone for a while does nothing by itself (no polling, no prefetch).
  await pause(3000);
  expect(chats()).toBe(3);

  // ---- 4. The side panel: opening it costs nothing, one Load costs one ---------------------------
  await card.click(CARD.sidePanel);
  await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
  const tabId = await tabIdOf(h.ext.serviceWorker, page);
  const panel = await openPanelPage(h.ext.context, h.ext.extensionId, tabId);
  await expect(panel.getByTestId('panel-selected')).toBeVisible();
  await pause(800);
  expect(chats()).toBe(3);
  await panel.close();

  // ---- 5. Dismiss; another selection is free until Explain is pressed ---------------------------
  await page.bringToFront();
  await page.keyboard.press('Escape');
  await tb(page).waitHidden();
  await selectWord(page, 'quiet');
  await pause(500);
  expect(chats()).toBe(3);
  await tb(page).click('explain');
  card = cardOf(page);
  await card.waitFor(CARD.ready('core'));
  expect(chats()).toBe(4);

  // ---- 6. Reload: the same word is a new selection, a new Explain, a new request --------------
  await page.reload();
  await selectWord(page, 'quiet');
  await pause(400);
  expect(chats()).toBe(4);
  await tb(page).click('explain');
  await cardOf(page).waitFor(CARD.ready('core'));
  expect(chats()).toBe(5);
  await first.dispose();

  // ---- 7. The PDF reader: its worker, text layer and Listen make no request either ---------------
  const reader = await openReader(h.ext.context, h.ext.extensionId);
  await openFixtureReady(reader.page, 'text-1page.pdf');
  const readerMark = ledger.mark();
  await selectWordByDoubleClick(reader.page, 'quick');
  await tb(reader.page).waitShown();
  await tb(reader.page).click('listen');
  await pause(1000);
  expect(ledger.since(readerMark)).toEqual([]);
  await tb(reader.page).click('explain');
  await cardOf(reader.page).waitFor(CARD.ready('core'));
  expect(chats()).toBe(6);
  await reader.page.close();

  // ---- 8. The practice page ------------------------------------------------------------------------
  const practice = await h.ext.context.newPage();
  await practice.goto(`chrome-extension://${h.ext.extensionId}/practice.html`);
  const frame = await articleFrame(practice);
  await selectArticleWord(practice, frame, 'river');
  await pause(400);
  expect(chats()).toBe(6);
  await tb(frame).click('explain');
  await cardOf(practice, frame).waitFor(CARD.ready('core'));
  expect(chats()).toBe(7);
  await practice.close();

  // ---- the whole session -------------------------------------------------------------------------------
  // 7 paid requests = 7 deliberate actions; nothing else was asked of Groq, and nothing left for
  // any other host. Every paid request carries the selected word in ONE quoted block.
  expect(ledger.chats()).toHaveLength(7);
  expect(ledger.models()).toHaveLength(0);
  expect(ledger.blocked).toEqual([]);
  const foreign = ledger.entries.filter((e) => e.host !== '127.0.0.1' && e.host !== 'api.groq.com');
  expect(foreign).toEqual([]);
  for (const call of h.groq.chats()) {
    const user = call.body?.messages[1]?.content ?? '';
    expect(user.match(/<selected_text_[0-9a-f]+>/g)).toHaveLength(1);
    expect(call.method).toBe('POST');
  }
  // Every request to Groq came from the service worker, never from a page or a content script.
  for (const entry of ledger.entries.filter((e) => e.host === 'api.groq.com')) {
    expect(entry.source).toBe('service-worker');
  }
});

test('saving a key makes exactly one models request, Test connection one more, and neither is a paid chat request', async () => {
  const options = await openExtensionPage(h.ext.context, h.ext.extensionId, 'options');
  const mark = ledger.mark();
  await send(options, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'session' });
  expect(ledger.models(mark)).toHaveLength(1);
  expect(ledger.chats(mark)).toHaveLength(0);
  await send(options, { v: 1, type: 'TEST_API_KEY' });
  expect(ledger.models(mark)).toHaveLength(2);
  expect(ledger.chats(mark)).toHaveLength(0);
  // Reading status, settings or the AI state never calls out.
  await send(options, { v: 1, type: 'GET_KEY_STATUS' });
  await send(options, { v: 1, type: 'GET_SETTINGS' });
  await send(options, { v: 1, type: 'GET_AI_STATUS' });
  await pause(500);
  expect(ledger.since(mark).filter((e) => e.host === 'api.groq.com')).toHaveLength(2);
  // Put the persistent key back for the following test.
  await send(options, { v: 1, type: 'SET_API_KEY', apiKey: FAKE_KEY, storage: 'local' });
  await options.close();
});

test('pressing Explain twice in a row (double click) while it loads is still one request', async () => {
  let release: () => void = () => undefined;
  script.handler = async (route) => {
    await new Promise<void>((resolve) => (release = resolve));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chatBody(
        JSON.stringify({
          title: 'x',
          summary: 'x',
          contextualMeaning: 'x',
          definition: 'x',
          examples: [{ sentence: 'x' }, { sentence: 'y' }],
        }),
      ),
    });
  };
  const { page, dispose } = await h.open();
  await selectWord(page, 'cartographer');
  const mark = ledger.mark();
  const box = await tb(page).box(SEL.action('explain'));
  await page.mouse.dblclick(box.x + box.width / 2, box.y + box.height / 2);
  const card = cardOf(page);
  await card.waitFor(`${CARD.panel('core')}[data-status="loading"]`);
  await pause(700);
  expect(ledger.chats(mark)).toHaveLength(1);
  release();
  await card.waitFor(CARD.ready('core'));
  expect(ledger.chats(mark)).toHaveLength(1);
  await dispose();
  script.handler = undefined;
});

test('positive control: the ledger sees requests from a page, a dedicated worker and the service worker, and blocks foreign hosts', async () => {
  const { page, dispose } = await h.open();
  const mark = ledger.mark();
  const blockedBefore = ledger.blocked.length;
  await page.evaluate(async () => {
    await fetch('https://p9-canary-page.test/page', { mode: 'no-cors' }).catch(() => undefined);
    const code = `fetch('https://p9-canary-worker.test/worker', { mode: 'no-cors' }).catch(() => {}).then(() => postMessage('done'))`;
    const worker = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    await new Promise((resolve) => (worker.onmessage = resolve));
  });
  await h.ext.serviceWorker.evaluate(() =>
    fetch('https://p9-canary-sw.test/sw', { mode: 'no-cors' }).catch(() => undefined),
  );
  // Playwright attributes a dedicated worker's request to its owner page; what matters is that it
  // is seen at all (and blocked), which the plain `request` event alone would not guarantee.
  const seen = ledger.since(mark).map((e) => `${e.source}:${e.host}`);
  expect(seen).toEqual(
    expect.arrayContaining([
      'page:p9-canary-page.test',
      expect.stringMatching(/^(page|worker):p9-canary-worker\.test$/),
      'service-worker:p9-canary-sw.test',
    ]),
  );
  expect(ledger.blocked.slice(blockedBefore)).toHaveLength(3);
  // Clean up the marks of this control so the session assertions of other tests stay meaningful.
  ledger.blocked.length = blockedBefore;
  await dispose();
});

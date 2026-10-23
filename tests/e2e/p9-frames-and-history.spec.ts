import { expect, test } from '@playwright/test';
import {
  CARD,
  cardOf,
  explainWord,
  selectWord,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';
import { dblclickText } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import { cardText, pause } from './p9-support/card';
import { installLedger, type Ledger } from './p9-support/ledger';

// Phase 9, "Regression test navigation/reselection stale answers and toolbar persistence", for the
// two situations the earlier suites do not drive end to end: Explain inside an iframe (same-origin
// and cross-origin, both reached by the registered observer) and history navigation (a single-page
// app replacing its content, and the browser's Back button). One request per Explain everywhere,
// the card lives in the frame that holds the selection, and nothing of an old answer survives.

test.describe.configure({ mode: 'serial', timeout: 60_000 });

let h: CardHarness;
let ledger: Ledger;
test.beforeAll(async () => {
  h = await startCardHarness();
  ledger = await installLedger(h.ext.context);
});
test.afterAll(async () => {
  await h?.close();
});

test('Explain inside a same-origin and a cross-origin iframe: the card opens in THAT frame, one request each, the top page gets nothing', async () => {
  const { page, dispose } = await h.open('iframe.html');
  await expect
    .poll(() => page.frames().filter((f) => f.url().includes('iframe-inner')).length)
    .toBeGreaterThanOrEqual(2);
  for (const host of ['127.0.0.1', 'localhost']) {
    const frame = page
      .frames()
      .find((f) => f.url().includes('iframe-inner') && f.url().includes(host));
    expect(frame, `frame on ${host}`).toBeDefined();
    const mark = ledger.mark();
    await dblclickText(page, frame!, 'lighthouse');
    await tb(frame!).waitShown();
    // Selecting inside a frame sends nothing.
    await pause(400);
    expect(ledger.since(mark)).toEqual([]);
    await tb(frame!).click('explain');
    const card = cardOf(page, frame!);
    await card.waitFor(CARD.ready('core'));
    expect(await card.text(CARD.text)).toBe('lighthouse');
    expect(ledger.chats(mark)).toHaveLength(1);
    // The top document has no toolbar of its own for this selection.
    expect(await tb(page).isShown()).toBe(false);
    await page.keyboard.press('Escape');
    await tb(frame!).waitHidden();
  }
  await dispose();
});

/** A single-page app's route change: the URL changes without a load and the article text is replaced. */
async function routeChange(page: import('@playwright/test').Page): Promise<void> {
  await page.evaluate(() => {
    history.pushState({ route: 2 }, '', '/article.html?route=2');
    const main = document.querySelector('main')!;
    main.replaceChildren();
    const p = document.createElement('p');
    p.id = 'route2';
    p.textContent = 'A different route with the word lighthouse and the word harbour in it.';
    main.append(p);
  });
}

// Q4 (Low; FR-014 "Dismiss on ... selection removal", architecture section 5 rule 8; found by this
// suite, fixed in Phase 9): when the page itself deletes the selected text (a single-page app
// changing route), Chrome fires no `selectionchange`. The controller now checks twice a second,
// while the toolbar shows a web page's selection, that the range is still in the document
// (lib/selection/controller.ts). `removeAllRanges()` and `collapse()` dismiss through the observer.
test('a single-page app that deletes the selected text dismisses the toolbar and card', async () => {
  const { page, dispose } = await h.open();
  const card = await explainWord(page, 'cartographer');
  await card.waitFor(CARD.ready('core'));
  // Let the observer's own timers run out first: a capture still pending when the text disappears
  // would notice the collapsed selection and hide the toolbar by chance (seen in 1 run in 3).
  await pause(1500);
  try {
    await routeChange(page);
    await tb(page).waitHidden();
    expect(await card.exists(CARD.card).catch(() => false)).toBe(false);
  } finally {
    await dispose();
  }
});

test('after a single-page route change a click and a new selection start a fresh Explain: a fresh request and answer, nothing of the old card', async () => {
  const { page, dispose } = await h.open();
  let card = await explainWord(page, 'cartographer');
  await card.waitFor(CARD.ready('core'));
  const mark = ledger.mark();
  await routeChange(page);
  // The reader clicks (anywhere) on the new route: the old toolbar and card go.
  await page.mouse.click(5, 300);
  await tb(page).waitHidden();
  expect(await card.exists(CARD.card).catch(() => false)).toBe(false);
  expect(ledger.since(mark)).toEqual([]);

  await selectWord(page, 'harbour');
  await tb(page).click('explain');
  card = cardOf(page);
  await card.waitFor(CARD.ready('core'));
  expect(await card.text(CARD.text)).toBe('harbour');
  expect(ledger.chats(mark)).toHaveLength(1);
  expect(await cardText(card)).not.toContain('cartographer');
  await dispose();
});

test('Back to a page after navigating away: the page is usable, and a new Explain shows only its own answer (one request)', async () => {
  const { page, dispose } = await h.open();
  const card = await explainWord(page, 'cartographer');
  await card.waitFor(CARD.ready('core'));
  await page.goto(`${h.server.origin}/long.html`);
  await pause(300);
  await page.goBack();
  await page.waitForLoadState();
  await pause(500);

  // Whatever the browser restored (a fresh document or a cached one), it must behave: select a
  // different word and Explain it.
  const mark = ledger.mark();
  await page.keyboard.press('Escape');
  await selectWord(page, 'river');
  await tb(page).click('explain');
  const again = cardOf(page);
  await again.waitFor(CARD.ready('core'));
  expect(await again.text(CARD.text)).toBe('river');
  expect(await cardText(again)).not.toContain('cartographer');
  expect(ledger.chats(mark)).toHaveLength(1);
  await dispose();
});

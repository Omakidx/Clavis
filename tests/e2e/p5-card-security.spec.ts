import { expect, test, type Page } from '@playwright/test';
import { contentWorld } from './p3-support/content-world';
import { dblclickText } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import {
  CARD,
  cardOf,
  explainWord,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';

// Phase 5 security review regressions in the BUILT extension: what a hostile page can observe and
// provoke around the explanation card.
let h: CardHarness;
test.beforeAll(async () => {
  h = await startCardHarness();
});
test.afterAll(async () => {
  await h?.close();
});

test('L1: no page-visible message carries the extension id, and forged "script started" events kill nothing', async () => {
  const page = await h.ext.context.newPage();
  // A hostile page that records every message event from the first moment.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    window.addEventListener(
      'message',
      (event) => seen.push(JSON.stringify(event.data) ?? ''),
      true,
    );
  });
  const world = await contentWorld(page);
  await page.goto(`${h.server.origin}/article.html`);
  await world.ready();
  const id = h.ext.extensionId;
  const globalsAlive = (): Promise<string> =>
    world.evaluate<string>(
      `typeof globalThis[Symbol.for('clavis.observer')] + '/' + typeof globalThis[Symbol.for('clavis.explain-card')]`,
    );

  await dblclickText(page, page, 'cartographer');
  await tb(page).waitShown();
  await tb(page).click('explain');
  const card = cardOf(page);
  await card.waitFor(CARD.ready('core'));
  expect(await globalsAlive()).toBe('object/object');

  // The page forges the events WXT uses to say "a newer copy of this script started", for BOTH
  // entrypoints (it is given the id here to prove the forged events fail on their own).
  await page.evaluate((extensionId) => {
    for (const name of ['content', 'explain-card']) {
      document.dispatchEvent(
        new CustomEvent(`${extensionId}:${name}:wxt:content-script-started`, {
          detail: { contentScriptName: name, messageId: 'forged' },
        }),
      );
    }
  }, id);
  await page.waitForTimeout(200);
  expect(await globalsAlive()).toBe('object/object');

  // Nothing the page could hear contained the id or the WXT announcement.
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen);
  expect(seen.join('\n')).not.toContain(id);
  expect(seen.join('\n')).not.toContain('content-script-started');

  // And the whole thing still works: another selection, Explain, a lazy tab.
  await page.keyboard.press('Escape');
  await tb(page).waitHidden();
  const again = await explainWord(page, 'river');
  await again.waitFor(CARD.ready('core'));
  await again.click(CARD.tab('etymology'));
  await again.waitFor(CARD.ready('etymology'));
  await world.dispose();
  await page.close();
});

/** A page that records every copy/cut/selection event and what the selection held at the time. */
async function recordSelectionEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const log: string[] = [];
    (window as unknown as { __log: string[] }).__log = log;
    for (const type of ['copy', 'cut', 'selectionchange']) {
      document.addEventListener(
        type,
        () => log.push(`${type}:${getSelection()?.toString() ?? ''}`),
        true,
      );
    }
  });
}

async function assertNothingLeaked(page: Page, since: number): Promise<void> {
  const log = await page.evaluate(() => (window as unknown as { __log: string[] }).__log);
  const added = log.slice(since).join('\n');
  // The page's own selection may stay as it was, but never holds the copied answer.
  expect(added).not.toContain('Definition');
  expect(added).not.toContain('We sat on the bank.');
  expect(log.filter((entry) => entry.startsWith('copy:') || entry.startsWith('cut:'))).toEqual([]);
  expect(await page.evaluate(() => document.querySelectorAll('textarea').length)).toBe(0);
}

test('L2: copying never exposes the text to the page: no copy event, no selection, no textarea', async () => {
  await h.ext.context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: h.server.origin,
  });
  const page = await h.ext.context.newPage();
  await recordSelectionEvents(page);
  await page.goto(`${h.server.origin}/article.html`);
  const card = await explainWord(page, 'cartographer');
  await card.waitFor(CARD.ready('core'));
  const before = await page.evaluate(() => (window as unknown as { __log: string[] }).__log.length);
  await card.click(CARD.copy);
  await expect.poll(() => card.text(CARD.copy)).toBe('Copied');
  await assertNothingLeaked(page, before);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    'We sat on the bank.',
  );
  await page.close();
});

test('L2: a page that blocks the async clipboard (Permissions-Policy) only gets a message, never a fallback that leaks', async () => {
  const page = await h.ext.context.newPage();
  await recordSelectionEvents(page);
  await page.route(`${h.server.origin}/article.html`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'permissions-policy': 'clipboard-write=()' },
    });
  });
  await page.goto(`${h.server.origin}/article.html`);
  const card = await explainWord(page, 'cartographer');
  await card.waitFor(CARD.ready('core'));
  const before = await page.evaluate(() => (window as unknown as { __log: string[] }).__log.length);
  await card.click(CARD.copy);
  await expect.poll(() => card.text(CARD.live)).toBe("Copy isn't available on this page.");
  expect(await card.text(CARD.copy)).toBe('Copy');
  await assertNothingLeaked(page, before);
  await page.close();
});

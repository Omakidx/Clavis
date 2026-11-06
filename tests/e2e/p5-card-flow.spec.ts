import { expect, test } from '@playwright/test';
import { SEL, tb } from './spike-b-support/toolbar';
import { dblclickText, dragSelect } from './spike-b-support/page';
import {
  CARD,
  MAIN_WORLD_PROBE,
  cardOf,
  explainWord,
  selectWord,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';

// Phase 5, explanation card, the main path in the BUILT extension (Groq answered by the test):
// select, Explain, core answer, lazy tabs, cache, copy, dismissal, FR-017. The card lives in the
// toolbar's CLOSED shadow root and is injected by the background on the first Explain (D-08).
let h: CardHarness;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  h = await startCardHarness();
});
test.afterAll(async () => {
  await h?.close();
});

test('nothing is sent and no card is loaded until Explain is pressed (FR-017, D-08)', async () => {
  const { page, world, dispose } = await h.open();
  try {
    await selectWord(page, 'cartographer');
    // Listen is local in this phase; selecting, the toolbar and a pause change nothing.
    await page.waitForTimeout(300);
    expect(h.groqUrls).toEqual([]);
    expect(
      await world.evaluate<string>(`typeof globalThis[Symbol.for('clavis.explain-card')]`),
    ).toBe('undefined');

    await tb(page).click('explain');
    await cardOf(page).waitFor(CARD.ready('core'));
    expect(
      await world.evaluate<string>(`typeof globalThis[Symbol.for('clavis.explain-card')]`),
    ).toBe('object');
  } finally {
    await dispose();
  }
});

test('core answer, then Roots costs exactly one more request, and reopening it costs none', async () => {
  const { page, dispose } = await h.open();
  try {
    h.groq.reset();
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));

    // One request for Explain, and it is the core one.
    expect(h.groq.chats()).toHaveLength(1);
    expect(h.groq.chats()[0]?.body?.messages[1]?.content).toContain('(mode: core)');
    expect(h.groq.calls.filter((call) => call.url.endsWith('/models'))).toHaveLength(0);

    expect(await card.text(CARD.text)).toBe('cartographer');
    const core = (await card.text(CARD.panel('core'))) ?? '';
    expect(core).toContain('bank');
    expect(core).toContain('Meaning here');
    expect(core).toContain('Definition');
    expect(core).toContain('Examples written by AI');
    expect(core).toContain('We sat on the bank.');
    expect(await card.text(CARD.model)).toBe('Model: openai/gpt-oss-20b');
    expect((await card.tabs())?.map((tab) => tab.label)).toEqual([
      'Core',
      'Roots',
      'Related words',
      'Translate',
    ]);
    // Nothing was prefetched for the tabs nobody opened.
    expect(await card.status('etymology')).toBe('idle');

    // Roots: opened for the first time, one more request.
    await card.click(CARD.tab('etymology'));
    await card.waitFor(CARD.ready('etymology'));
    expect(h.groq.chats()).toHaveLength(2);
    expect(h.groq.chats()[1]?.body?.messages[1]?.content).toContain('(mode: etymology)');
    expect(await card.text(CARD.panel('etymology'))).toContain('From Old Norse banki');

    // Reopen Roots (via Core and back): the cache answers, nothing is sent.
    await card.click(CARD.tab('core'));
    await card.click(CARD.tab('etymology'));
    await card.click(CARD.tab('related_words'));
    await card.waitFor(CARD.ready('related_words'));
    expect(h.groq.chats()).toHaveLength(3);
    await card.click(CARD.tab('etymology'));
    await card.click(CARD.tab('core'));
    await card.click(CARD.tab('related_words'));
    await page.waitForTimeout(300);
    expect(h.groq.chats()).toHaveLength(3);
    expect(await card.text(CARD.panel('related_words'))).toContain('shore');
    expect(await card.text(CARD.panel('related_words'))).toContain('Not applicable');
  } finally {
    await dispose();
  }
});

test('Explain again on the same selection re-shows the card without another request', async () => {
  const { page, dispose } = await h.open();
  try {
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    h.groq.reset();
    // Close with the card's own button, then ask again for the same selection.
    await card.click(CARD.close);
    await card.waitGone(CARD.card);
    expect(await tb(page).isShown()).toBe(true);
    await tb(page).click('explain');
    await card.waitFor(CARD.ready('core'));
    expect(h.groq.chats()).toHaveLength(0);
  } finally {
    await dispose();
  }
});

test('a sentence gets Core and Simplify only; Simplify is requested on first open; Copy copies the visible tab', async () => {
  const { page, dispose } = await h.open();
  try {
    await h.ext.context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: h.server.origin,
    });
    h.groq.reset();
    await dragSelect(page, page, 'The old bank stood', 'almost two hundred years.');
    await tb(page).waitShown();
    await tb(page).click('explain');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    expect((await card.tabs())?.map((tab) => tab.label)).toEqual(['Core', 'Simplify', 'Translate']);

    await card.click(CARD.tab('simplify'));
    await card.waitFor(CARD.ready('simplify'));
    expect(h.groq.chats()).toHaveLength(2);
    expect(h.groq.chats()[1]?.body?.messages[1]?.content).toContain('(mode: simplify)');

    await card.click(CARD.copy);
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('The ground next to the river.');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain('Simpler version:');
    expect(copied).not.toContain('Definition');
    expect(copied).not.toMatch(/[<>]/);
    expect(await card.text(CARD.copy)).toBe('Copied');
  } finally {
    await dispose();
  }
});

test('Escape closes the toolbar and the card, and the same selection asks again next time', async () => {
  const { page, dispose } = await h.open();
  try {
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
    await expect.poll(() => card.exists(CARD.card).catch(() => false)).toBe(false);
  } finally {
    await dispose();
  }
});

test('the page cannot reach the card, its registry or its closed root', async () => {
  const { page, dispose } = await h.open();
  try {
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    const seen = await page.evaluate(MAIN_WORLD_PROBE);
    expect(seen).toEqual({ symbols: 0, names: [], hostShadow: false });
    // A page script that clicks the card's buttons is not a user: nothing happens.
    await page.evaluate(() => {
      const host = document.querySelector('div[popover]') as HTMLElement;
      host.click();
      host.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
    });
    await page.waitForTimeout(150);
    expect(h.groq.chats().length).toBeGreaterThan(0);
    expect(await card.status('etymology')).toBe('idle');
    expect(SEL.panel).toBeTruthy();
  } finally {
    await dispose();
  }
});

test('word selection by the keyboard shortcut path keeps working next to the card', async () => {
  const { page, dispose } = await h.open();
  try {
    await dblclickText(page, page, 'river');
    await tb(page).waitShown();
    await tb(page).focusAction('explain');
    await page.keyboard.press('Enter');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    // Started from the keyboard: focus moved into the card.
    expect(await card.focused()).toBe('card:explain');
  } finally {
    await dispose();
  }
});

test('the card script can run again in the same frame (the background re-injects it on every load): one card, one stylesheet, Explain works', async () => {
  const { page, world, dispose } = await h.open();
  try {
    const inject = (): Promise<unknown> =>
      h.ext.serviceWorker.evaluate(async (origin) => {
        const [tab] = await chrome.tabs.query({ url: `${origin}/*` });
        await chrome.scripting.executeScript({
          target: { tabId: tab?.id as number, frameIds: [0] },
          files: ['/explain-card.js'],
        });
      }, h.server.origin);
    // Twice before any Explain, then once more after the card has been used.
    await inject();
    await inject();
    const registry = `typeof globalThis[Symbol.for('clavis.explain-card')]`;
    expect(await world.evaluate<string>(registry)).toBe('object');

    h.groq.reset();
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    await inject();
    expect(await world.evaluate<string>(registry)).toBe('object');
    // The newest copy replaced the old one: its sessions are gone, the toolbar still works.
    await tb(page).click('explain');
    await card.waitFor(CARD.ready('core'));
    const shape = await tb(page).evalIn<{ cards: number; sheets: number; markers: number }>(
      null,
      `function () {
        return {
          cards: this.querySelectorAll('[data-clavis="card"]').length,
          sheets: this.adoptedStyleSheets.length + this.querySelectorAll('style').length,
          markers: this.querySelectorAll('[data-clavis="card-text"]').length,
        };
      }`,
    );
    // Toolbar sheet plus exactly one card sheet.
    expect(shape).toEqual({ cards: 1, sheets: 2, markers: 1 });
    await card.click(CARD.tab('etymology'));
    await card.waitFor(CARD.ready('etymology'));
  } finally {
    await dispose();
  }
});

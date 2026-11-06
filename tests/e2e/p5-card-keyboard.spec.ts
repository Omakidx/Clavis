import { expect, test } from '@playwright/test';
import { tb } from './spike-b-support/toolbar';
import {
  CARD,
  cardOf,
  chatBody,
  explainWord,
  overrideChat,
  selectWord,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';

// Phase 5, explanation card: keyboard, focus and layout in the BUILT extension (closed root, real
// key events). The axe run on an open-root rendering is p5-card-a11y.spec.ts.
let h: CardHarness;
let longAnswer = false;

test.beforeAll(async () => {
  h = await startCardHarness();
  const sentence = 'A long sentence that keeps going and going so the answer needs room. ';
  await overrideChat(h.ext.context, async (route) => {
    if (!longAnswer) return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chatBody(
        JSON.stringify({
          title: 'bank',
          summary: sentence.repeat(6).trim(),
          contextualMeaning: sentence.repeat(10).trim(),
          definition: sentence.repeat(8).trim(),
          examples: [
            { sentence: sentence.repeat(3).trim(), note: null },
            { sentence: sentence.repeat(3).trim(), note: null },
          ],
          caveat: sentence.repeat(4).trim(),
        }),
      ),
    });
  });
});
test.afterAll(async () => {
  await h?.close();
});
test.afterEach(() => {
  longAnswer = false;
});

test('keyboard only: Explain, Tab through the card, arrow between tabs without a request, Enter opens one', async () => {
  const { page, dispose } = await h.open();
  try {
    await selectWord(page, 'cartographer');
    await tb(page).focusAction('explain');
    await page.keyboard.press('Enter');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    // Focus moved into the card because the run started from the keyboard.
    expect(await card.focused()).toBe('card:explain');

    const order: Array<string | null | undefined> = [];
    for (let i = 0; i < 4; i += 1) {
      await page.keyboard.press('Tab');
      order.push(await card.focused());
    }
    expect(order).toEqual(['card-close:', 'card-tab:core', 'card-panel:core', 'card-copy:']);

    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    expect(await card.focused()).toBe('card-tab:core');
    h.groq.reset();
    await page.keyboard.press('ArrowRight');
    expect(await card.focused()).toBe('card-tab:etymology');
    await page.keyboard.press('ArrowRight');
    expect(await card.focused()).toBe('card-tab:related_words');
    await page.keyboard.press('ArrowRight');
    expect(await card.focused()).toBe('card-tab:translate');
    await page.keyboard.press('End');
    expect(await card.focused()).toBe('card-tab:translate');
    await page.keyboard.press('Home');
    expect(await card.focused()).toBe('card-tab:core');
    await page.keyboard.press('ArrowLeft');
    expect(await card.focused()).toBe('card-tab:translate');
    await page.keyboard.press('ArrowLeft');
    expect(await card.focused()).toBe('card-tab:related_words');
    // Moving focus around requested nothing, and the toolbar's arrow group stayed out of it.
    await page.waitForTimeout(250);
    expect(h.groq.chats()).toHaveLength(0);
    expect((await card.tabs())?.map((tab) => tab.selected)).toEqual([
      'true',
      'false',
      'false',
      'false',
    ]);
    expect((await card.tabs())?.map((tab) => tab.tabindex)).toEqual(['-1', '-1', '0', '-1']);

    await page.keyboard.press('Enter');
    await card.waitFor(CARD.ready('related_words'));
    expect(h.groq.chats()).toHaveLength(1);
    expect((await card.tabs())?.map((tab) => tab.selected)).toEqual([
      'false',
      'false',
      'true',
      'false',
    ]);
  } finally {
    await dispose();
  }
});

test('the card Close button, used from the keyboard, returns focus to the Explain button', async () => {
  const { page, dispose } = await h.open();
  try {
    await selectWord(page, 'cartographer');
    await tb(page).focusAction('explain');
    await page.keyboard.press('Enter');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    await page.keyboard.press('Tab');
    expect(await card.focused()).toBe('card-close:');
    await page.keyboard.press('Enter');
    await card.waitGone(CARD.card);
    expect(await tb(page).focusedAction()).toBe('explain');
    expect(await tb(page).isShown()).toBe(true);
  } finally {
    await dispose();
  }
});

test('Escape inside the card closes everything and takes focus out of it', async () => {
  const { page, dispose } = await h.open();
  try {
    await selectWord(page, 'cartographer');
    await tb(page).focusAction('explain');
    await page.keyboard.press('Enter');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    await page.keyboard.press('Tab');
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
    await expect.poll(() => card.exists(CARD.card).catch(() => false)).toBe(false);
  } finally {
    await dispose();
  }
});

test('a mouse run leaves keyboard focus where it was (the page selection is not disturbed)', async () => {
  const { page, dispose } = await h.open();
  try {
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    expect(await card.focused()).toBeNull();
    expect(await page.evaluate(() => getSelection()?.toString().trim())).toBe('cartographer');
  } finally {
    await dispose();
  }
});

for (const [name, width, height] of [
  ['320 px wide phone', 320, 568],
  ['200% zoom of a 1280 x 720 window (640 x 360 CSS px)', 640, 360],
] as const) {
  test(`a long answer scrolls inside the card and the card stays in the viewport: ${name}`, async () => {
    longAnswer = true;
    const { page, dispose } = await h.open();
    try {
      await page.setViewportSize({ width, height });
      const card = await explainWord(page, 'cartographer');
      await card.waitFor(CARD.ready('core'));
      await page.waitForTimeout(150);
      const box = await tb(page).box(CARD.card);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);
      expect(box.y + box.height).toBeLessThanOrEqual(height + 0.5);
      // The body scrolls instead of the card growing, and can be scrolled from the keyboard.
      const body = await tb(page).evalIn<{
        scroll: number;
        client: number;
        tabindex: string | null;
      }>(
        CARD.panel('core'),
        `function () { return { scroll: this.scrollHeight, client: this.clientHeight, tabindex: this.getAttribute('tabindex') }; }`,
      );
      expect(body?.scroll).toBeGreaterThan(body?.client ?? 0);
      expect(body?.tabindex).toBe('0');
      // Nothing makes the page itself scroll sideways.
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
        ),
      ).toBe(true);
      // Every button keeps a comfortable target (WCAG 2.2: at least 24 x 24 CSS px).
      const sizes = await tb(page).evalIn<Array<{ w: number; h: number }>>(
        CARD.card,
        `function () { return Array.from(this.querySelectorAll('button')).map((b) => { const r = b.getBoundingClientRect(); return { w: r.width, h: r.height }; }); }`,
      );
      for (const size of sizes ?? []) {
        expect(size.w).toBeGreaterThanOrEqual(24);
        expect(size.h).toBeGreaterThanOrEqual(24);
      }
    } finally {
      await dispose();
    }
  });
}

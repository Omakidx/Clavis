import { expect, test } from '@playwright/test';
import { dragSelect } from './spike-b-support/page';
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
import { realPanelUrls } from './p8-sidepanel-support/panel';

// Phase 8, explanation card UX in the BUILT extension (closed root, real mouse and keys):
// scope-aware tabs, long answers, narrow windows and zoom, dark mode, right-to-left text and the
// keyboard path to the side panel. Axe on an open-root rendering: p5-card-a11y.spec.ts.
let h: CardHarness;
let answer: 'normal' | 'long' | 'rtl' = 'normal';

test.beforeAll(async () => {
  h = await startCardHarness();
  const sentence = 'A long sentence that keeps going and going so the answer needs room. ';
  await overrideChat(h.ext.context, async (route, mode) => {
    if (answer === 'normal' || mode !== 'core') return route.fallback();
    const body =
      answer === 'long'
        ? {
            title: 'bank',
            summary: sentence.repeat(8).trim().slice(0, 590),
            contextualMeaning: sentence.repeat(11).trim().slice(0, 790),
            definition: sentence.repeat(8).trim().slice(0, 590),
            examples: [
              { sentence: sentence.repeat(4).trim().slice(0, 290), note: null },
              { sentence: sentence.repeat(4).trim().slice(0, 290), note: null },
            ],
            caveat: sentence.repeat(5).trim().slice(0, 390),
          }
        : {
            title: 'ضفة',
            summary: 'الأرض بجانب النهر.',
            contextualMeaning: 'هنا تعني حافة النهر (bank) وليس مصرف الأموال.',
            definition: 'أرض منحدرة على جانب النهر.',
            examples: [
              { sentence: 'صدنا السمك من الضفة.', note: null },
              { sentence: 'Say ضفة to her.', note: null },
            ],
            caveat: null,
          };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chatBody(JSON.stringify(body)),
    });
  });
});
test.afterAll(async () => {
  await h?.close();
});
test.afterEach(() => {
  answer = 'normal';
});

test('a word gets Roots and Related words, a phrase also Simplify, a sentence only Simplify, and all of them Translate', async () => {
  const word = await h.open();
  try {
    const card = await explainWord(word.page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    expect((await card.tabs())?.map((t) => t.label)).toEqual([
      'Core',
      'Roots',
      'Related words',
      'Translate',
    ]);
  } finally {
    await word.dispose();
  }
  const phrase = await h.open('article.html?phrase=1');
  try {
    await dragSelect(phrase.page, phrase.page, 'old bank', 'beside');
    await tb(phrase.page).waitShown();
    await tb(phrase.page).click('explain');
    const card = cardOf(phrase.page);
    await card.waitFor(CARD.ready('core'));
    expect(await card.text('[data-clavis="card"] .ec__kind')).toBe('Phrase');
    expect((await card.tabs())?.map((t) => t.label)).toEqual([
      'Core',
      'Roots',
      'Related words',
      'Simplify',
      'Translate',
    ]);
  } finally {
    await phrase.dispose();
  }
  const sentence = await h.open('article.html?sentence=1');
  try {
    await dragSelect(sentence.page, sentence.page, 'The old bank stood', 'two hundred years.');
    await tb(sentence.page).waitShown();
    await tb(sentence.page).click('explain');
    const card = cardOf(sentence.page);
    await card.waitFor(CARD.ready('core'));
    expect((await card.tabs())?.map((t) => t.label)).toEqual(['Core', 'Simplify', 'Translate']);
  } finally {
    await sentence.dispose();
  }
});

test('a long answer scrolls INSIDE the card, which stays in a 320 px window, and suggests the side panel', async () => {
  answer = 'long';
  const { page, dispose } = await h.open('article.html?long=1');
  try {
    // 320 CSS px wide and short: what a 200% zoom of a small window looks like.
    await page.setViewportSize({ width: 320, height: 420 });
    await page.evaluate(() => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if ((n.textContent ?? '').includes('cartographer')) {
          n.parentElement?.scrollIntoView({ block: 'start' });
          break;
        }
      }
    });
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    await card.waitFor(CARD.longHint);
    expect(await card.text(CARD.longHint)).toContain('side panel');

    const box = await card.toolbar.box('[data-clavis="card"]');
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(box.y + box.height).toBeLessThanOrEqual(420);
    // The answer is longer than the card: its own panel scrolls, the page does not have to.
    const scrolls = await card.toolbar.evalIn<boolean>(
      CARD.panel('core'),
      'function () { return this.scrollHeight > this.clientHeight + 4; }',
    );
    expect(scrolls).toBe(true);
    // The action that gives it more room is on screen and reachable.
    const action = await card.toolbar.box(CARD.sidePanel);
    expect(action.x).toBeGreaterThanOrEqual(0);
    expect(action.x + action.width).toBeLessThanOrEqual(320);
    expect(action.y + action.height).toBeLessThanOrEqual(420);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      320,
    );
  } finally {
    await dispose();
  }
});

test('dark colour scheme: the card follows it', async () => {
  const { page, dispose } = await h.open('article.html?dark=1');
  try {
    await page.emulateMedia({ colorScheme: 'dark' });
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    const colours = await card.toolbar.evalIn<{ bg: string; fg: string }>(
      '[data-clavis="card"]',
      `function () { const s = getComputedStyle(this); return { bg: s.backgroundColor, fg: s.color }; }`,
    );
    // Dark surface and light text from the shared toolbar/card palette.
    expect(colours).toEqual({ bg: 'rgb(39, 42, 33)', fg: 'rgb(246, 247, 235)' });
  } finally {
    await dispose();
  }
});

test('right-to-left answers: every piece of model text sets its own direction and reads right-to-left', async () => {
  answer = 'rtl';
  const { page, dispose } = await h.open('article.html?rtl=1');
  try {
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    const report = await card.toolbar.evalIn<{
      dirs: string[];
      arabicIsRtl: boolean;
      mixedIsLtr: boolean;
    }>(
      CARD.panel('core'),
      `function () {
        const texts = Array.from(this.querySelectorAll('.ec__result p:not(.ec__label), .ec__result li'));
        const find = (needle) => texts.find((el) => el.textContent.includes(needle));
        return {
          dirs: texts.map((el) => el.getAttribute('dir')),
          arabicIsRtl: getComputedStyle(find('الأرض بجانب')).direction === 'rtl',
          mixedIsLtr: getComputedStyle(find('Say ')).direction === 'ltr',
        };
      }`,
    );
    expect(report?.dirs.length).toBeGreaterThan(4);
    expect(report?.dirs.every((d) => d === 'auto')).toBe(true);
    expect(report?.arabicIsRtl).toBe(true);
    expect(report?.mixedIsLtr).toBe(true);
  } finally {
    await dispose();
  }
});

test('keyboard only: Tab to Open in side panel and press Enter; Escape dismisses card and toolbar', async () => {
  const { page, dispose } = await h.open('article.html?keyboard=1');
  try {
    await selectWord(page, 'cartographer');
    await tb(page).focusAction('explain');
    await page.keyboard.press('Enter');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    expect(await card.focused()).toBe('card:explain');
    const order: Array<string | null | undefined> = [];
    for (let i = 0; i < 5; i += 1) {
      await page.keyboard.press('Tab');
      order.push(await card.focused());
    }
    expect(order).toEqual([
      'card-close:',
      'card-tab:core',
      'card-panel:core',
      'card-copy:',
      'card-side-panel:',
    ]);
    const before = (await realPanelUrls(h.ext.serviceWorker)).length;
    await page.keyboard.press('Enter');
    await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
    expect((await realPanelUrls(h.ext.serviceWorker)).length).toBeGreaterThanOrEqual(before);
    await expect
      .poll(() => realPanelUrls(h.ext.serviceWorker))
      .toContainEqual(expect.stringMatching(/sidepanel\.html\?tab=\d+$/));

    // Escape dismisses the card and the toolbar together (UJ-02); Close alone keeps focus on Explain.
    await page.keyboard.press('Escape');
    await card.waitGone(CARD.card);
  } finally {
    await dispose();
  }
});

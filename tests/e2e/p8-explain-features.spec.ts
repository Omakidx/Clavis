import { expect, test } from '@playwright/test';
import { dragSelect } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import {
  CARD,
  cardOf,
  chatBody,
  overrideChat,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';
import { openPanelPage, tabIdOf } from './p8-sidepanel-support/panel';

// The Grammar and Translate tabs (FR-036, FR-037) in a build with every flag FORCED ON (Grammar is the
// one that ships off):
//
//   CLAVIS_FORCE_FEATURES=1 WXT_OUT_DIR=.output-p8-flags npx wxt build
//   CLAVIS_FORCE_FEATURES=1 CLAVIS_EXTENSION_DIR=.output-p8-flags/chrome-mv3 \
//     npx playwright test tests/e2e/p8-explain-features.spec.ts
//
// (lib/config/constants.ts ships Translate on and Grammar off; wxt.config.ts only flips Grammar for
// this build.) Without the env var the spec is skipped: the shipped build must NOT show the Grammar
// tab, which tests/e2e/p8-accept-flags.spec.ts asserts together with the Translate tab it does show.
test.skip(process.env['CLAVIS_FORCE_FEATURES'] !== '1', 'needs the forced-flags build');

let h: CardHarness;
let translation: 'latin' | 'arabic' = 'latin';

test.beforeAll(async () => {
  h = await startCardHarness();
  await overrideChat(h.ext.context, async (route, mode) => {
    if (mode !== 'translate' || translation === 'latin') return route.fallback();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chatBody(
        JSON.stringify({
          language: 'Arabic',
          text: 'وقف البنك القديم بجانب النهر.',
          literal: 'وقف المصرف القديم قرب النهر.',
          caveat: null,
        }),
      ),
    });
  });
});
test.afterAll(async () => {
  await h?.close();
});

async function selectSentence(h_: CardHarness, query: string) {
  const opened = await h_.open(`article.html?${query}`);
  await dragSelect(opened.page, opened.page, 'The old bank stood', 'two hundred years.');
  await tb(opened.page).waitShown();
  await tb(opened.page).click('explain');
  const card = cardOf(opened.page);
  await card.waitFor(CARD.ready('core'));
  return { ...opened, card };
}

test('a sentence gets Simplify, Grammar and Translate; each is requested only when opened', async () => {
  const { page, card, dispose } = await selectSentence(h, 'a=1');
  try {
    expect((await card.tabs())?.map((t) => t.label)).toEqual([
      'Core',
      'Simplify',
      'Grammar',
      'Translate',
    ]);
    h.groq.reset();
    await card.click(CARD.tab('grammar'));
    await card.waitFor(CARD.ready('grammar'));
    expect(h.groq.chats()).toHaveLength(1);
    expect(h.groq.chats()[0]?.body?.messages[1]?.content).toContain('(mode: grammar)');
    expect(await card.text(CARD.panel('grammar'))).toContain('Noun, singular.');

    await card.click(CARD.tab('translate'));
    await card.waitFor(CARD.ready('translate'));
    expect(h.groq.chats()).toHaveLength(2);
    // The language comes from the user's setting (English by default), sent as a label.
    expect(h.groq.chats()[1]?.body?.messages[1]?.content).toContain('(mode: translate)');
    const text = (await card.text(CARD.panel('translate'))) ?? '';
    expect(text).toContain('Translation into French');
    expect(text).toContain('la rive');
    // Reopening costs nothing.
    await card.click(CARD.tab('grammar'));
    await card.click(CARD.tab('translate'));
    await page.waitForTimeout(250);
    expect(h.groq.chats()).toHaveLength(2);
  } finally {
    await dispose();
  }
});

test('a right-to-left translation shows in its own direction, with the literal rendering apart', async () => {
  translation = 'arabic';
  const { card, dispose } = await selectSentence(h, 'b=1');
  try {
    await card.click(CARD.tab('translate'));
    await card.waitFor(CARD.ready('translate'));
    const report = await card.toolbar.evalIn<{ labels: string[]; rtl: boolean }>(
      CARD.panel('translate'),
      `function () {
        const labels = Array.from(this.querySelectorAll('.ec__label')).map((e) => e.textContent);
        const body = Array.from(this.querySelectorAll('.ec__field p:not(.ec__label)')).find((e) => e.textContent.includes('وقف البنك'));
        return { labels, rtl: getComputedStyle(body).direction === 'rtl' };
      }`,
    );
    expect(report?.labels).toEqual(['Translation into Arabic', 'Word for word']);
    expect(report?.rtl).toBe(true);
  } finally {
    translation = 'latin';
    await dispose();
  }
});

test('the side panel offers the same two sections and loads them on demand', async () => {
  const { page, card, dispose } = await selectSentence(h, 'c=1');
  try {
    await card.click(CARD.sidePanel);
    await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
    const panel = await openPanelPage(
      h.ext.context,
      h.ext.extensionId,
      await tabIdOf(h.ext.serviceWorker, page),
    );
    const modes = panel.getByTestId('panel-section');
    await expect(modes).toHaveCount(4);
    h.groq.reset();
    await modes.nth(3).getByTestId('panel-load').click();
    await expect(modes.nth(3)).toHaveAttribute('data-status', 'ready');
    expect(h.groq.chats()).toHaveLength(1);
    await expect(modes.nth(3)).toContainText('Translation into French');
    await panel.close();
  } finally {
    await dispose();
  }
});

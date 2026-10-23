import { expect, test, type Page } from '@playwright/test';
import { CARD, cardOf, overrideChat } from './p5-card-support/harness';
import { openPanelPage, tabIdOf } from './p8-sidepanel-support/panel';
import { dblclickText, dragSelect } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import { tagAnswers, type ChatCall, type Control } from './p8-accept-support/answers';
import { setUpKey } from './p8-accept-support/setup';
import { openWebpage, startWorld, type World } from './p8-accept-support/world';

// Phase 8, "language direction, Unicode, accessible text labels" and reduced motion (NFR
// accessibility and localization): right-to-left selections and model answers keep their own
// direction in the card and the side panel, Unicode survives the round trip from the page to the
// request and back, and animation stops when the person asks for reduced motion.
test.describe.configure({ mode: 'serial', timeout: 120_000 });

let world: World;
let calls: ChatCall[];
const control: Control = { variant: 'normal' };

test.beforeAll(async () => {
  world = await startWorld({ granted: true });
  calls = await tagAnswers(world.ext.context, control);
  await setUpKey(world);
  // A page of scripts the fixture set does not have (served by the test, same origin as the others).
  await world.ext.context.route(`${world.server.origin}/p8-unicode.html`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Unicode</title>
        <style>body{font:20px/1.8 'Noto Sans','DejaVu Sans',sans-serif;margin:2rem;max-width:36rem}</style></head><body>
        <p>Naive: la façade de l'église est très belle.</p>
        <p>日本語のテキストを選択します。</p>
        <p lang="he" dir="rtl">הספרייה העתיקה עמדה על גדת הנהר.</p>
        <p>Family 👨‍👩‍👧‍👦 together and Ελληνικά κείμενο here.</p>
        <p>नमस्ते दुनिया, यह एक परीक्षण है।</p>
        </body></html>`,
    }),
  );
});
test.afterAll(async () => {
  await world?.close();
});

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim().normalize('NFC');
const selected = (page: Page): Promise<string> =>
  page.evaluate(() => getSelection()?.toString() ?? '');

test('a right-to-left page: toolbar and card stay on screen; selection and answer each read right-to-left', async () => {
  control.variant = 'rtl';
  const { page, dispose } = await openWebpage(world, 'rtl.html');
  try {
    await page.bringToFront();
    await dblclickText(page, page, 'المكتبة');
    await tb(page).waitShown();
    const picked = norm(await selected(page));
    expect(picked).not.toBe('');
    await tb(page).click('explain');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));

    // On screen, inside the window, at a desktop and a narrow width.
    for (const width of [1000, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.waitForTimeout(200);
      const box = await card.toolbar.box(CARD.card);
      expect(box.x, `card left at ${width}`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `card right at ${width}`).toBeLessThanOrEqual(width);
    }

    const report = await card.toolbar.evalIn<{
      headerDir: string | null;
      headerRtl: boolean;
      answerDirs: string[];
      arabicRtl: boolean;
      mixedLtr: boolean;
    }>(
      '[data-clavis="card"]',
      `function () {
        const header = this.querySelector('[data-clavis="card-text"]');
        const texts = Array.from(this.querySelectorAll('.ec__result p:not(.ec__label), .ec__result li'));
        const find = (needle) => texts.find((el) => el.textContent.includes(needle));
        return {
          headerDir: header.getAttribute('dir'),
          headerRtl: getComputedStyle(header).direction === 'rtl',
          answerDirs: texts.map((el) => el.getAttribute('dir')),
          arabicRtl: getComputedStyle(find('الأرض بجانب')).direction === 'rtl',
          mixedLtr: getComputedStyle(find('Say ')).direction === 'ltr',
        };
      }`,
    );
    expect(report?.headerDir).toBe('auto');
    expect(report?.headerRtl).toBe(true);
    expect(report?.answerDirs.length).toBeGreaterThan(4);
    expect(report?.answerDirs.every((d) => d === 'auto')).toBe(true);
    expect(report?.arabicRtl).toBe(true);
    expect(report?.mixedLtr).toBe(true);

    // The same in the side panel.
    await page.setViewportSize({ width: 1280, height: 720 });
    // Let the card re-place itself after the resize before pressing anything in it.
    await page.waitForTimeout(500);
    await card.waitFor(CARD.ready('core'));
    await card.click(CARD.sidePanel);
    await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
    const panel = await openPanelPage(
      world.ext.context,
      world.ext.extensionId,
      await tabIdOf(world.ext.serviceWorker, page),
    );
    const shown = panel.getByTestId('panel-selected');
    await expect(shown).toHaveAttribute('dir', 'auto');
    expect(await shown.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    const answer = panel
      .getByTestId('panel-section')
      .first()
      .locator('p[dir="auto"], li[dir="auto"]');
    expect(await answer.count()).toBeGreaterThan(4);
    const arabic = panel.getByText('الأرض بجانب النهر.').first();
    expect(await arabic.evaluate((el) => getComputedStyle(el).direction)).toBe('rtl');
    const mixed = panel.getByText('Say ضفة to her.');
    expect(await mixed.evaluate((el) => getComputedStyle(el).direction)).toBe('ltr');
    await panel.close();
  } finally {
    control.variant = 'normal';
    await dispose();
  }
});

for (const [label, probe, to] of [
  ['accented Latin with a combining mark', 'façade'],
  ['Japanese (no spaces)', '日本語'],
  ['Hebrew', 'הספרייה'],
  ['a sentence with an emoji family sequence', 'Family', 'together'],
  ['Greek', 'Ελληνικά'],
  ['Devanagari', 'नमस्ते'],
] as const) {
  test(`Unicode, ${label}: the exact selection reaches the request, the card and the side panel`, async () => {
    const { page, dispose } = await openWebpage(world, 'p8-unicode.html');
    try {
      await page.bringToFront();
      if (to === undefined) await dblclickText(page, page, probe);
      else await dragSelect(page, page, probe, to);
      await tb(page).waitShown();
      const picked = norm(await selected(page));
      expect(picked, 'the browser selected something').not.toBe('');
      calls.length = 0;
      await tb(page).click('explain');
      const card = cardOf(page);
      await card.waitFor(CARD.ready('core'));
      // Request: the selected text (not mangled, not split), as the first-send disclosure promises.
      expect(calls).toHaveLength(1);
      expect(norm(calls[0]?.word ?? '')).toBe(picked);
      // Card header shows it, in its own direction.
      expect(norm((await card.text(CARD.text)) ?? '')).toBe(picked);
      expect(await card.toolbar.attr(CARD.text, 'dir')).toBe('auto');
      // Side panel keeps the whole selection.
      await card.click(CARD.sidePanel);
      await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
      const panel = await openPanelPage(
        world.ext.context,
        world.ext.extensionId,
        await tabIdOf(world.ext.serviceWorker, page),
      );
      expect(norm((await panel.getByTestId('panel-selected').textContent()) ?? '')).toBe(picked);
      await panel.close();
    } finally {
      await dispose();
    }
  });
}

test('reduced motion: nothing in the toolbar, card or side panel animates (and it does animate without the preference)', async () => {
  // Hold the model's answer so the loading spinner stays on screen.
  let release: () => void = () => undefined;
  let hold = true;
  await overrideChat(world.ext.context, async (route) => {
    if (hold) await new Promise<void>((resolve) => (release = resolve));
    await route.fallback();
  });
  const { page, dispose } = await openWebpage(world, 'article.html?motion=1');
  try {
    await page.bringToFront();
    const animations = (): Promise<number | undefined> =>
      cardOf(page).toolbar.evalIn<number>(
        null,
        'function () { return this.getAnimations().length; }',
      );
    for (const motion of ['no-preference', 'reduce'] as const) {
      await page.emulateMedia({ reducedMotion: motion });
      await dblclickText(page, page, 'cartographer');
      await tb(page).waitShown();
      await tb(page).click('explain');
      const card = cardOf(page);
      await card.waitFor('[data-clavis="card-loading"]');
      await page.waitForTimeout(300);
      const running = await animations();
      if (motion === 'no-preference') expect(running, 'the spinner spins').toBeGreaterThan(0);
      else expect(running, 'nothing animates under reduced motion').toBe(0);
      // And the transitions of every element are instant.
      const slow = await card.toolbar.evalIn<string[]>(
        null,
        `function () {
          return Array.from(this.querySelectorAll('*'))
            .filter((el) => { const s = getComputedStyle(el); return parseFloat(s.transitionDuration) > 0.05 && s.transitionProperty !== 'none'; })
            .map((el) => el.className);
        }`,
      );
      if (motion === 'reduce') expect(slow).toEqual([]);
      await page.keyboard.press('Escape');
      await tb(page).waitHidden();
      release();
      hold = motion === 'no-preference';
    }
  } finally {
    hold = false;
    release();
    await dispose();
  }
});

test('reduced motion: the side panel jumps to a section instantly and has no running animation', async () => {
  await setUpKey(world);
  const { page, dispose } = await openWebpage(world, 'article.html?motion=2');
  try {
    await page.bringToFront();
    await dblclickText(page, page, 'cartographer');
    await tb(page).waitShown();
    await tb(page).click('explain');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    await card.click(CARD.sidePanel);
    await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
    const panel = await openPanelPage(
      world.ext.context,
      world.ext.extensionId,
      await tabIdOf(world.ext.serviceWorker, page),
    );
    await panel.setViewportSize({ width: 400, height: 300 });
    await panel.emulateMedia({ reducedMotion: 'reduce' });
    await expect(panel.getByTestId('panel-section').first()).toHaveAttribute(
      'data-status',
      'ready',
    );
    const last = panel.getByTestId('panel-nav').last();
    await last.click();
    // Instant: the heading is at the top of the window almost at once (a smooth scroll is not).
    const heading = panel.locator('[data-testid="panel-section"]').last().locator('h2');
    await expect
      .poll(() => heading.evaluate((el) => Math.round(el.getBoundingClientRect().top)), {
        timeout: 400,
        intervals: [50],
      })
      .toBeLessThanOrEqual(120);
    expect(await panel.evaluate(() => document.getAnimations().length)).toBe(0);
    await panel.close();
  } finally {
    await dispose();
  }
});

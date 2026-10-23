import { expect, test, type Page } from '@playwright/test';
import { CARD, cardOf } from './p5-card-support/harness';
import { dblclickText } from './spike-b-support/page';
import { SEL, tb } from './spike-b-support/toolbar';
import { openPanelPage, tabIdOf } from './p8-sidepanel-support/panel';
import { axePage, axeToolbarRoot, contrastProblemsInRoot } from './p8-accept-support/axe';
import { tagAnswers, type Control } from './p8-accept-support/answers';
import { setUpKey } from './p8-accept-support/setup';
import { openWebpage, startWorld, type World } from './p8-accept-support/world';

// Phase 8, accessibility sweep (NFR accessibility, FR-016, UJ usability row of the test matrix):
// axe in light and dark at 1000, 360 and 320 px on the card (the production DOM inside its closed
// shadow root: see p8-accept-support/axe.ts), the side panel and every extension page; text
// contrast of the card computed on its real styles (axe cannot decide it inside a shadow root);
// and no horizontal scroll or off-screen card at narrow widths.
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const WIDTHS = [1000, 360, 320] as const;
const SCHEMES = ['light', 'dark'] as const;
let world: World;
const control: Control = { variant: 'normal' };

test.beforeAll(async () => {
  world = await startWorld({ granted: true });
  await tagAnswers(world.ext.context, control);
  // The key is stored but the data notice is not acknowledged: the first card asks (first-send state).
  await setUpKey(world, { acknowledged: false });
});
test.afterAll(async () => {
  await world?.close();
});

/** Audit the open card at every scheme and width. */
async function auditCard(page: Page, label: string): Promise<void> {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 700 });
      await page.waitForTimeout(200);
      const at = `${label}, ${scheme}, ${width}px`;
      expect(await axeToolbarRoot(page, page), `axe: ${at}`).toEqual([]);
      expect(await contrastProblemsInRoot(page), `contrast: ${at}`).toEqual([]);
      const box = await cardOf(page).toolbar.box(CARD.card);
      expect(box.x, `card left: ${at}`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `card right: ${at}`).toBeLessThanOrEqual(width);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `horizontal scroll: ${at}`,
      ).toBeLessThanOrEqual(width);
    }
  }
  await page.setViewportSize({ width: 1280, height: 720 });
}

async function explainOn(page: Page, word: string) {
  await page.bringToFront();
  await dblclickText(page, page, word);
  await tb(page).waitShown();
  await tb(page).click('explain');
  const card = cardOf(page);
  await card.waitFor(CARD.card);
  return card;
}

test('card: the first-send question, then the answer, a long answer and both error kinds are accessible', async () => {
  // 1 first-send question (before anything is sent)
  let session = await openWebpage(world, 'article.html?a=1');
  let card = await explainOn(session.page, 'cartographer');
  await card.waitFor(CARD.disclosure);
  await auditCard(session.page, 'first-send question');
  await session.page.waitForTimeout(600);
  await card.click(CARD.confirm);
  await card.waitFor(CARD.ready('core'));
  // 2 the answer, with its tabs
  await auditCard(session.page, 'answer');
  await card.click(CARD.tab('etymology'));
  await card.waitFor(CARD.ready('etymology'));
  await auditCard(session.page, 'answer, Roots tab');
  await session.dispose();

  // 3 a long answer
  control.variant = 'long';
  session = await openWebpage(world, 'article.html?a=2');
  card = await explainOn(session.page, 'cartographer');
  await card.waitFor(CARD.ready('core'));
  await card.waitFor(CARD.longHint);
  await auditCard(session.page, 'long answer');
  await session.dispose();
  control.variant = 'normal';

  // 4 rejected key, 5 rate limit (countdown running)
  control.fail = { status: 401 };
  session = await openWebpage(world, 'article.html?a=3');
  card = await explainOn(session.page, 'cartographer');
  await card.waitFor(CARD.error);
  await auditCard(session.page, 'error: key rejected');
  await session.dispose();

  control.fail = { status: 429, retryAfter: '120' };
  session = await openWebpage(world, 'article.html?a=4');
  card = await explainOn(session.page, 'cartographer');
  await card.waitFor(CARD.error);
  await auditCard(session.page, 'error: rate limit');
  await session.dispose();
  control.fail = undefined;
});

test('the toolbar with the Listen note is accessible too', async () => {
  const { page, dispose } = await openWebpage(world, 'article.html?a=5');
  await page.bringToFront();
  await dblclickText(page, page, 'cartographer');
  await tb(page).waitShown();
  await tb(page).click('listen');
  await page.waitForTimeout(1500);
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    expect(await axeToolbarRoot(page, page), `toolbar ${scheme}`).toEqual([]);
    expect(await contrastProblemsInRoot(page), `toolbar contrast ${scheme}`).toEqual([]);
  }
  await dispose();
});

test('side panel: empty, loaded, loading error and long answer are accessible', async () => {
  // Re-store the key (the 401 flagged it) and give the panel something to show.
  await setUpKey(world);
  control.variant = 'long';
  const { page, dispose } = await openWebpage(world, 'article.html?p=1');
  const card = await explainOn(page, 'cartographer');
  await card.waitFor(CARD.ready('core'));
  const tabId = await tabIdOf(world.ext.serviceWorker, page);

  // Empty panel for a tab with nothing held
  const empty = await openPanelPage(world.ext.context, world.ext.extensionId, 999_999);
  await expect(empty.getByTestId('panel-empty')).toBeVisible();

  await card.click(CARD.sidePanel);
  await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
  const panel = await openPanelPage(world.ext.context, world.ext.extensionId, tabId);
  await expect(panel.getByTestId('panel-selected')).toHaveText('cartographer');
  control.fail = { status: 401 };
  await panel.getByTestId('panel-load').first().click();
  await expect(panel.getByTestId('panel-error')).toBeVisible();

  for (const [name, target] of [
    ['empty', empty],
    ['loaded with a long answer and a failed section', panel],
  ] as const) {
    for (const scheme of SCHEMES) {
      await target.emulateMedia({ colorScheme: scheme });
      for (const width of WIDTHS) {
        await target.setViewportSize({ width, height: 700 });
        const at = `panel ${name}, ${scheme}, ${width}px`;
        expect(await axePage(target), `axe: ${at}`).toEqual([]);
        expect(
          await target.evaluate(() => document.documentElement.scrollWidth),
          `horizontal scroll: ${at}`,
        ).toBeLessThanOrEqual(width);
      }
    }
  }
  control.fail = undefined;
  control.variant = 'normal';
  await empty.close();
  await panel.close();
  await dispose();
});

test('toolbar action buttons are touch-sized and visible focus rings exist', async () => {
  const { page, dispose } = await openWebpage(world, 'article.html?f=1');
  await page.bringToFront();
  await dblclickText(page, page, 'cartographer');
  await tb(page).waitShown();
  for (const action of ['listen', 'explain'] as const) {
    const box = await tb(page).box(SEL.action(action));
    expect(box.height, action).toBeGreaterThanOrEqual(32);
    expect(box.width, action).toBeGreaterThanOrEqual(44);
  }
  await tb(page).focusAction('explain');
  const ring = await tb(page).evalIn<{ style: string; width: number }>(
    SEL.action('explain'),
    `function () { const s = getComputedStyle(this); return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) }; }`,
  );
  expect(ring?.style).not.toBe('none');
  expect(ring?.width).toBeGreaterThanOrEqual(2);
  await dispose();
});

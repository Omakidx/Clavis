import { expect, test, type Frame, type Page } from '@playwright/test';
import { CARD, cardOf } from './p5-card-support/harness';
import { machineHasVoices } from './p7-reader-support/ai';
import { dblclickText } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import { tagAnswers } from './p8-accept-support/answers';
import { setUpKey } from './p8-accept-support/setup';
import { openWebpage, startWorld, type World } from './p8-accept-support/world';

// Phase 8 acceptance, confirmed product defects. Each test asserts what the product SHOULD do and is
// marked test.fail while the defect existed. P1, P2 and P4 are fixed (their test.fail is gone); P3 (the
// privacy-policy placeholder URL, p8-accept-placeholders.spec.ts) is still open until Phase 10.
// The write-up with severity is docs/decisions/p8-acceptance.md.
test.describe.configure({ mode: 'serial', timeout: 90_000 });

let world: World;
let noVoices = false;

test.beforeAll(async () => {
  world = await startWorld({ granted: true });
  await tagAnswers(world.ext.context);
  await setUpKey(world);
  noVoices = !(await machineHasVoices(world.ext.context, world.ext.extensionId));
});
test.afterAll(async () => {
  await world?.close();
});

/** Every action of the open card lies inside the visible part of the window it is drawn in. */
async function cardActionsReachable(
  page: Page,
  target: Page | Frame,
  size: { width: number; height: number },
): Promise<string[]> {
  const card = cardOf(page, target);
  const outside: string[] = [];
  for (const [name, selector] of [
    ['Close', CARD.close],
    ['Copy', CARD.copy],
    ['Open in side panel', CARD.sidePanel],
  ] as const) {
    const box = await card.toolbar.box(selector);
    if (box.y < 0 || box.y + box.height > size.height || box.x + box.width > size.width) {
      outside.push(
        `${name} at y=${Math.round(box.y)}..${Math.round(box.y + box.height)} of ${size.height}`,
      );
    }
  }
  return outside;
}

// (Fixed) P1: after Listen shows its "Voice isn't available" note, pressing Explain stacks the card
// under it, and Copy and Open in side panel land below the visible window.
// Repro: no on-device voice (Linux without speech-dispatcher); open any web page in a 1000x450 window;
// double-click a word; press Listen, then Explain; the card's footer is at y=510..538 of 450.
// Same cause on the practice page (see the next test), where the article frame is only 313 px tall
// and clips the card, so the buttons cannot be pressed at all.
test('P1a: web page, short window: Listen note + card keep Copy and Open in side panel on screen', async () => {
  test.skip(!noVoices, 'needs the no-voice note (this machine has voices)');
  const { page, dispose } = await openWebpage(world, 'article.html?p1=a');
  try {
    await page.bringToFront();
    await page.setViewportSize({ width: 1000, height: 450 });
    await dblclickText(page, page, 'The');
    await tb(page).waitShown();
    await tb(page).click('listen');
    await page.waitForTimeout(1200);
    await tb(page).click('explain');
    await cardOf(page).waitFor(CARD.ready('core'));
    await page.waitForTimeout(400);
    expect(await cardActionsReachable(page, page, { width: 1000, height: 450 })).toEqual([]);
  } finally {
    await dispose();
  }
});

test('P1b: practice page: Listen note + card keep Copy and Open in side panel inside the article frame', async () => {
  test.skip(!noVoices, 'needs the no-voice note (this machine has voices)');
  const page = await world.ext.context.newPage();
  try {
    await page.goto(`chrome-extension://${world.ext.extensionId}/practice.html`);
    await expect.poll(() => page.frames().some((f) => f.url() === 'about:srcdoc')).toBe(true);
    const frame = page.frames().find((f) => f.url() === 'about:srcdoc') as Frame;
    await frame.waitForSelector('article p');
    await dblclickText(page, frame, 'ice');
    await tb(frame).waitShown();
    await tb(frame).click('listen');
    await page.waitForTimeout(1200);
    await tb(frame).click('explain');
    await cardOf(page, frame).waitFor(CARD.ready('core'));
    await page.waitForTimeout(400);
    const size = await frame.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    expect(await cardActionsReachable(page, frame, size)).toEqual([]);
  } finally {
    await page.close();
  }
});

// (Fixed) P2: the practice page always says "No Groq key yet? Listen works without one. Explain will
// show you how to connect Groq." even when a key is connected (the same sentence in the setup wizard
// is hidden once a key exists). Repro: connect a key, open the practice page.
test('P2: the practice page does not say "No Groq key yet?" once a key is connected', async () => {
  const page = await world.ext.context.newPage();
  await page.goto(`chrome-extension://${world.ext.extensionId}/practice.html`);
  await expect(page.getByRole('heading', { name: 'Clavis practice page' })).toBeVisible();
  await expect(page.getByText(/No Groq key yet\?/)).toHaveCount(0);
  await page.close();
});

// (Fixed) P4 (copy gap): the help for people without website access says "click the Clavis icon", but
// Chrome keeps a new extension's icon inside the Extensions (puzzle-piece) menu until it is pinned,
// and nowhere does the help say so. Repro: read Settings > Website access (or the end of setup) on a
// fresh Chrome; the icon sentence has no mention of the Extensions menu or of pinning.
test('P4: the help says where the Clavis icon is (Extensions menu / pin)', async () => {
  // Website access not granted: the only state in which Settings shows this help.
  const declined = await startWorld({ granted: false });
  try {
    const page = await declined.ext.context.newPage();
    await page.goto(
      `chrome-extension://${declined.ext.extensionId}/options.html#section-site-access`,
    );
    const help = page.getByTestId('site-access-help').first();
    await expect(help).toBeVisible();
    const sentence = await help.locator('li', { hasText: 'click the Clavis icon' }).innerText();
    expect(sentence).toMatch(/extensions menu|puzzle|pin/i);
  } finally {
    await declined.close();
  }
});

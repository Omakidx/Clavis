import type { Frame, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { openExtensionPage } from './p3-ui-support/pages';
import { CARD, cardOf } from './p5-card-support/harness';
import { tb } from './spike-b-support/toolbar';

// The practice page mounts the real selection observer and toolbar. Listen and Explain need
// the background routes (TTS_SPEAK, AI_EXPLAIN, OPEN_SETTINGS); Explain draws the shared card.

async function articleFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url() === 'about:srcdoc')).toBe(true);
  const frame = page.frames().find((f) => f.url() === 'about:srcdoc') as Frame;
  await frame.waitForSelector('article p');
  return frame;
}

/** A real (trusted) double-click on a word of the article: the browser selects it. */
async function selectWord(page: Page, frame: Frame, word: string, occurrence = 0) {
  const center = await frame.evaluate(
    ({ word, occurrence }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let seen = 0;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? '';
        let at = text.indexOf(word);
        while (at !== -1) {
          if (seen === occurrence) {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + word.length);
            const r = range.getBoundingClientRect();
            return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
          }
          seen += 1;
          at = text.indexOf(word, at + 1);
        }
      }
      return null;
    },
    { word, occurrence },
  );
  if (center === null) throw new Error(`word not found: ${word}`);
  const box = await (await frame.frameElement()).boundingBox();
  await page.mouse.dblclick((box?.x ?? 0) + center.x, (box?.y ?? 0) + center.y);
}

test.describe('practice page', () => {
  test('a real mouse selection shows the toolbar; Explain without a key says how to connect Groq', async ({
    context,
    extensionId,
  }) => {
    const { page, errors } = await openExtensionPage(context, extensionId, 'practice');
    const frame = await articleFrame(page);
    await expect(frame.locator('article')).toContainText('They sat on the bank of the river');
    await expect(frame.locator('article')).toContainText('She finally broke the ice.');

    await selectWord(page, frame, 'bank');
    await tb(frame).waitShown();
    await tb(frame).click('explain');

    // Phase 5: the practice page uses the same explanation card as a web page. It lives in the
    // toolbar's closed shadow root inside the article frame, so it is read through the probe.
    const card = cardOf(page, frame);
    await card.waitFor(CARD.error);
    expect(await card.text(CARD.error)).toContain('Connect your Groq key to use Explain.');
    expect(await card.text(CARD.settings)).toBe('Connect Groq');

    const settings = context.waitForEvent('page');
    await card.click(CARD.settings);
    await (await settings).waitForURL(/\/options\.html#section-key$/);
    expect(errors).toEqual([]);
  });

  test('Listen works without a key: it starts speaking or explains that no voice is available', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openExtensionPage(context, extensionId, 'practice');
    const frame = await articleFrame(page);
    await selectWord(page, frame, 'bank', 1);
    await tb(frame).waitShown();
    await tb(frame).click('listen');
    // CI and this Linux dev machine have no voices (docs/decisions/spike-d-voices.md): either is correct.
    await expect(page.locator('main')).toContainText(
      /Reading aloud|isn.t available on this device|The voice didn.t start/,
      {
        timeout: 15_000,
      },
    );
  });

  test('the keyboard path opens the toolbar for the current selection, and Escape closes it', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openExtensionPage(context, extensionId, 'practice');
    const frame = await articleFrame(page);
    await page.getByRole('button', { name: 'Show the toolbar for my selection' }).click();
    await expect(page.getByText('Select some text in the article first.')).toBeVisible();

    await selectWord(page, frame, 'ice');
    await tb(frame).waitShown();
    await page.keyboard.press('Escape');
    await tb(frame).waitHidden();
  });
});

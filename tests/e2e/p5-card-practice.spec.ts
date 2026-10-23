import type { Frame, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { openExtensionPage } from './p3-ui-support/pages';
import { CARD, cardOf, startCardHarness, type CardHarness } from './p5-card-support/harness';
import { tb } from './spike-b-support/toolbar';

// Phase 5: the practice page runs the SAME card as a web page, inside its about:srcdoc frame, so
// the demo behaves like the real thing (lazy tabs included) when a key is connected.
let h: CardHarness;
test.beforeAll(async () => {
  h = await startCardHarness();
});
test.afterAll(async () => {
  await h?.close();
});

async function articleFrame(page: Page): Promise<Frame> {
  await expect.poll(() => page.frames().some((f) => f.url() === 'about:srcdoc')).toBe(true);
  const frame = page.frames().find((f) => f.url() === 'about:srcdoc') as Frame;
  await frame.waitForSelector('article p');
  return frame;
}

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

test('with a key the practice page shows the real card: core answer, lazy Roots, cache', async () => {
  const { page, errors } = await openExtensionPage(h.ext.context, h.ext.extensionId, 'practice');
  const frame = await articleFrame(page);
  h.groq.reset();
  await selectWord(page, frame, 'bank');
  await tb(frame).waitShown();
  // Nothing is sent by selecting (FR-017).
  expect(h.groq.chats()).toHaveLength(0);
  await tb(frame).click('explain');
  const card = cardOf(page, frame);
  await card.waitFor(CARD.ready('core'));
  expect(h.groq.chats()).toHaveLength(1);
  expect(await card.text(CARD.text)).toBe('bank');
  expect(await card.text(CARD.panel('core'))).toContain('Examples written by AI');

  await card.click(CARD.tab('etymology'));
  await card.waitFor(CARD.ready('etymology'));
  expect(h.groq.chats()).toHaveLength(2);
  await card.click(CARD.tab('core'));
  await card.click(CARD.tab('etymology'));
  await page.waitForTimeout(300);
  expect(h.groq.chats()).toHaveLength(2);

  // The old result panel no longer reports Explain.
  await expect(page.getByTestId('explain-result')).toHaveCount(0);
  await expect(page.getByText('Explanations open in a card next to your selection.')).toBeVisible();
  expect(errors).toEqual([]);
});

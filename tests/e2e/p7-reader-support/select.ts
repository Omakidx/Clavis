import { expect, type Page } from '@playwright/test';
import { waitForRendersToSettle } from './helpers';

/** Centre of the first occurrence of `word` in the text layer of `pageNumber`, in viewport pixels. */
async function wordCentre(page: Page, word: string, pageNumber: number) {
  return page.evaluate(
    ({ word, pageNumber }) => {
      const layer = document.querySelector(`.page[data-page-number="${pageNumber}"] .textLayer`);
      if (!layer) throw new Error(`no text layer on page ${pageNumber}`);
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = (node.textContent ?? '').indexOf(word);
        if (at === -1) continue;
        (node.parentElement as HTMLElement).scrollIntoView({ block: 'center', inline: 'center' });
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      throw new Error(`word not found: ${word}`);
    },
    { word, pageNumber },
  );
}

/**
 * A real (trusted) double-click on `word`: the browser selects it, exactly as a user would.
 * Waits for the viewer to be idle first (a half-rendered text layer gives a short selection).
 */
export async function selectWordByDoubleClick(
  page: Page,
  word: string,
  pageNumber = 1,
): Promise<void> {
  await waitForRendersToSettle(page, { quietMs: 400 });
  const { x, y } = await wordCentre(page, word, pageNumber);
  await page.mouse.dblclick(x, y);
  await expect
    .poll(() => page.evaluate(() => document.getSelection()?.toString().trim() ?? ''))
    .toBe(word);
}

/** Go to a page with the page box and wait until it is drawn. */
export async function gotoPage(page: Page, pageNumber: number): Promise<void> {
  const input = page.getByTestId('page-input');
  await input.fill(String(pageNumber));
  await input.press('Enter');
  await expect(
    page.locator(`.page[data-page-number="${pageNumber}"] canvas`).first(),
  ).toBeVisible();
  await expect(
    page.locator(`.page[data-page-number="${pageNumber}"] .textLayer span`).first(),
  ).toBeAttached();
}

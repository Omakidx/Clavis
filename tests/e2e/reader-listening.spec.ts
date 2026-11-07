import { expect, test } from './fixtures';
import { finishAudio, installScriptedTts, scriptedCalls } from './p6-listen-support/listen';
import {
  loadFixture,
  openReader,
  renderCount,
  setZoom,
  waitForPhase,
  waitForRendersToSettle,
} from './p7-reader-support/helpers';

const speakMessages = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    (
      window as unknown as { __clavisSent: { type: string; text?: string; requestId?: string }[] }
    ).__clavisSent.filter((message) => message.type === 'TTS_SPEAK'),
  );

const paintedText = (page: import('@playwright/test').Page, name: string) =>
  page.evaluate(
    (key) =>
      Array.from(CSS.highlights?.get(key) ?? [], (range) => (range as Range).toString()).join(''),
    name,
  );

async function selectFirstSpanText(page: import('@playwright/test').Page, phrase: string) {
  await page
    .locator('.page[data-page-number="1"] .textLayer span')
    .filter({ hasText: phrase })
    .first()
    .evaluate((span, phrase) => {
      const node = span.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE)
        throw new Error('fixture span has no text node');
      const text = node.textContent ?? '';
      const start = text.indexOf(phrase);
      if (start < 0) throw new Error(`phrase not found in first span: ${phrase}`);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, start + phrase.length);
      selection.addRange(range);
    }, phrase);
}

test.describe.configure({ timeout: 120_000 });

test('selected PDF text plays, pause resumes from a word boundary, and stop cancels the run', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  await installScriptedTts(serviceWorker);
  const { page } = await openReader(context, extensionId, { width: 412, height: 519 });
  await loadFixture(page, 'text-1page.pdf');
  await waitForPhase(page, 'ready');
  await expect(page.getByTestId('reader-playback')).toBeVisible();
  await expect(page.locator('.reader-highlights summary')).toBeVisible();
  const mobileViewerHeight = await page
    .getByTestId('viewer-container')
    .evaluate((el) => el.clientHeight);
  expect(mobileViewerHeight).toBeGreaterThanOrEqual(180);
  await page.screenshot({ path: '/tmp/clavis-pdf-reader-mobile.png', fullPage: true });
  await expect(page.locator('.page[data-page-number="1"] .textLayer span').first()).toBeAttached();
  await selectFirstSpanText(page, 'The quick');
  await page.getByTestId('reader-listen-scope').selectOption('selection');
  await page.getByTestId('reader-listen-play').click();
  await expect(page.locator('.reader-playback__status')).toContainText('Reading', {
    timeout: 10_000,
  });
  await expect.poll(async () => (await scriptedCalls(serviceWorker)).length).toBeGreaterThan(0);
  const spoken = await speakMessages(page);
  expect(spoken[0]?.text).toBe('The quick');

  // The real page listener accepts a background word boundary for this active request.
  const requestId = spoken[0]!.requestId!;
  await serviceWorker.evaluate(async (id) => {
    await chrome.runtime.sendMessage({
      v: 1,
      type: 'TTS_BOUNDARY',
      requestId: id,
      charIndex: 4,
      length: 5,
    });
  }, requestId);
  await expect.poll(() => paintedText(page, 'reader-narration-word')).toBe('quick');
  await page.getByTestId('reader-listen-pause').click();
  await expect(page.locator('.reader-playback__status')).toContainText('Paused');
  await page.getByTestId('reader-listen-resume').click();
  await expect.poll(async () => (await speakMessages(page)).length).toBe(2);
  expect((await speakMessages(page))[1]?.text).toBe('quick');
  await page.getByTestId('reader-listen-stop').click();
  await expect(page.locator('.reader-playback__status')).toContainText('Ready to listen');
  await expect(page.getByTestId('reader-listen-play')).toBeVisible();
  await page.close();
});

test('color marks survive zoom and reopening the same PDF with the reader at a narrow viewport', async ({
  context,
  extensionId,
}) => {
  const { page } = await openReader(context, extensionId, { width: 412, height: 519 });
  await loadFixture(page, 'text-1page.pdf');
  await waitForPhase(page, 'ready');
  await expect(page.locator('.page[data-page-number="1"] .textLayer span').first()).toBeAttached();
  await page.locator('.reader-highlights summary').click();
  await selectFirstSpanText(page, 'The quick');
  await page.getByRole('button', { name: 'Highlight in blue' }).click();
  await expect(page.locator('.reader-highlights__list li')).toHaveCount(1);
  await expect(page.locator('.reader-highlights__status')).toContainText('saved');

  const rendered = await renderCount(page);
  await setZoom(page, '1.25');
  await waitForRendersToSettle(page, { since: rendered });
  await expect.poll(() => paintedText(page, 'clavis-pdf-mark-blue')).toBe('The quick');

  // Find replaces text nodes. Saved marks must be re-projected onto the new nodes.
  await page.getByTestId('find-toggle').click();
  await page.getByTestId('find-input').fill('quick');
  await expect(page.getByTestId('find-status')).toContainText('of');
  await expect.poll(() => paintedText(page, 'clavis-pdf-mark-blue')).toBe('The quick');
  await page.getByTestId('find-input').fill('');
  await expect.poll(() => paintedText(page, 'clavis-pdf-mark-blue')).toBe('The quick');

  await page.getByRole('button', { name: 'Close PDF' }).click();
  await waitForPhase(page, 'empty');
  await loadFixture(page, 'text-1page.pdf');
  await waitForPhase(page, 'ready');
  await page.locator('.reader-highlights summary').click();
  await expect(page.locator('.reader-highlights__list li')).toHaveCount(1);
  await expect.poll(() => paintedText(page, 'clavis-pdf-mark-blue')).toBe('The quick');
  await page.close();
});

test('whole-document playback advances only after each mocked utterance ends', async ({
  context,
  extensionId,
  serviceWorker,
}) => {
  await installScriptedTts(serviceWorker);
  const { page } = await openReader(context, extensionId, { width: 1071, height: 700 });
  await loadFixture(page, 'text-100pages.pdf');
  await waitForPhase(page, 'ready');
  await expect(page.getByTestId('reader-playback')).toBeVisible();
  await expect(page.locator('.reader-highlights summary')).toBeVisible();
  await page.screenshot({ path: '/tmp/clavis-pdf-reader-desktop.png', fullPage: true });
  await page.getByTestId('reader-listen-play').click();
  await expect(page.locator('.reader-playback__status')).toContainText('Reading', {
    timeout: 10_000,
  });
  await expect.poll(async () => (await speakMessages(page)).length).toBe(1);
  const sent = await page.evaluate(
    () =>
      (window as unknown as { __clavisSent: { type: string; requestId?: string }[] }).__clavisSent,
  );
  expect(sent.filter((message) => message.type === 'TTS_SPEAK')).toHaveLength(1);
  // Pages can contain multiple paragraph utterances. Finish each one until a later page appears.
  for (let utterances = 1; utterances <= 100; utterances++) {
    const status = (await page.locator('.reader-playback__status').textContent()) ?? '';
    if (/Reading page ([2-9]|[1-9]\d+) of 100/.test(status)) break;
    const before = (await speakMessages(page)).length;
    await finishAudio(serviceWorker);
    await expect.poll(async () => (await speakMessages(page)).length).toBeGreaterThan(before);
  }
  await expect(page.locator('.reader-playback__status')).toContainText('Reading page 2 of 100');
  await page.getByTestId('reader-listen-stop').click();
  await page.close();
});

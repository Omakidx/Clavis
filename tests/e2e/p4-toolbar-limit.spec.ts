import { expect, test, type Page } from '@playwright/test';
import { dragSelect, selectedText, textBox } from './spike-b-support/page';
import { SEL, tb } from './spike-b-support/toolbar';
import { activeTabId, startHarness, type Harness } from './p4-toolbar-support/harness';

// Over-limit selections (requirements 4.2): "Selection too long" with one action, "Use the first
// 2,000 characters", which shows the trimmed text and sends nothing; word-boundary aware.
let h: Harness;

test.beforeAll(async () => {
  h = await startHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** Drag from "preamble" (before the long paragraph) to "epilogue" (after it): about 3,700 characters. */
async function selectTooLong(page: Page): Promise<string> {
  await dragSelect(page, page, 'preamble', 'epilogue');
  await tb(page).waitShown();
  return normalize(await selectedText(page));
}

test('a selection over the limit shows "Selection too long" and one action', async () => {
  const { page, dispose } = await h.open('long.html');
  try {
    const full = await selectTooLong(page);
    expect(full.length).toBeGreaterThan(2000);

    expect(await tb(page).text(SEL.limit)).toContain('Selection too long');
    expect(await tb(page).text(SEL.action('trim'))).toBe('Use the first 2,000 characters');
    expect(await tb(page).attr(SEL.panel, 'data-mode')).toBe('too-long');
    // One action: no Listen, no Explain, nothing else to press.
    expect(await tb(page).isShown(SEL.action('listen'))).toBe(false);
    expect(await tb(page).isShown(SEL.action('explain'))).toBe(false);
    expect(
      await tb(page).evalIn<number>(
        null,
        `function () { return this.querySelectorAll('button').length; }`,
      ),
    ).toBe(1);
    // The selection fills the viewport: the toolbar stays inside it.
    const box = await tb(page).box();
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

    // The polite live region says so (after a beat, so screen readers announce the change).
    await expect
      .poll(() => tb(page).live())
      .toBe('Selection too long. Choose Use the first 2,000 characters to continue.');
  } finally {
    await dispose();
  }
});

test('trimming cuts on a word boundary, shows the text and the length, and offers Listen and Explain', async () => {
  const { page, dispose } = await h.open('long.html');
  try {
    const full = await selectTooLong(page);
    await tb(page).click('trim');
    await tb(page).waitShown(SEL.trimmed);

    const shown = (await tb(page).text(SEL.trimmedText)) ?? '';
    expect(shown.length).toBeLessThanOrEqual(2000);
    expect(shown.length).toBeGreaterThan(1900);
    expect(full.startsWith(shown)).toBe(true);
    // Cut at a word boundary: the next character of the selection is a space.
    expect(full.charAt(shown.length)).toBe(' ');
    expect(await tb(page).text(SEL.trimmed)).toContain(
      `Using the first ${shown.length.toLocaleString('en-US')} characters`,
    );
    await expect
      .poll(() => tb(page).live())
      .toBe(`Using the first ${shown.length.toLocaleString('en-US')} characters`);

    // The toolbar is the normal one again, for the trimmed text.
    expect(await tb(page).attr(SEL.panel, 'data-mode')).toBe('actions');
    await tb(page).click('explain');
    await tb(page).waitShown(SEL.card);
    expect(await tb(page).text(SEL.cardText)).toBe(shown.slice(0, 200));
    // The page selection was left alone.
    expect(normalize(await selectedText(page))).toBe(full);
  } finally {
    await dispose();
  }
});

test('trimming sends nothing: no Groq request, no request beyond the fixture itself (FR-017)', async () => {
  const { page, dispose } = await h.open('long.html');
  const before = h.server.requests.length;
  try {
    await selectTooLong(page);
    await tb(page).click('trim');
    await tb(page).waitShown(SEL.trimmed);
    await tb(page).click('listen');
    await tb(page).click('explain');
    await page.waitForTimeout(300);
    expect(h.groqRequests).toEqual([]);
    expect(
      h.server.requests
        .slice(before)
        .every((path) => path.endsWith('.html') || path === '/favicon.ico'),
    ).toBe(true);
  } finally {
    await dispose();
  }
});

test('keyboard: focus lands on the one action, Enter trims, focus moves on to Listen', async () => {
  const { page, dispose } = await h.open('long.html');
  try {
    await selectTooLong(page);
    const tabId = await activeTabId(h.ext);
    await h.ext.serviceWorker.evaluate(
      ({ id }) =>
        chrome.tabs.sendMessage(
          id,
          { v: 1, type: 'CLAVIS_OPEN_SELECTION', focus: true },
          { frameId: 0 },
        ),
      { id: tabId },
    );
    await expect.poll(() => tb(page).focusedAction()).toBe('trim');
    await page.keyboard.press('Enter');
    await tb(page).waitShown(SEL.trimmed);
    await expect.poll(() => tb(page).focusedAction()).toBe('explain');
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
  } finally {
    await dispose();
  }
});

test('Ctrl+A on a long page: too-long state, inside the viewport, trimmed text starts at the top of the page', async () => {
  const { page, dispose } = await h.open('long.html');
  try {
    await page.keyboard.press('Control+a');
    await tb(page).waitShown();
    expect(await tb(page).attr(SEL.panel, 'data-mode')).toBe('too-long');
    const box = await tb(page).box();
    const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);

    await tb(page).click('trim');
    await tb(page).waitShown(SEL.trimmed);
    expect(
      ((await tb(page).text(SEL.trimmedText)) ?? '').startsWith('Selections longer than the limit'),
    ).toBe(true);
  } finally {
    await dispose();
  }
});

test('a selection just under the limit is not "too long"', async () => {
  const { page, dispose } = await h.open('long.html');
  try {
    // About 1,000 characters: the long paragraph's first words only.
    const start = await textBox(page, 'word0');
    const end = await textBox(page, 'word110');
    await page.mouse.move(start.x + 1, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(end.x + end.width - 1, end.y + end.height / 2, { steps: 6 });
    await page.mouse.up();
    await tb(page).waitShown();
    expect(await tb(page).attr(SEL.panel, 'data-mode')).toBe('actions');
    expect(await tb(page).isShown(SEL.limit)).toBe(false);
  } finally {
    await dispose();
  }
});

test('the too-long state fits a 320 px wide viewport', async () => {
  const { page, dispose } = await h.open('long.html');
  try {
    await page.setViewportSize({ width: 320, height: 568 });
    await page.reload();
    await page.keyboard.press('Control+a');
    await tb(page).waitShown();
    const box = await tb(page).box(SEL.panel);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    ).toBe(true);
  } finally {
    await dispose();
  }
});

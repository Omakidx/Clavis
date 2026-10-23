import { expect, test } from './fixtures';
import {
  canvasStats,
  fixturePath,
  openFindBar,
  openFixtureReady,
  openReader,
  waitForPhase,
  waitForRendersToSettle,
} from './p7-reader-support/helpers';

// FR-050, FR-054, FR-057: shell controls, keyboard shortcuts, find, and what the reader forgets.
test.describe.configure({ timeout: 120_000 });

const currentPage = (page: import('@playwright/test').Page) =>
  page.getByTestId('page-input').inputValue();

test.describe('keyboard shortcuts', () => {
  test('focus lands on the pages after opening; n/p/j/k, Ctrl+Home/End, PageUp/PageDown and Home/End work', async ({
    context,
    extensionId,
  }) => {
    const { page, problems } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-100pages.pdf');
    const viewer = page.getByTestId('viewer-container');
    await expect(viewer).toBeFocused();

    await page.keyboard.press('n');
    await expect.poll(() => currentPage(page)).toBe('2');
    await page.keyboard.press('j');
    await expect.poll(() => currentPage(page)).toBe('3');
    await page.keyboard.press('p');
    await expect.poll(() => currentPage(page)).toBe('2');
    await page.keyboard.press('k');
    await expect.poll(() => currentPage(page)).toBe('1');

    await page.keyboard.press('Control+End');
    await expect.poll(() => currentPage(page)).toBe('100');
    await page.keyboard.press('Control+Home');
    await expect.poll(() => currentPage(page)).toBe('1');

    // PageDown scrolls by most of a screenful (90% of the viewer), PageUp scrolls back.
    const metrics = await viewer.evaluate((el) => ({ top: el.scrollTop, height: el.clientHeight }));
    await page.keyboard.press('PageDown');
    await expect
      .poll(() => viewer.evaluate((el) => Math.round(el.scrollTop - 0)))
      .toBeGreaterThan(metrics.top + metrics.height * 0.8);
    await page.keyboard.press('PageUp');
    await expect
      .poll(() => viewer.evaluate((el) => el.scrollTop))
      .toBeLessThanOrEqual(metrics.top + 1);

    await page.keyboard.press('End');
    await expect.poll(() => currentPage(page)).toBe('100');
    await page.keyboard.press('Home');
    await expect.poll(() => currentPage(page)).toBe('1');
    expect(problems).toEqual([]);
  });

  test('+ and - zoom, 0 returns to 100%, and the level is announced', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-1page.pdf');
    const zoom = page.getByTestId('zoom-select');
    const before = await page.evaluate(
      () => document.querySelector<HTMLElement>('.page')!.getBoundingClientRect().width,
    );
    await page.keyboard.press('+');
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector<HTMLElement>('.page')!.getBoundingClientRect().width,
        ),
      )
      .toBeGreaterThan(before * 1.05);
    await page.keyboard.press('-');
    await page.keyboard.press('-');
    await expect
      .poll(() =>
        page.evaluate(
          () => document.querySelector<HTMLElement>('.page')!.getBoundingClientRect().width,
        ),
      )
      .toBeLessThan(before * 0.95);
    await page.keyboard.press('0');
    await expect(zoom).toHaveValue('1');
    await expect(page.getByTestId('live-region')).toHaveText('Zoom 100%', { timeout: 5000 });
  });

  test('keys typed into the find box or page box are not shortcuts', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-100pages.pdf');
    const find = await openFindBar(page);
    await page.keyboard.type('npj-+0');
    await expect(find).toHaveValue('npj-+0');
    await page.waitForTimeout(300);
    expect(await currentPage(page)).toBe('1');
    await page.keyboard.press('End');
    expect(await currentPage(page)).toBe('1');
  });

  test('Ctrl+F is left to Chrome until a document is open, then opens the reader find bar', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await page.evaluate(() => {
      (window as unknown as { __prevented: boolean[] }).__prevented = [];
      window.addEventListener('keydown', (e) => {
        if (e.key === 'f')
          (window as unknown as { __prevented: boolean[] }).__prevented.push(e.defaultPrevented);
      });
    });
    await page.keyboard.press('Control+f');
    expect(
      await page.evaluate(() => (window as unknown as { __prevented: boolean[] }).__prevented),
    ).toEqual([false]);
    await expect(page.getByTestId('find-bar')).toHaveCount(0);

    await openFixtureReady(page, 'text-1page.pdf');
    await page.keyboard.press('Control+f');
    await expect(page.getByTestId('find-bar')).toBeVisible();
    expect(
      (await page.evaluate(() => (window as unknown as { __prevented: boolean[] }).__prevented)).at(
        -1,
      ),
    ).toBe(true);
  });
});

test.describe('find in document', () => {
  test('counts, steps with Enter / Shift+Enter and the buttons, wraps, and highlights', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-1page.pdf');
    const find = await openFindBar(page);
    const status = page.getByTestId('find-status');
    await find.fill('the');
    await expect(status).toHaveText('1 of 3', { timeout: 15_000 });
    await expect(page.locator('.textLayer .highlight').first()).toBeAttached();
    await expect(page.locator('.textLayer .highlight.selected')).toHaveCount(1);
    await find.press('Enter');
    await expect(status).toHaveText('2 of 3');
    await page.getByRole('button', { name: 'Next match' }).click();
    await expect(status).toHaveText('3 of 3');
    await find.press('Enter');
    await expect(status).toHaveText('1 of 3'); // wrapped
    await page.getByRole('button', { name: 'Previous match' }).click();
    await expect(status).toHaveText('3 of 3');
    await find.press('Shift+Enter');
    await expect(status).toHaveText('2 of 3');
  });

  test('Match case narrows the search; "No matches" is announced in the status', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-1page.pdf');
    const find = await openFindBar(page);
    const status = page.getByTestId('find-status');
    const caseToggle = page.getByTestId('find-case');
    await expect(caseToggle).toHaveAttribute('aria-pressed', 'false');
    await find.fill('The');
    await expect(status).toHaveText('1 of 3', { timeout: 15_000 });
    await caseToggle.click();
    await expect(caseToggle).toHaveAttribute('aria-pressed', 'true');
    await expect(status).toHaveText('1 of 1', { timeout: 15_000 });
    await find.fill('zzzz-not-here');
    await expect(status).toHaveText('No matches', { timeout: 15_000 });
    await expect(status).toHaveAttribute('role', 'status');
  });

  test('Escape closes the bar, clears the highlights, returns focus to the pages and forgets the query', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-1page.pdf');
    const find = await openFindBar(page);
    await find.fill('quick');
    await expect(page.getByTestId('find-status')).toHaveText('1 of 2', { timeout: 15_000 });
    await expect(page.locator('.textLayer .highlight').first()).toBeAttached();

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('find-bar')).toHaveCount(0);
    await expect(page.locator('.textLayer .highlight')).toHaveCount(0);
    await expect(page.getByTestId('viewer-container')).toBeFocused();

    // Reopened empty: nothing is remembered.
    await page.getByTestId('find-toggle').click();
    await expect(page.getByTestId('find-input')).toHaveValue('');
    await expect(page.getByTestId('find-input')).toBeFocused();
    await expect(page.getByTestId('find-status')).toHaveText('');
  });

  test('the Find button toggles the bar and tells assistive tech whether it is open', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-1page.pdf');
    const toggle = page.getByTestId('find-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('find-bar')).toHaveAttribute('role', 'search');
    await toggle.click();
    await expect(page.getByTestId('find-bar')).toHaveCount(0);
  });
});

test.describe('zoom and navigation controls', () => {
  test('presets, + and - buttons, fit width and the page box work and are announced', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-100pages.pdf');
    const zoom = page.getByTestId('zoom-select');
    const width = () =>
      page.evaluate(
        () => document.querySelector<HTMLElement>('.page canvas')!.getBoundingClientRect().width,
      );

    await zoom.selectOption('1');
    await expect.poll(width).toBeGreaterThan(812);
    await expect.poll(width).toBeLessThan(820); // 816 px at 100%
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect.poll(width).toBeGreaterThan(816 * 1.05);
    // A level between presets shows as its own percentage.
    await expect(zoom.locator('option:checked')).toHaveText(/^\d+%$/);
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await page.getByRole('button', { name: 'Zoom out' }).click();
    await expect.poll(width).toBeLessThan(816);
    await page.getByTestId('fit-width').click();
    await expect(zoom).toHaveValue('page-width');
    const fit = await page.evaluate(() => {
      const container = document.querySelector<HTMLElement>('[data-testid=viewer-container]')!;
      const pageEl = document.querySelector<HTMLElement>('.page')!;
      return container.clientWidth - pageEl.getBoundingClientRect().width;
    });
    expect(fit).toBeGreaterThanOrEqual(0);
    expect(fit).toBeLessThan(40); // the margins around the page

    const input = page.getByTestId('page-input');
    await input.fill('50');
    await input.press('Enter');
    await expect(input).toHaveValue('50');
    await expect(page.getByTestId('live-region')).toHaveText('Page 50 of 100', { timeout: 5000 });
    // Out-of-range input is clamped, not an error.
    await input.fill('999');
    await input.press('Enter');
    await expect(input).toHaveValue('100');
  });
});

test.describe('title, close and what is forgotten', () => {
  test('the tab title and header show the file name; Close PDF restores both', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await expect(page).toHaveTitle('Clavis PDF reader');
    await openFixtureReady(page, 'text-1page.pdf');
    await expect(page).toHaveTitle('text-1page.pdf — Clavis PDF reader');
    await expect(page.getByTestId('file-name')).toHaveText('text-1page.pdf');
    await page.getByRole('button', { name: 'Close PDF' }).click();
    await expect(page).toHaveTitle('Clavis PDF reader');
    await expect(page.getByTestId('file-name')).toHaveCount(0);
    await waitForPhase(page, 'empty');
  });

  test('closing releases the pages, canvases, worker and selection; nothing about the file is stored', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-100pages.pdf');
    await waitForRendersToSettle(page);
    expect((await canvasStats(page)).canvasCount).toBeGreaterThan(0);
    expect(page.workers().length).toBeGreaterThan(0);

    await page.getByRole('button', { name: 'Close PDF' }).click();
    await waitForPhase(page, 'empty');
    const after = await canvasStats(page);
    expect(after).toMatchObject({ pages: 0, canvasCount: 0, canvasBytes: 0 });
    await expect.poll(() => page.workers().length).toBe(0);
    expect(await page.locator('.textLayer').count()).toBe(0);
    expect(await page.evaluate(() => document.getSelection()?.toString() ?? '')).toBe('');

    // Nothing about the file is kept anywhere the page can write.
    const stored = await page.evaluate(async () => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      databases: (await indexedDB.databases()).map((d) => d.name),
      caches: await caches.keys(),
    }));
    expect(stored).toEqual({ local: [], session: [], databases: [], caches: [] });
  });

  test('opening another file replaces the first one completely, and zoom and page start fresh', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-100pages.pdf');
    await page.getByTestId('zoom-select').selectOption('1.5');
    await page.getByTestId('page-input').fill('40');
    await page.getByTestId('page-input').press('Enter');
    await expect(page.getByTestId('page-input')).toHaveValue('40');

    await page.getByTestId('file-input').setInputFiles(fixturePath('text-1page.pdf'));
    await expect(page.getByTestId('page-count')).toHaveText('of 1', { timeout: 15_000 });
    await expect(page.getByTestId('page-input')).toHaveValue('1');
    await expect(page.getByTestId('zoom-select')).toHaveValue('page-width');
    expect(await page.locator('.pdfViewer .page').count()).toBe(1);
    // The old document's worker is gone; at most the new one is alive.
    await expect.poll(() => page.workers().length).toBeLessThanOrEqual(1);
  });

  test('picking the same file again opens it again', async ({ context, extensionId }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-1page.pdf');
    await page.getByRole('button', { name: 'Close PDF' }).click();
    await waitForPhase(page, 'empty');
    await openFixtureReady(page, 'text-1page.pdf');
    await expect(page.getByTestId('page-count')).toHaveText('of 1');
  });
});

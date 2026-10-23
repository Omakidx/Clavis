import { expect, test } from './fixtures';
import {
  canvasStats,
  externalRequests,
  fixtureInfo,
  openFindBar,
  openFixtureReady,
  openReader,
  scrollViewerTo,
  setZoom,
  waitForRendersToSettle,
} from './p7-reader-support/helpers';

test.describe.configure({ timeout: 180_000 });

/**
 * PDF.js keeps the visible pages plus a small buffer of recently rendered pages (its page view
 * buffer holds 10). Visible (1-3) + buffer (10) is the ceiling; 14 leaves headroom without
 * letting "every page renders" (100) pass.
 */
const MAX_PAGES_WITH_CANVAS = 14;

test.describe('Reader: 100-page PDF', () => {
  test('only pages near the viewport hold canvases while scrolling, and memory stays bounded', async ({
    context,
    extensionId,
  }) => {
    const { page, problems, requests } = await openReader(context, extensionId);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const heapMB = async () => {
      const { metrics } = await cdp.send('Performance.getMetrics');
      return (metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0) / 1048576;
    };

    await openFixtureReady(page, 'text-100pages.pdf');
    await expect(page.getByTestId('page-count')).toHaveText('of 100');
    await setZoom(page, '1');
    await waitForRendersToSettle(page, { quietMs: 800 });

    const initial = await canvasStats(page);
    expect(initial.pages, 'one page placeholder per PDF page').toBe(100);
    expect(initial.withCanvas.length).toBeGreaterThan(0);
    expect(initial.withCanvas.length).toBeLessThanOrEqual(MAX_PAGES_WITH_CANVAS);
    expect(initial.withCanvas, 'first page is rendered at the top').toContain(1);

    const heapStart = await heapMB();
    // Distance between the tops of two consecutive pages (height + borders + margins).
    const stride = await page.evaluate(() => {
      const pages = document.querySelectorAll<HTMLElement>('.pdfViewer .page');
      return pages[1]!.offsetTop - pages[0]!.offsetTop;
    });
    const samples: string[] = [];
    let maxWithCanvas = initial.withCanvas.length;
    let maxCanvasBytes = initial.canvasBytes;

    // Walk the whole document in 7-page jumps (pages 8..99), then the last page, the middle, the top.
    const jumps = [...Array.from({ length: 14 }, (_, i) => (i + 1) * 7), 99, 50, 0];
    for (const pageIndex of jumps) {
      await scrollViewerTo(page, pageIndex * stride, pageIndex + 1);
      const stats = await canvasStats(page);
      maxWithCanvas = Math.max(maxWithCanvas, stats.withCanvas.length);
      maxCanvasBytes = Math.max(maxCanvasBytes, stats.canvasBytes);
      const current = Number(await page.getByTestId('page-input').inputValue());
      samples.push(
        `jump->p${pageIndex + 1} current=${current} canvases=${stats.withCanvas.join(',')}`,
      );
      expect(stats.withCanvas.length).toBeLessThanOrEqual(MAX_PAGES_WITH_CANVAS);
      expect(stats.withCanvas, 'the page in view is rendered').toContain(current);
      if (pageIndex >= 30) {
        expect(stats.withCanvas, 'pages far above are released').not.toContain(1);
      }
    }
    const heapEnd = await heapMB();
    const final = await canvasStats(page);
    console.log(
      `[p7-reader] virtualization: maxPagesWithCanvas=${maxWithCanvas} maxCanvasMB=${(maxCanvasBytes / 1048576).toFixed(1)} ` +
        `heapStartMB=${heapStart.toFixed(1)} heapEndMB=${heapEnd.toFixed(1)} finalPages=${final.withCanvas.join(',')}\n${samples.join('\n')}`,
    );
    expect(maxWithCanvas).toBeLessThanOrEqual(MAX_PAGES_WITH_CANVAS);
    // Rough bounds: 100 fully rendered pages would need ~370 MB of canvas alone at this zoom.
    expect(maxCanvasBytes / 1048576).toBeLessThan(150);
    expect(heapEnd).toBeLessThan(300);
    expect(heapEnd - heapStart).toBeLessThan(150);
    expect(problems).toEqual([]);
    expect(externalRequests(requests, extensionId)).toEqual([]);
  });

  test('page box and prev/next navigate the document', async ({ context, extensionId }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-100pages.pdf');
    const input = page.getByTestId('page-input');
    await input.fill('50');
    await input.press('Enter');
    await expect(input).toHaveValue('50');
    await expect(page.locator('.page[data-page-number="50"] canvas').first()).toBeVisible();
    await page.getByRole('button', { name: 'Next page' }).click();
    await expect(input).toHaveValue('51');
    await page.getByRole('button', { name: 'Previous page' }).click();
    await page.getByRole('button', { name: 'Previous page' }).click();
    await expect(input).toHaveValue('49');
  });

  test('find navigates to a term on a later page, steps through matches and reports none', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openReader(context, extensionId);
    await openFixtureReady(page, 'text-100pages.pdf');
    const find = await openFindBar(page);
    const status = page.getByTestId('find-status');

    await find.fill('xylophone');
    await expect(status).toHaveText('1 of 1', { timeout: 20_000 });
    await expect(page.getByTestId('page-input')).toHaveValue('73', { timeout: 20_000 });
    const target = page.locator('.page[data-page-number="73"] .textLayer .highlight');
    await expect(target.first()).toBeAttached({ timeout: 20_000 });
    await expect(page.locator('.textLayer .highlight.selected')).toHaveCount(1);
    expect(fixtureInfo('text-100pages.pdf').pages).toBe(100);

    // Matching starts from the page in view (73), so the first hit is match 73 of 100.
    await find.fill('fixture sentence 12 on');
    await expect(status).toHaveText('73 of 100', { timeout: 20_000 });
    await find.press('Enter');
    await expect(status).toHaveText('74 of 100');
    await expect(page.getByTestId('page-input')).toHaveValue('74', { timeout: 20_000 });
    await find.press('Shift+Enter');
    await expect(status).toHaveText('73 of 100');

    await find.fill('zzzz-not-in-this-document');
    await expect(status).toHaveText('No matches', { timeout: 20_000 });
  });
});

import { expect, test } from '@playwright/test';
import { startAcceptHarness, type AcceptHarness } from './p7-accept-support/harness';
import { accept } from './p7-accept-support/manifest';
import { HOOK, TEXT, type Reader } from './p7-accept-support/reader';

// Phase 7 acceptance: FR-057 (find in document: count, next/previous, a late page, highlight) and
// FR-059 (virtualised pages: the number of canvases stays bounded while a 100-page document is
// scrolled and jumped through, the page in view always has its canvas, scrolling stays alive).
let h: AcceptHarness;
test.beforeAll(async () => {
  h = await startAcceptHarness({ key: true });
});
test.afterAll(async () => {
  await h?.close();
});

async function withReader(
  file: string,
  run: (reader: Reader) => Promise<void>,
  options: { password?: string; width?: number; height?: number } = {},
): Promise<void> {
  const reader = await h.openReader({
    width: options.width ?? 1200,
    height: options.height ?? 800,
  });
  try {
    await reader.openReady(
      file,
      options.password === undefined ? {} : { password: options.password },
    );
    await run(reader);
    await reader.expectQuiet();
  } finally {
    await reader.page.close();
  }
}

const highlights = (reader: Reader) => reader.page.locator('.pdfViewer .textLayer .highlight');

test.describe('FR-057 find in document', () => {
  test('Ctrl+F opens the find bar with the box focused; Escape closes it and clears the highlights', async () => {
    await withReader('pages-100.pdf', async (reader) => {
      await expect(reader.tid(HOOK.findBar)).toHaveCount(0);
      await reader.page.keyboard.press('Control+f');
      await expect(reader.tid(HOOK.findBar)).toBeVisible();
      await expect(reader.tid(HOOK.findInput)).toBeFocused();
      await reader.tid(HOOK.findInput).fill('quokka');
      await expect.poll(() => highlights(reader).count()).toBeGreaterThan(0);
      await reader.page.keyboard.press('Escape');
      await expect(reader.tid(HOOK.findBar)).toHaveCount(0);
      await expect.poll(() => highlights(reader).count()).toBe(0);
    });
  });

  test('the Find toolbar button toggles the bar too', async () => {
    await withReader('basic-1page.pdf', async (reader) => {
      const toggle = reader.tid(HOOK.findToggle);
      await toggle.click();
      await expect(reader.tid(HOOK.findInput)).toBeVisible();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await toggle.click();
      await expect(reader.tid(HOOK.findBar)).toHaveCount(0);
      await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    });
  });

  test('a term that occurs once on a LATE page (88 of 100): "1 of 1", the view jumps there, the match is highlighted and in view', async () => {
    await withReader('pages-100.pdf', async (reader) => {
      await reader.find('quokka');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe('1 of 1');
      await expect.poll(() => reader.currentPage(), { timeout: 20_000 }).toBe(88);
      await reader.settle();
      await expect(reader.pageEl(88).locator('canvas').first()).toBeVisible();
      const marked = highlights(reader);
      await expect(marked.first()).toBeVisible();
      expect((await marked.first().innerText()).toLowerCase()).toContain('quokka');
      // The selected match lies inside the viewer rectangle (scrolled into view).
      const inside = await reader.page.evaluate(() => {
        const match = document.querySelector(
          '.textLayer .highlight.selected, .textLayer .highlight',
        );
        const view = document
          .querySelector('[data-testid=viewer-container]')!
          .getBoundingClientRect();
        const r = match!.getBoundingClientRect();
        return r.top >= view.top - 1 && r.bottom <= view.bottom + 1;
      });
      expect(inside).toBe(true);
    });
  });

  test('"marmot" occurs once on every page: 100 matches, Enter steps forward, Shift+Enter back, both wrap around', async () => {
    await withReader('pages-100.pdf', async (reader) => {
      await reader.find('marmot');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe('1 of 100');
      const input = reader.tid(HOOK.findInput);
      await input.press('Enter');
      await expect.poll(() => reader.findStatus()).toBe('2 of 100');
      await expect.poll(() => reader.currentPage()).toBe(2);
      await input.press('Shift+Enter');
      await expect.poll(() => reader.findStatus()).toBe('1 of 100');
      // Backwards from the first match wraps to the last page.
      await input.press('Shift+Enter');
      await expect.poll(() => reader.findStatus()).toBe('100 of 100');
      await expect.poll(() => reader.currentPage()).toBe(100);
      await input.press('Enter');
      await expect.poll(() => reader.findStatus()).toBe('1 of 100');
      // The buttons do the same.
      await reader.tid(HOOK.findNext).click();
      await expect.poll(() => reader.findStatus()).toBe('2 of 100');
      await reader.tid(HOOK.findPrev).click();
      await expect.poll(() => reader.findStatus()).toBe('1 of 100');
    });
  });

  test('a per-page unique token is found on its page', async () => {
    await withReader('pages-100.pdf', async (reader) => {
      await reader.find('zebra57x3');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe('1 of 1');
      await expect.poll(() => reader.currentPage()).toBe(57);
    });
  });

  test('a term that is not there: "No matches", nothing highlighted, Next and Previous do nothing', async () => {
    await withReader('pages-100.pdf', async (reader) => {
      await reader.find('platypus');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe(TEXT.notFound);
      expect(await highlights(reader).count()).toBe(0);
      await reader.tid(HOOK.findInput).press('Enter');
      expect(await reader.currentPage()).toBe(1);
      await reader.expectQuiet();
    });
  });

  test('matching is case-insensitive by default and "Match case" makes it exact', async () => {
    await withReader('pages-100.pdf', async (reader) => {
      await reader.find('QUOKKA');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe('1 of 1');
      const toggle = reader.tid('find-case');
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-pressed', 'true');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe(TEXT.notFound);
      await reader.tid(HOOK.findInput).fill('quokka');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe('1 of 1');
    });
  });

  test('clearing the box removes the status and the highlights; typing letters in the box does not trigger page shortcuts', async () => {
    await withReader('pages-100.pdf', async (reader) => {
      await reader.openFind();
      const input = reader.tid(HOOK.findInput);
      await input.pressSequentially('njkp+-0', { delay: 20 });
      await expect(input).toHaveValue('njkp+-0');
      expect(await reader.currentPage()).toBe(1);
      expect(await reader.zoomValue()).toBe('page-width');
      await input.fill('marmot');
      // The total is exact; which match is "current" depends on timing when the machine is
      // loaded (observed once in a while: "47 of 100" right after a previous query), so the
      // position is not asserted here (p7-accept-find "marmot ..." asserts it on a fresh bar).
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toMatch(/^\d+ of 100$/);
      await input.fill('');
      await expect.poll(() => reader.findStatus()).toBe('');
      await expect.poll(() => highlights(reader).count()).toBe(0);
    });
  });

  test('non-Latin text can be found: CJK (embedded TrueType) and Hebrew', async () => {
    await withReader('cjk-truetype-embedded.pdf', async (reader) => {
      await reader.find('春眠不觉晓');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe('1 of 1');
      expect((await highlights(reader).first().innerText()).replace(/\s/g, '')).toContain(
        '春眠不觉晓',
      );
    });
    await withReader('rtl-hebrew-arabic.pdf', async (reader) => {
      await reader.find('שועל');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe('1 of 1');
    });
  });

  test('text whose code points are Kangxi radicals is found by typing the ideographs (the find normalises)', async () => {
    await withReader('cjk-kangxi-radicals.pdf', async (reader) => {
      await reader.find('白日依山尽');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe('1 of 1');
    });
  });

  test('a ligature word ("office", fi/ffi in the embedded font) and a mixed-case accented word are found', async () => {
    await withReader('font-truetype-embedded.pdf', async (reader) => {
      await reader.find('office');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toMatch(/^1 of \d+$/);
      await reader.tid(HOOK.findInput).fill('Café');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toMatch(/^1 of \d+$/);
    });
  });

  test('find works in an AES-256 encrypted document after the password was entered', async () => {
    const info = accept('encrypted-aes256.pdf');
    await withReader(
      'encrypted-aes256.pdf',
      async (reader) => {
        await reader.find('东京');
        await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe('1 of 1');
      },
      { password: info.password! },
    );
  });

  test('find on a scan (no text) says "No matches" and does not break the page', async () => {
    const reader = await h.openReader();
    try {
      await reader.open('scan-image-only.pdf');
      await reader.waitPhase('image-only');
      await reader.find('scanned');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe(TEXT.notFound);
      await reader.expectQuiet();
    } finally {
      await reader.page.close();
    }
  });

  test('opening another file resets the find bar and its term', async () => {
    await withReader('pages-100.pdf', async (reader) => {
      await reader.find('marmot');
      await expect.poll(() => reader.findStatus(), { timeout: 20_000 }).toBe('1 of 100');
      await reader.open('basic-1page.pdf');
      await reader.waitPhase('ready');
      await reader.waitFirstPage();
      expect(await reader.tid(HOOK.findBar).count()).toBe(0);
      expect(await highlights(reader).count()).toBe(0);
    });
  });
});

test.describe('FR-059 virtualised pages', () => {
  // The viewer keeps a bounded number of rendered pages (PDF.js keeps the 10 most recent) plus the
  // ones in view; the bound asserted here is 14 canvases, the number the Spike C walk established.
  const CANVAS_BOUND = 14;

  test('jumping through the whole 100-page file never holds more than 14 canvases; the page in view always has one', async () => {
    test.setTimeout(120_000);
    await withReader('pages-100.pdf', async (reader) => {
      await reader.setZoom('1');
      expect((await reader.canvasStats()).pages).toBe(100);
      let max = 0;
      let maxPixels = 0;
      const walk = [8, 15, 22, 29, 36, 43, 50, 57, 64, 71, 78, 85, 92, 99, 100, 51, 1];
      const history: Record<number, number[]> = {};
      for (const target of walk) {
        await reader.goToPage(target);
        const stats = await reader.canvasStats();
        max = Math.max(max, stats.canvasCount);
        maxPixels = Math.max(maxPixels, stats.canvasPixels);
        history[target] = stats.withCanvas;
        expect(stats.withCanvas, `page ${target} is in view`).toContain(target);
        expect(stats.canvasCount, `jump to ${target}`).toBeLessThanOrEqual(CANVAS_BOUND);
      }
      // 14 Letter pages at 816 x 1056 is 12 million pixels; a fully rendered document would be 86 million.
      expect(maxPixels).toBeLessThanOrEqual(CANVAS_BOUND * 816 * 1056 * 1.1);
      // Early pages were released again after the walk moved on.
      expect((await reader.canvasStats()).withCanvas.length).toBeLessThanOrEqual(CANVAS_BOUND);
      test.info().annotations.push({
        type: 'observed',
        description: `max canvases ${max}; walk ${JSON.stringify(history)}`,
      });
    });
  });

  test('wheel-scrolling down through 40 pages keeps canvases bounded and the view alive (no long main-thread stalls)', async () => {
    test.setTimeout(180_000);
    await withReader('pages-100.pdf', async (reader) => {
      await reader.setZoom('1');
      await reader.page.evaluate(() => {
        const w = window as unknown as { __gaps: number[]; __last: number };
        w.__gaps = [];
        w.__last = performance.now();
        const tick = () => {
          const now = performance.now();
          w.__gaps.push(now - w.__last);
          w.__last = now;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await reader.page.mouse.move(600, 400);
      let max = 0;
      for (let step = 0; step < 40; step++) {
        await reader.page.mouse.wheel(0, 1000);
        if (step % 4 === 3) {
          max = Math.max(max, (await reader.canvasStats()).canvasCount);
        }
      }
      await reader.settle();
      expect((await reader.canvasStats()).canvasCount).toBeLessThanOrEqual(CANVAS_BOUND);
      expect(max).toBeLessThanOrEqual(CANVAS_BOUND);
      expect(await reader.currentPage()).toBeGreaterThan(30);
      const stats = await reader.page.evaluate(() => {
        const gaps = (window as unknown as { __gaps: number[] }).__gaps;
        const sorted = [...gaps].sort((a, b) => a - b);
        return { frames: gaps.length, worst: sorted[sorted.length - 1] ?? 0 };
      });
      test.info().annotations.push({
        type: 'observed',
        description: `rAF frames ${stats.frames}, worst gap ${Math.round(stats.worst)} ms`,
      });
      // Loose on purpose (a loaded CI machine): the main thread must never freeze for seconds.
      expect(stats.worst).toBeLessThan(3000);
    });
  });

  test('page-by-page with the keyboard (n) for 25 pages also stays bounded', async () => {
    test.setTimeout(120_000);
    await withReader('pages-100.pdf', async (reader) => {
      await reader.viewer.focus();
      for (let i = 0; i < 25; i++) {
        await reader.page.keyboard.press('n');
        await expect.poll(() => reader.currentPage(), { timeout: 15_000 }).toBe(i + 2);
      }
      await reader.settle();
      expect((await reader.canvasStats()).canvasCount).toBeLessThanOrEqual(CANVAS_BOUND);
    });
  });

  test('at 175% and 200% each canvas stays within 4096 x 4096 pixels and the count within the bound', async () => {
    test.setTimeout(120_000);
    await withReader(
      'pages-100.pdf',
      async (reader) => {
        for (const zoom of ['1.75', '2']) {
          await reader.setZoom(zoom);
          for (const target of [1, 40, 99]) {
            await reader.goToPage(target);
            const stats = await reader.canvasStats();
            expect(stats.maxCanvasPixels, `zoom ${zoom} page ${target}`).toBeLessThanOrEqual(
              4096 * 4096,
            );
            expect(stats.canvasCount).toBeLessThanOrEqual(CANVAS_BOUND + 4);
          }
        }
      },
      { width: 1400, height: 900 },
    );
  });

  test('JS heap of the reader tab stays modest after visiting the whole 100-page document', async () => {
    test.setTimeout(120_000);
    await withReader('pages-100.pdf', async (reader) => {
      for (const target of [1, 20, 40, 60, 80, 100, 50]) await reader.goToPage(target);
      const heapMb = await reader.page.evaluate(
        () =>
          ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
            ?.usedJSHeapSize ?? 0) /
          (1024 * 1024),
      );
      test
        .info()
        .annotations.push({ type: 'observed', description: `JS heap ${heapMb.toFixed(1)} MB` });
      expect(heapMb).toBeLessThan(150);
    });
  });

  test('the pages of a long document are placeholders until needed: 100 page boxes exist at once, almost all without canvas', async () => {
    await withReader('pages-100.pdf', async (reader) => {
      const stats = await reader.canvasStats();
      expect(stats.pages).toBe(100);
      expect(stats.canvasCount).toBeLessThanOrEqual(CANVAS_BOUND);
      // Text layers exist only for rendered pages.
      const layers = await reader.page.locator('.pdfViewer .textLayer').count();
      expect(layers).toBeLessThanOrEqual(CANVAS_BOUND + 2);
    });
  });
});

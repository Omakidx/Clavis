import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { expect, extensionPath, test } from './fixtures';
import { treeMemory, type TreeMemory } from './p9-perf-support/process-memory';
import {
  canvasStats,
  openReader,
  scrollViewerTo,
  setZoom,
  waitForPhase,
  waitForRendersToSettle,
  loadFixture,
} from './p7-reader-support/helpers';
import { HeapProbe, MB, median, round, writeResult } from './p9-perf-support/metrics';
import { makeLongPdf } from './p9-perf-support/long-pdf';
import { CARD, explainWord, startCardHarness, type CardHarness } from './p5-card-support/harness';
import { openPanelPage, tabIdOf } from './p8-sidepanel-support/panel';
import { selectWord } from './p5-card-support/harness';
import { tb } from './spike-b-support/toolbar';

/**
 * Phase 9 memory budgets (docs/decisions/p9-performance.md). Two things are measured here:
 *
 *  1. The reader on a long generated PDF, scrolled end to end, jumped around and zoomed: pages
 *     holding a canvas, canvas pixels and JS heap stay bounded, and the heap returns near its
 *     baseline once the document is closed (replaced by a small one; the controller runs the same
 *     close() cleanup for both).
 *  2. A web page with the toolbar, the explanation card and the side panel open: heap growth of
 *     the page and of the panel page, and no growth across repeated Explain cycles (a leak check).
 *
 * The bounds below are deliberately generous (2-4x the measured numbers) so a loaded CI machine
 * cannot flake them, yet tight enough that an unbounded-canvas or leaking regression (hundreds of
 * MB) fails. The measured numbers and the budget table live in the decision record. Results are
 * also written to <outputDir>/p9-perf-memory-*.json.
 *
 * Heap is the page's main-thread V8 heap (`Performance.getMetrics` JSHeapUsedSize) after a forced
 * GC. The PDF.js worker has its own heap that the protocol session of a page cannot see; the
 * worker is checked by counting (it must be terminated when the document closes) and the
 * canvases, the dominant cost, by their backing-store size.
 */

const PAGES = Number(process.env['CLAVIS_P9_PDF_PAGES'] ?? 800);

// ---- budgets ----
/** PDF.js keeps visible pages plus a 10-page buffer; same ceiling as p7-reader-virtualization. */
const MAX_PAGES_WITH_CANVAS = 14;
/** Canvas elements: one per rendered page, plus an occasional second one while a page re-renders. */
const MAX_CANVASES = 20;
/** 14 pages at 175% zoom is about 2.6 Mpx each; 48 Mpx leaves 4x headroom over the measured peak. */
const MAX_CANVAS_MPX = 48;
/** Retained heap after the walk, above the empty-reader baseline (includes 800 page views and text layers). */
const MAX_WALK_RETAINED_GROWTH_MB = 50;
/** Peak heap (garbage included) while walking, absolute. */
const MAX_PEAK_HEAP_MB = 150;
/** After closing: heap above baseline. The 1-page replacement document itself costs a few MB. */
const MAX_CLOSED_GROWTH_MB = 20;
/** After closing: DOM nodes above baseline (800 placeholders must be gone). */
const MAX_CLOSED_NODE_GROWTH = 1500;

test.describe('reader memory on a long PDF', () => {
  test.describe.configure({ timeout: 8 * 60_000 });

  test(`${PAGES}-page PDF: canvases stay bounded and the heap returns near baseline after closing`, async ({
    context,
    extensionId,
  }, testInfo) => {
    const pdf = await makeLongPdf(PAGES);
    try {
      const { page, problems } = await openReader(context, extensionId);
      const heap = await HeapProbe.attach(context, page);
      const baseline = await heap.heapMB({ gc: true });
      const baselineDom = await heap.dom();

      await loadFixture(page, 'text-1page.pdf'); // warm the worker and fonts once; not measured
      await waitForPhase(page, 'ready');
      await page.getByTestId('file-input').setInputFiles(pdf.file);
      await waitForPhase(page, 'ready');
      await expect(page.getByTestId('page-count')).toHaveText(`of ${PAGES}`, { timeout: 60_000 });
      await setZoom(page, '1');
      await waitForRendersToSettle(page, { quietMs: 600 });

      const first = await canvasStats(page);
      expect(first.pages, 'one placeholder per PDF page').toBe(PAGES);
      expect(first.withCanvas.length).toBeGreaterThan(0);

      const stride = await page.evaluate(() => {
        const pages = document.querySelectorAll<HTMLElement>('.pdfViewer .page');
        return pages[1]!.offsetTop - pages[0]!.offsetTop;
      });

      let maxWithCanvas = first.withCanvas.length;
      let maxCanvases = first.canvasCount;
      let maxCanvasMpx = first.canvasBytes / 4 / 1e6;
      let peakHeap = await heap.heapMB({ gc: false });
      let jumps = 0;
      const observe = async (label: string, expectedPage: number): Promise<void> => {
        const stats = await canvasStats(page);
        maxWithCanvas = Math.max(maxWithCanvas, stats.withCanvas.length);
        maxCanvases = Math.max(maxCanvases, stats.canvasCount);
        maxCanvasMpx = Math.max(maxCanvasMpx, stats.canvasBytes / 4 / 1e6);
        peakHeap = Math.max(peakHeap, await heap.heapMB({ gc: false }));
        jumps++;
        expect(stats.withCanvas.length, `${label}: pages with a canvas`).toBeLessThanOrEqual(
          MAX_PAGES_WITH_CANVAS,
        );
        expect(stats.canvasCount, `${label}: canvas elements`).toBeLessThanOrEqual(MAX_CANVASES);
        expect(stats.withCanvas, `${label}: the page in view is drawn`).toContain(expectedPage);
        expect(stats.pages, `${label}: placeholders stay`).toBe(PAGES);
      };

      // End to end in ~25 steps, then the last page.
      const step = Math.max(1, Math.floor(PAGES / 25));
      for (let index = step; index < PAGES; index += step) {
        await scrollViewerTo(page, index * stride, index + 1, 250);
        await observe(`walk p${index + 1}`, index + 1);
      }
      await scrollViewerTo(page, (PAGES - 1) * stride, PAGES, 250);
      await observe(`walk p${PAGES}`, PAGES);

      // Deterministic pseudo-random jumps (a fixed LCG: the run must repeat exactly).
      let seed = 20261023;
      for (let i = 0; i < 24; i++) {
        seed = (seed * 1103515245 + 12345) % 2147483648;
        const index = seed % PAGES;
        await scrollViewerTo(page, index * stride, index + 1, 250);
        await observe(`jump p${index + 1}`, index + 1);
      }

      // Zoom changes re-render everything near the viewport; the ceiling must still hold.
      for (const zoom of ['1.75', 'page-width', '0.5', '1']) {
        await setZoom(page, zoom);
        const current = Number(await page.getByTestId('page-input').inputValue());
        await observe(`zoom ${zoom}`, current);
      }

      const retained = await heap.heapMB({ gc: true });
      const walkDom = await heap.dom();
      const workersWhileOpen = page.workers().length;

      // Close: opening another document runs close() on this one (viewer.setDocument(null),
      // linkService.setDocument(null), loadingTask.destroy()).
      await loadFixture(page, 'text-1page.pdf');
      await waitForPhase(page, 'ready');
      await expect(page.getByTestId('page-count')).toHaveText('of 1', { timeout: 30_000 });
      await waitForRendersToSettle(page, { quietMs: 600 });
      const afterClose = await canvasStats(page);
      const closed = await heap.heapMB({ gc: true });
      const closedDom = await heap.dom();
      await expect.poll(() => page.workers().length, { timeout: 15_000 }).toBeLessThanOrEqual(1);
      const workersAfterClose = page.workers().length;

      const result = {
        pages: PAGES,
        pdfBytes: pdf.bytes,
        jumps,
        canvas: {
          maxPagesWithCanvas: maxWithCanvas,
          maxCanvases,
          maxCanvasMpx: round(maxCanvasMpx, 1),
          maxCanvasMB: round((maxCanvasMpx * 1e6 * 4) / MB, 1),
        },
        heapMB: {
          baseline: round(baseline),
          peakDuringWalk: round(peakHeap),
          retainedAfterWalk: round(retained),
          afterClose: round(closed),
          closedMinusBaseline: round(closed - baseline),
        },
        domNodes: {
          baseline: baselineDom.nodes,
          afterWalk: walkDom.nodes,
          afterClose: closedDom.nodes,
        },
        workers: { whileOpen: workersWhileOpen, afterClose: workersAfterClose },
        canvasesAfterClose: afterClose.canvasCount,
      };
      writeResult(testInfo, 'p9-perf-memory-reader', result);

      // Bounded canvases.
      expect(maxWithCanvas).toBeLessThanOrEqual(MAX_PAGES_WITH_CANVAS);
      expect(maxCanvases).toBeLessThanOrEqual(MAX_CANVASES);
      expect(maxCanvasMpx).toBeLessThanOrEqual(MAX_CANVAS_MPX);
      // Bounded heap while open.
      expect(retained - baseline).toBeLessThanOrEqual(MAX_WALK_RETAINED_GROWTH_MB);
      expect(peakHeap).toBeLessThanOrEqual(MAX_PEAK_HEAP_MB);
      // Released on close.
      expect(afterClose.pages).toBe(1);
      expect(afterClose.canvasCount).toBeLessThanOrEqual(2);
      expect(closed - baseline).toBeLessThanOrEqual(MAX_CLOSED_GROWTH_MB);
      expect(closedDom.nodes - baselineDom.nodes).toBeLessThanOrEqual(MAX_CLOSED_NODE_GROWTH);
      expect(workersAfterClose, "the closed document's worker is terminated").toBeLessThanOrEqual(
        1,
      );
      expect(problems).toEqual([]);
      await heap.detach();
    } finally {
      await pdf.dispose();
    }
  });
});

test.describe('page memory with the toolbar, card and side panel open', () => {
  test.describe.configure({ mode: 'serial', timeout: 4 * 60_000 });

  let h: CardHarness;
  test.beforeAll(async () => {
    h = await startCardHarness();
  });
  test.afterAll(async () => {
    await h?.close();
  });

  // Page heap above the idle observer page with toolbar + card (core and Roots tabs loaded).
  const MAX_CARD_GROWTH_MB = 10;
  // Heap of the side panel page (React shell) on its own.
  const MAX_PANEL_HEAP_MB = 30;
  // Growth across repeated select + Explain + dismiss cycles, after GC: no leak.
  const MAX_CYCLE_GROWTH_MB = 10;
  // Blink's node counter includes garbage that Oilpan has not collected yet and swings by a few
  // hundred nodes between readings (measured 126-780 with no growth trend over 40 cycles), so it is
  // only a catastrophic check here; the heap figure above is the real leak signal.
  const MAX_CYCLE_NODE_GROWTH = 2500;
  const CYCLES = 15;
  const WORDS = [
    'cartographer',
    'council',
    'vault',
    'Ingrid',
    'library',
    'flour',
    'floods',
    'mill',
  ];

  // eslint-disable-next-line no-empty-pattern
  test('toolbar + card + side panel stay within budget and repeated Explain does not leak', async ({}, testInfo) => {
    const { page, dispose } = await h.open();
    try {
      const heap = await HeapProbe.attach(h.ext.context, page);
      const idle = await heap.heapMB({ gc: true });
      const idleDom = await heap.dom();

      await selectWord(page, 'cartographer');
      const withToolbar = await heap.heapMB({ gc: true });

      const card = await explainWord(page, 'council');
      await card.waitFor(CARD.ready('core'));
      await card.click(CARD.tab('etymology'));
      await card.waitFor(CARD.ready('etymology'));
      const withCard = await heap.heapMB({ gc: true });
      const withCardDom = await heap.dom();

      // The side panel page, as the tab it is opened as in tests (same page and code as the real panel).
      await card.click(CARD.sidePanel);
      const tabId = await tabIdOf(h.ext.serviceWorker, page);
      const panel = await openPanelPage(h.ext.context, h.ext.extensionId, tabId);
      await expect(panel.getByTestId('panel-selected')).toHaveText('council');
      const panelHeap = await HeapProbe.attach(h.ext.context, panel);
      const panelMB = await panelHeap.heapMB({ gc: true });
      await panelHeap.detach();
      await panel.close();

      // Leak check: repeat select -> Explain -> dismiss and compare the retained heap.
      await page.bringToFront();
      await page.keyboard.press('Escape');
      const cycleStart = await heap.heapMB({ gc: true });
      const cycleStartDom = await heap.dom();
      for (let i = 0; i < CYCLES; i++) {
        const word = WORDS[i % WORDS.length]!;
        const cycleCard = await explainWord(page, word);
        await cycleCard.waitFor(CARD.ready('core'));
        await page.keyboard.press('Escape');
        await tb(page).waitHidden();
      }
      const cycleEnd = await heap.heapMB({ gc: true });
      const cycleEndDom = await heap.dom();

      writeResult(testInfo, 'p9-perf-memory-page', {
        cycles: CYCLES,
        pageHeapMB: {
          idleObserver: round(idle),
          withToolbar: round(withToolbar),
          withCard: round(withCard),
          cardGrowth: round(withCard - idle),
          afterCardDismissed: round(cycleStart),
          afterCycles: round(cycleEnd),
          cycleGrowth: round(cycleEnd - cycleStart),
        },
        panelPageHeapMB: round(panelMB),
        domNodes: {
          idle: idleDom.nodes,
          withCard: withCardDom.nodes,
          cycleStart: cycleStartDom.nodes,
          cycleEnd: cycleEndDom.nodes,
        },
        medianHeapMB: round(median([idle, withToolbar, withCard])),
      });

      expect(withCard - idle).toBeLessThanOrEqual(MAX_CARD_GROWTH_MB);
      expect(panelMB).toBeLessThanOrEqual(MAX_PANEL_HEAP_MB);
      expect(cycleEnd - cycleStart).toBeLessThanOrEqual(MAX_CYCLE_GROWTH_MB);
      expect(cycleEndDom.nodes - cycleStartDom.nodes).toBeLessThanOrEqual(MAX_CYCLE_NODE_GROWTH);
      await heap.detach();
    } finally {
      await dispose();
    }
  });
});

test.describe('reader process memory (Linux)', () => {
  test.skip(process.platform !== 'linux', 'reads /proc; the Phase 9 budget was measured on Linux');
  test.describe.configure({ timeout: 5 * 60_000 });

  // Whole browser tree, PSS, above the same browser with the empty reader open.
  /** While a long PDF is open and has been scrolled end to end (measured 200-325 MB for 200-1,600 pages). */
  const MAX_OPEN_GROWTH_MB = 500;
  /** After the document is closed and memory has had time to be returned (measured 45-60 MB). */
  const MAX_CLOSED_GROWTH_MB = 200;

  // eslint-disable-next-line no-empty-pattern
  test('whole-browser memory is bounded by the viewport, not the page count, and returns after close', async ({}, testInfo) => {
    const pdf = await makeLongPdf(PAGES);
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'clavis-p9-rss-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    try {
      const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
      const extensionId = new URL(worker.url()).host;
      const { page } = await openReader(context, extensionId);
      const settle = (ms: number) => page.waitForTimeout(ms);

      await settle(1500);
      const empty = treeMemory(userDataDir);

      await page.getByTestId('file-input').setInputFiles(pdf.file);
      await waitForPhase(page, 'ready');
      await expect(page.getByTestId('page-count')).toHaveText(`of ${PAGES}`, { timeout: 60_000 });
      const stride = await page.evaluate(() => {
        const pages = document.querySelectorAll<HTMLElement>('.pdfViewer .page');
        return pages[1]!.offsetTop - pages[0]!.offsetTop;
      });
      let peak: TreeMemory = empty;
      const step = Math.max(1, Math.floor(PAGES / 20));
      for (let index = 0; index < PAGES; index += step) {
        await page.evaluate((y) => {
          document.querySelector<HTMLElement>('[data-testid=viewer-container]')!.scrollTop = y;
        }, index * stride);
        await settle(400);
        const now = treeMemory(userDataDir);
        if (now.totalMB > peak.totalMB) peak = now;
      }
      await settle(1500);
      const open = treeMemory(userDataDir);

      // Close by replacing; then wait for the browser to hand memory back (poll, up to 40 s).
      await loadFixture(page, 'text-1page.pdf');
      await expect(page.getByTestId('page-count')).toHaveText('of 1', { timeout: 30_000 });
      let closed = treeMemory(userDataDir);
      const deadline = Date.now() + 40_000;
      while (closed.totalMB - empty.totalMB > MAX_CLOSED_GROWTH_MB / 2 && Date.now() < deadline) {
        await settle(1000);
        closed = treeMemory(userDataDir);
      }

      const r = (t: TreeMemory) => ({
        total: Math.round(t.totalMB),
        renderer: Math.round(t.rendererMB),
        gpu: Math.round(t.gpuMB),
        browser: Math.round(t.browserMB),
        processes: t.processes,
      });
      writeResult(testInfo, 'p9-perf-memory-process', {
        pages: PAGES,
        unit: 'MB PSS summed over the browser process tree',
        emptyReader: r(empty),
        longPdfOpenPeak: r(peak),
        longPdfOpenSettled: r(open),
        afterClose: r(closed),
        growthWhileOpenPeakMB: Math.round(peak.totalMB - empty.totalMB),
        growthAfterCloseMB: Math.round(closed.totalMB - empty.totalMB),
      });
      expect(empty.processes, 'the process tree was found').toBeGreaterThan(2);
      expect(peak.totalMB - empty.totalMB).toBeLessThanOrEqual(MAX_OPEN_GROWTH_MB);
      expect(closed.totalMB - empty.totalMB).toBeLessThanOrEqual(MAX_CLOSED_GROWTH_MB);
    } finally {
      await context.close();
      await pdf.dispose();
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    }
  });
});

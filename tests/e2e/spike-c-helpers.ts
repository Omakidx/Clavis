import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type BrowserContext, type Page } from '@playwright/test';

const fixtureDir = fileURLToPath(new URL('../fixtures/pdf/', import.meta.url));

export interface FixtureSentence {
  page: number;
  text: string;
  x: number;
  y: number;
  size: number;
  width: number;
}
export interface FixtureInfo {
  file: string;
  pages: number;
  bytes: number;
  sentences: FixtureSentence[];
  password?: string;
}

export const fixturePath = (file: string): string => path.join(fixtureDir, file);

export function fixtureInfo(file: string): FixtureInfo {
  const all = JSON.parse(readFileSync(fixturePath('manifest.json'), 'utf8')) as FixtureInfo[];
  const found = all.find((f) => f.file === file);
  if (!found) throw new Error(`Unknown fixture ${file}`);
  return found;
}

export interface ReaderSession {
  page: Page;
  /** Every request URL seen by the context (pages and workers) since the session started. */
  requests: string[];
  /** console.error / pageerror messages from the reader page. */
  problems: string[];
}

/** Open reader.html with network, console and page-error tracking attached before navigation. */
export async function openReader(
  context: BrowserContext,
  extensionId: string,
  viewport = { width: 1100, height: 700 },
): Promise<ReaderSession> {
  const requests: string[] = [];
  const problems: string[] = [];
  context.on('request', (request) => requests.push(request.url()));
  const page = await context.newPage();
  await page.setViewportSize(viewport);
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
  });
  await page.goto(`chrome-extension://${extensionId}/reader.html`);
  await expect(page.getByTestId('state-empty')).toBeVisible();
  return { page, requests, problems };
}

export async function loadFixture(page: Page, file: string): Promise<void> {
  await page.getByTestId('file-input').setInputFiles(fixturePath(file));
}

export const phase = (page: Page) => page.locator('.reader');

export async function waitForPhase(page: Page, expected: string): Promise<void> {
  await expect(page.locator('.reader')).toHaveAttribute('data-phase', expected, {
    timeout: 15_000,
  });
}

/** Open a fixture and wait until the first page has a canvas (and, by default, a populated text layer). */
export async function openFixtureReady(
  page: Page,
  file: string,
  expected = 'ready',
  options: { expectText?: boolean } = {},
): Promise<void> {
  await loadFixture(page, file);
  await waitForPhase(page, expected);
  await expect(page.locator('.page[data-page-number="1"] canvas').first()).toBeVisible();
  if (options.expectText ?? true) {
    await expect(
      page.locator('.page[data-page-number="1"] .textLayer span').first(),
    ).toBeAttached();
  }
}

export type Zoom = 'page-width' | '1' | '1.25' | '1.75';

export async function renderCount(page: Page): Promise<number> {
  return Number(await page.locator('.reader').getAttribute('data-render-count'));
}

/**
 * Wait until the viewer is idle: the controller's render counter (page + text layer completions)
 * has not moved for `quietMs`. Polled, not slept. `since` makes it wait for at least one render
 * after an action (zoom change, scroll) first.
 */
export async function waitForRendersToSettle(
  page: Page,
  options: { since?: number; quietMs?: number } = {},
): Promise<void> {
  const quietMs = options.quietMs ?? 700;
  let last = -1;
  let lastChange = Date.now();
  await expect
    .poll(
      async () => {
        const count = await renderCount(page);
        if (count !== last) {
          last = count;
          lastChange = Date.now();
        }
        const advanced = options.since === undefined || count > options.since;
        return advanced && Date.now() - lastChange >= quietMs;
      },
      { timeout: 30_000, intervals: [150] },
    )
    .toBe(true);
}

export async function setZoom(page: Page, zoom: string): Promise<void> {
  const select = page.getByTestId('zoom-select');
  if ((await select.inputValue()) === zoom) return;
  const since = await renderCount(page);
  await select.selectOption(zoom);
  await waitForRendersToSettle(page, { since });
}

export interface Geometry {
  spanLeft: number;
  spanRight: number;
  spanTop: number;
  spanBottom: number;
  inkLeft: number;
  inkRight: number;
  inkTop: number;
  inkBottom: number;
  scale: number;
}

/**
 * Compare the text-layer span holding `text` with the dark pixels the canvas actually drew in
 * the same area. Both boxes are axis-aligned client rectangles, so this also works on rotated pages.
 */
export async function measureAlignment(page: Page, text: string): Promise<Geometry> {
  return page.evaluate((needle) => {
    const span = [...document.querySelectorAll<HTMLElement>('.textLayer span')].find(
      (s) => s.textContent === needle,
    );
    if (!span) throw new Error(`span not found: ${needle}`);
    span.scrollIntoView({ block: 'center', inline: 'center' });
    const pageEl = span.closest<HTMLElement>('.page');
    const canvas = pageEl?.querySelector<HTMLCanvasElement>('canvas');
    if (!pageEl || !canvas) throw new Error('page canvas missing');
    const sr = span.getBoundingClientRect();
    const cr = canvas.getBoundingClientRect();
    const sx = canvas.width / cr.width;
    const sy = canvas.height / cr.height;
    // Pad a little along the line and by 60% of the line thickness across it, so neighbouring
    // lines (which are close together on rotated pages) never enter the ink search area.
    const vertical = sr.height > sr.width;
    const thin = Math.min(sr.width, sr.height);
    const padX = vertical ? thin * 0.6 : 24;
    const padY = vertical ? 24 : thin * 0.6;
    const x0 = Math.max(0, Math.floor((sr.left - padX - cr.left) * sx));
    const x1 = Math.min(canvas.width, Math.ceil((sr.right + padX - cr.left) * sx));
    const y0 = Math.max(0, Math.floor((sr.top - padY - cr.top) * sy));
    const y1 = Math.min(canvas.height, Math.ceil((sr.bottom + padY - cr.top) * sy));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    const { data, width } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let y = 0; y < y1 - y0; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        const luma =
          0.299 * (data[o] ?? 255) + 0.587 * (data[o + 1] ?? 255) + 0.114 * (data[o + 2] ?? 255);
        if (luma < 140) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    const toCssX = (px: number) => cr.left + (x0 + px) / sx;
    const toCssY = (px: number) => cr.top + (y0 + px) / sy;
    return {
      spanLeft: sr.left,
      spanRight: sr.right,
      spanTop: sr.top,
      spanBottom: sr.bottom,
      inkLeft: toCssX(minX),
      inkRight: toCssX(maxX + 1),
      inkTop: toCssY(minY),
      inkBottom: toCssY(maxY + 1),
      scale: cr.width / 816,
    };
  }, text);
}

/**
 * Select text of one text-layer span with a real mouse drag, from inside its first character to
 * inside character `endIndex` (default: the last one), along the reading direction (`vertical`
 * for 90-degree rotated pages).
 *
 * The drag starts and ends ON glyphs, never on blank text-layer space. PDF.js keeps an
 * `endOfContent` element next to the current selection focus so that blank space resolves near
 * it; with only two synthetic moves a pointer that ends on blank space therefore resolves next to
 * the previous focus and the selection stops short (a human produces dozens of moves and
 * progresses). Observed in this spike; see docs/decisions/spike-c-pdf.md.
 */
export async function dragSelectSpan(
  page: Page,
  text: string,
  options: { vertical?: boolean; endIndex?: number } = {},
): Promise<void> {
  const vertical = options.vertical ?? false;
  const endIndex = options.endIndex ?? text.length - 1;
  const ends = await page.evaluate(
    ([needle, endAt]) => {
      const span = [...document.querySelectorAll<HTMLElement>('.textLayer span')].find(
        (s) => s.textContent === needle,
      );
      const node = span?.firstChild;
      if (!span || !node || node.nodeType !== Node.TEXT_NODE) {
        throw new Error(`span not found: ${needle}`);
      }
      span.scrollIntoView({ block: 'center', inline: 'center' });
      const charRect = (index: number) => {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + 1);
        const r = range.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      };
      const box = document
        .querySelector<HTMLElement>('[data-testid=viewer-container]')!
        .getBoundingClientRect();
      return {
        first: charRect(0),
        last: charRect(endAt as number),
        stage: { left: box.left, right: box.right, top: box.top, bottom: box.bottom },
      };
    },
    [text, endIndex] as const,
  );
  const { first, last, stage } = ends;
  // A drag that leaves the scroll container selects across the page (or stops short), which is a
  // test-geometry problem, not a reader problem: fail with a clear message instead.
  for (const r of [first, last]) {
    if (
      r.left < stage.left ||
      r.right > stage.right ||
      r.top < stage.top ||
      r.bottom > stage.bottom
    ) {
      throw new Error(
        `dragSelectSpan: target glyph is outside the viewer (${JSON.stringify({ r, stage })}); use a larger window or a smaller zoom`,
      );
    }
  }
  // 25% into the first character, 80% into the last one (so the last character is included).
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const from = vertical
    ? { x: (first.left + first.right) / 2, y: lerp(first.top, first.bottom, 0.25) }
    : { x: lerp(first.left, first.right, 0.25), y: (first.top + first.bottom) / 2 };
  const to = vertical
    ? { x: (last.left + last.right) / 2, y: lerp(last.top, last.bottom, 0.8) }
    : { x: lerp(last.left, last.right, 0.8), y: (last.top + last.bottom) / 2 };
  // The text layer is rebuilt after zoom/scroll renders; dragging into a half-built layer gives a
  // short selection, so wait for the viewer to be idle first.
  await waitForRendersToSettle(page, { quietMs: 500 });
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Many small moves, all over glyphs: PDF.js resolves each pointer position relative to the
  // current selection focus (endOfContent), so a few big jumps can leave the focus mid-line.
  await page.mouse.move(to.x, to.y, { steps: 8 });
  // Settle on the final glyph (a second, tiny move) so the last position is processed.
  await page.mouse.move(to.x, to.y + (vertical ? 0 : 0.01));
  await page.mouse.up();
}

/**
 * Wait until the window selection (whitespace-normalised) equals `expected`, then return it.
 * Chromium applies a mouse-driven selection lazily (one update per rendered frame), so on a busy
 * machine it can lag far behind the last mouse event; a fixed "unchanged for N ms" rule would
 * accept a half-grown selection. If the selection never reaches `expected` the assertion fails
 * with the last value seen, which is what makes a real truncation visible.
 */
export async function selectionEquals(page: Page, expected: string): Promise<void> {
  await expect
    .poll(
      async () => normalize(await page.evaluate(() => document.getSelection()?.toString() ?? '')),
      {
        timeout: 30_000,
        intervals: [200],
      },
    )
    .toBe(expected);
}

export const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Request URLs that are neither extension resources nor inline (data:/blob:) content. */
export function externalRequests(requests: string[], extensionId: string): string[] {
  const own = `chrome-extension://${extensionId}/`;
  return requests.filter(
    (url) => !url.startsWith(own) && !url.startsWith('data:') && !url.startsWith('blob:'),
  );
}

export interface CanvasStats {
  /** `.page` elements in the DOM (one per PDF page, placeholders included). */
  pages: number;
  /** Page numbers that currently hold a canvas. */
  withCanvas: number[];
  canvasCount: number;
  /** Sum of canvas backing-store sizes in bytes (4 bytes per pixel). */
  canvasBytes: number;
}

export async function canvasStats(page: Page): Promise<CanvasStats> {
  return page.evaluate(() => {
    const pages = [...document.querySelectorAll<HTMLElement>('.pdfViewer .page')];
    const canvases = [...document.querySelectorAll<HTMLCanvasElement>('.pdfViewer .page canvas')];
    return {
      pages: pages.length,
      withCanvas: pages
        .filter((p) => p.querySelector('canvas'))
        .map((p) => Number(p.dataset['pageNumber'])),
      canvasCount: canvases.length,
      canvasBytes: canvases.reduce((sum, c) => sum + c.width * c.height * 4, 0),
    };
  });
}

/**
 * Scroll the viewer to `top` pixels and wait until the page now in view has been drawn
 * (canvas + loaded flag) and the viewer has been idle for `quietMs`.
 */
export async function scrollViewerTo(
  page: Page,
  top: number,
  expectedPage: number,
  quietMs = 600,
): Promise<void> {
  await page.evaluate((y) => {
    const el = document.querySelector<HTMLElement>('[data-testid=viewer-container]');
    if (el) el.scrollTop = y;
  }, top);
  await expect
    .poll(
      () =>
        page.evaluate((expected) => {
          const current = Number(
            (document.querySelector('[data-testid=page-input]') as HTMLInputElement).value,
          );
          // The page box follows the scroll position asynchronously; wait for it to arrive.
          if (Math.abs(current - expected) > 1) return false;
          const pageEl = document.querySelector<HTMLElement>(
            `.pdfViewer .page[data-page-number="${current}"]`,
          );
          return Boolean(pageEl?.querySelector('canvas') && pageEl.dataset['loaded'] === 'true');
        }, expectedPage),
      { timeout: 30_000, intervals: [150] },
    )
    .toBe(true);
  await waitForRendersToSettle(page, { quietMs });
}

/**
 * Launch a second Chromium with a copy of the built extension whose manifest was patched by
 * `patch`. Used to compare the shipped manifest with a proposed change (for example the CSP)
 * without rebuilding or touching the real build output.
 */
export async function launchPatchedExtension(
  extensionDir: string,
  patch: (manifest: Record<string, unknown>) => void,
): Promise<{ context: BrowserContext; extensionId: string; dispose: () => Promise<void> }> {
  const { cp, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { chromium } = await import('@playwright/test');
  const root = await mkdtemp(path.join(tmpdir(), 'clavis-spike-c-'));
  const copy = path.join(root, 'ext');
  await cp(extensionDir, copy, { recursive: true });
  const manifestPath = path.join(copy, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  patch(manifest);
  await writeFile(manifestPath, JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return {
    context,
    extensionId: new URL(worker.url()).host,
    dispose: async () => {
      await context.close();
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    },
  };
}

/** Mean RGB of the central 50% of the first rendered canvas of page 1 (0..255 per channel). */
export async function meanCanvasColor(page: Page): Promise<[number, number, number]> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.page[data-page-number="1"] canvas');
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) throw new Error('no canvas');
    const w = canvas.width;
    const h = canvas.height;
    const { data } = ctx.getImageData(w * 0.25, h * 0.25, w * 0.5, h * 0.5);
    let r = 0;
    let g = 0;
    let b = 0;
    const n = data.length / 4;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i] ?? 0;
      g += data[i + 1] ?? 0;
      b += data[i + 2] ?? 0;
    }
    return [Math.round(r / n), Math.round(g / n), Math.round(b / n)] as [number, number, number];
  });
}

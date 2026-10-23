import { expect, test, type Page } from '@playwright/test';
import { startAcceptHarness, type AcceptHarness } from './p7-accept-support/harness';
import { accept, pageLines, type LineInfo } from './p7-accept-support/manifest';
import { collapse, squash } from './p7-accept-support/reader';
import { dragSelectText, measureAlignment, type Alignment } from './p7-accept-support/selection';

// Phase 7 acceptance: FR-051 (render with the bundled PDF.js: text, images, fonts at normal and
// 150% zoom) and FR-052 (the selectable text layer lines up with the drawn page and selecting
// yields the visible text) for the fixtures Spike C could not cover: embedded TrueType and CFF
// subsets, Type3 CJK, predefined CMaps, right-to-left text, rotated pages, columns, JPEG 2000
// and JBIG2. Selection is a real mouse drag; alignment compares the text layer with the pixels
// the canvas actually drew.
let h: AcceptHarness;
test.beforeAll(async () => {
  h = await startAcceptHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const ZOOMS = ['1', '1.5', '1.75', 'page-width'] as const;
const WINDOW = { width: 1400, height: 900 };

/** Edges along the reading axis and the centre across it must agree within a fraction of the line. */
function expectAligned(a: Alignment, vertical: boolean, label: string, text = ''): void {
  expect(a.inkPixels, `${label}: the canvas drew no ink under the text layer`).toBeGreaterThan(20);
  const start = a.lineThickness * 0.2 + 2;
  // A full-width stop (。 、 ，) keeps its dot in the corner of an em box, so the ink ends up to
  // 0.7 em before the box; every other line must end within a third of the line height.
  const end = a.lineThickness * (/[。、，！？]$/.test(text) ? 0.75 : 0.35) + 2;
  const across = a.lineThickness * 0.35;
  if (vertical) {
    expect(a.topDelta, `${label}: start edge`).toBeLessThanOrEqual(start);
    expect(a.bottomDelta, `${label}: end edge`).toBeLessThanOrEqual(end);
    expect(a.centerXDelta, `${label}: across`).toBeLessThanOrEqual(across);
  } else {
    expect(a.leftDelta, `${label}: start edge`).toBeLessThanOrEqual(start);
    expect(a.rightDelta, `${label}: end edge`).toBeLessThanOrEqual(end);
    expect(a.centerYDelta, `${label}: across`).toBeLessThanOrEqual(across);
  }
}

interface Case {
  file: string;
  /** Lines to select and align, by page. */
  pick: LineInfo[];
  /** Text comparison: spaces matter for Latin, not for CJK/RTL. */
  norm: (s: string) => string;
  vertical?: (page: number) => boolean;
  /** Zooms to run (default all). */
  zooms?: readonly string[];
}

const cases: Case[] = [
  {
    file: 'font-truetype-embedded.pdf',
    pick: pageLines(accept('font-truetype-embedded.pdf'), 1),
    norm: collapse,
  },
  {
    file: 'font-gs-embedded.pdf',
    pick: pageLines(accept('font-gs-embedded.pdf'), 1),
    norm: collapse,
  },
  {
    file: 'cjk-truetype-embedded.pdf',
    pick: pageLines(accept('cjk-truetype-embedded.pdf'), 1),
    norm: squash,
  },
  {
    file: 'cjk-cff-type3.pdf',
    pick: pageLines(accept('cjk-cff-type3.pdf'), 1),
    norm: squash,
  },
  {
    file: 'rtl-hebrew-arabic.pdf',
    pick: pageLines(accept('rtl-hebrew-arabic.pdf'), 1),
    norm: squash,
  },
  {
    file: 'columns-3.pdf',
    // One line from each column; the draw order interleaves them.
    pick: accept('columns-3.pdf').lines.filter((l) => /^(Alpha 3|Bravo 5|Charlie 7) /.test(l.text)),
    norm: collapse,
  },
];

for (const c of cases) {
  test(`${c.file}: text layer aligned with the canvas and mouse selection exact at 100%, 150%, 175% and fit width`, async () => {
    test.setTimeout(150_000);
    const reader = await h.openReader(WINDOW);
    await reader.openReady(c.file);
    for (const zoom of c.zooms ?? ZOOMS) {
      await reader.setZoom(zoom);
      for (const line of c.pick) {
        const label = `${c.file} zoom ${zoom} "${line.text}"`;
        await reader.goToPageIfNeeded(line.page);
        expectAligned(
          await measureAlignment(reader.page, line.page, line.text),
          false,
          label,
          line.text,
        );
        await reader.clearSelection();
        await dragSelectText(reader.page, line.page, line.text);
        await reader.expectSelection(line.text, c.norm);
      }
    }
    await reader.expectQuiet();
    await reader.page.close();
  });
}

test('rotated pages (0, 90, 180, 270): ink and text layer agree, and a drag along the rotated line selects it exactly', async () => {
  test.setTimeout(150_000);
  const reader = await h.openReader({ width: 1500, height: 1000 });
  await reader.openReady('rotated-0-90-180-270.pdf');
  const info = accept('rotated-0-90-180-270.pdf');
  for (const zoom of ['1', '1.5', 'page-width']) {
    await reader.setZoom(zoom);
    for (const [index, angle] of [0, 90, 180, 270].entries()) {
      const pageNo = index + 1;
      await reader.goToPage(pageNo);
      for (const line of pageLines(info, pageNo)) {
        const label = `rotation ${angle} zoom ${zoom} "${line.text}"`;
        expectAligned(
          await measureAlignment(reader.page, pageNo, line.text),
          angle === 90 || angle === 270,
          label,
        );
        await reader.clearSelection();
        await dragSelectText(reader.page, pageNo, line.text);
        await reader.expectSelection(line.text, collapse);
      }
    }
  }
  await reader.expectQuiet();
  await reader.page.close();
});

test('rotated pages swap their sheet size: a 612x792 page rotated by 90 or 270 is 1056x816 CSS px', async () => {
  const reader = await h.openReader(WINDOW);
  await reader.openReady('rotated-0-90-180-270.pdf');
  await reader.setZoom('1');
  const sizes: number[][] = [];
  for (const n of [1, 2, 3, 4]) {
    const s = await reader.pageSize(n);
    sizes.push([Math.round(s.width), Math.round(s.height)]);
  }
  expect(sizes).toEqual([
    [816, 1056],
    [1056, 816],
    [816, 1056],
    [1056, 816],
  ]);
  await reader.page.close();
});

test('a multi-page embedded-font document renders every page and keeps selection working on page 2', async () => {
  const reader = await h.openReader(WINDOW);
  await reader.openReady('font-truetype-embedded.pdf');
  await reader.goToPage(2);
  await expect(reader.pageEl(2).locator('canvas').first()).toBeVisible();
  const line = pageLines(accept('font-truetype-embedded.pdf'), 2)[0]!;
  expectAligned(await measureAlignment(reader.page, 2, line.text), false, 'page 2');
  await dragSelectText(reader.page, 2, line.text);
  await reader.expectSelection(line.text, collapse);
  await reader.page.close();
});

test('Arabic shaped by Skia (glyph-level, visual-order text): ink and text layer agree and a drag selects a contiguous run of that text covering the line', async () => {
  const reader = await h.openReader(WINDOW);
  await reader.openReady('rtl-hebrew-arabic.pdf');
  await reader.goToPage(2);
  const [line] = pageLines(accept('rtl-hebrew-arabic.pdf'), 2);
  const oracle = squash(line!.text);
  expect(oracle.length).toBeGreaterThan(10);
  expect(squash(await reader.pageText(2))).toBe(oracle);
  expectAligned(await measureAlignment(reader.page, 2, line!.text), false, 'arabic', line!.text);
  await dragSelectText(reader.page, 2, line!.text);
  await expect
    .poll(async () => squash(await reader.selectionText()).length, { timeout: 20_000 })
    .toBeGreaterThan(oracle.length * 0.85);
  const selected = squash(await reader.selectionText());
  // Whatever the browser makes of mixed-direction spans, the selection is text of the page, in order.
  expect(oracle).toContain(selected);
  await reader.expectQuiet();
  await reader.page.close();
});

test('CJK with non-embedded CID fonts: the text is right (bundled cmaps work) and nothing is fetched from the web', async () => {
  const reader = await h.openReader(WINDOW);
  await reader.openReady('cjk-nonembedded-cmap.pdf');
  const info = accept('cjk-nonembedded-cmap.pdf');
  const text = squash(await reader.pageText(1));
  for (const line of info.lines) expect(text).toContain(squash(line.text));
  // Getting the text right proves the predefined CMaps were loaded from the extension's own
  // pdfjs/cmaps/ (nothing else could map these codes), and nothing else was fetched.
  expect(h.webRequests).toEqual([]);
  // A system CJK font draws them (Noto Sans CJK is installed here): something is on the canvas.
  const ink = await reader
    .pageEl(1)
    .locator('canvas')
    .first()
    .evaluate((canvas: HTMLCanvasElement) => {
      const { data } = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height);
      let dark = 0;
      for (let i = 0; i < data.length; i += 4) if (data[i]! < 100 && data[i + 3]! > 128) dark++;
      return dark;
    });
  expect(ink).toBeGreaterThan(200);
  // A real drag over the first line selects it.
  await dragSelectText(reader.page, 1, info.lines[0]!.text);
  await reader.expectSelection(info.lines[0]!.text, squash);
  await reader.expectQuiet();
  await reader.page.close();
});

/** RGB of the canvas pixel under PDF user-space point (xPt, yPt) of page `n` (unrotated page). */
async function colorAt(page: Page, n: number, xPt: number, yPt: number, pageHeightPt: number) {
  return page.evaluate(
    ({ pageNo, x, y, height }) => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        `.pdfViewer .page[data-page-number="${pageNo}"] canvas`,
      )!;
      const sx = canvas.width / canvas.getBoundingClientRect().width;
      const sy = canvas.height / canvas.getBoundingClientRect().height;
      const css = canvas.getBoundingClientRect().width / 612; // CSS px per point
      const px = Math.round(x * css * sx);
      const py = Math.round((height - y) * css * sy);
      const [r, g, b] = canvas.getContext('2d')!.getImageData(px, py, 1, 1).data;
      return [r!, g!, b!];
    },
    { pageNo: n, x: xPt, y: yPt, height: pageHeightPt },
  );
}

const near = (rgb: number[], want: number[], tolerance = 40): boolean =>
  rgb.every((v, i) => Math.abs(v - want[i]!) <= tolerance);

test('JPEG 2000 image (OpenJPEG wasm under the D-17 CSP): the four quadrants have the right colours at 100% and 150%', async () => {
  const reader = await h.openReader(WINDOW);
  await reader.openReady('image-jpx.pdf');
  for (const zoom of ['1', '1.5']) {
    await reader.setZoom(zoom);
    const probes: [string, number, number, number[]][] = [
      ['red', 136, 592, [255, 0, 0]],
      ['green', 264, 592, [0, 200, 0]],
      ['blue', 136, 464, [0, 0, 255]],
      ['black', 264, 464, [0, 0, 0]],
    ];
    for (const [name, x, y, want] of probes) {
      const got = await colorAt(reader.page, 1, x, y, 792);
      expect(near(got, want), `${name} at zoom ${zoom}: got ${got}`).toBe(true);
    }
  }
  await reader.expectQuiet();
  await reader.page.close();
});

test('JBIG2 image (wasm decoder): both black rectangles and the white background are where they belong', async () => {
  const reader = await h.openReader(WINDOW);
  await reader.openReady('image-jbig2.pdf');
  for (const zoom of ['1', '1.75']) {
    await reader.setZoom(zoom);
    // Source pixel (sx, sy) of the 64x32 bitmap -> PDF point; the image box is x 72, top y 628, 4 pt per pixel.
    const at = (sx: number, sy: number) =>
      colorAt(reader.page, 1, 72 + sx * 4 + 2, 628 - sy * 4 - 2, 792);
    expect(near(await at(16, 8), [0, 0, 0]), `rect 1 at zoom ${zoom}`).toBe(true);
    expect(near(await at(50, 24), [0, 0, 0]), `rect 2 at zoom ${zoom}`).toBe(true);
    expect(near(await at(48, 8), [255, 255, 255]), `white top right at zoom ${zoom}`).toBe(true);
    expect(near(await at(10, 24), [255, 255, 255]), `white bottom left at zoom ${zoom}`).toBe(true);
  }
  await reader.expectQuiet();
  await reader.page.close();
});

test('mixed fonts and producers: every authored line is present in the text layer (no missing or garbled text)', async () => {
  const reader = await h.openReader(WINDOW);
  for (const file of [
    'font-truetype-embedded.pdf',
    'font-gs-embedded.pdf',
    'cjk-truetype-embedded.pdf',
    'cjk-cff-type3.pdf',
    'columns-3.pdf',
    'context-pages.pdf',
  ]) {
    await reader.open(file);
    await reader.waitPhase('ready');
    await reader.waitFirstPage();
    const info = accept(file);
    const pages = Math.min(info.pages ?? 1, 3);
    for (let n = 1; n <= pages; n++) {
      await reader.goToPage(n);
      const text = squash(await reader.pageText(n));
      for (const line of pageLines(info, n)) {
        expect(text, `${file} page ${n}`).toContain(squash(line.text));
      }
    }
  }
  await reader.expectQuiet();
  await reader.page.close();
});

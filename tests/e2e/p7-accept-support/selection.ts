import type { Page } from '@playwright/test';

/**
 * Real-mouse text selection and geometry on the reader's text layer, for any page rotation,
 * script direction and span splitting.
 *
 * `locateText` finds `needle` in the text layer of page `pageNumber` by walking the layer's TEXT
 * NODES in DOM order and ignoring whitespace (the layer's span boundaries and spaces vary between
 * producers), then reports the client rectangles of the first and the last character. A drag from
 * inside the first glyph to inside the last glyph then selects exactly the needle.
 *
 * Why the drag starts and ends ON glyphs (not blank text-layer space): docs/decisions/spike-c-pdf.md
 * finding 3 (PDF.js resolves blank space relative to the previous selection focus).
 */
export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Located {
  first: Rect;
  last: Rect;
  /** Union of every character rectangle of the needle. */
  all: Rect;
  /** Characters of the needle found (whitespace removed). */
  length: number;
}

export type Viewer = Rect;

/** Scroll the needle into the middle of the viewer, then measure. Throws when it is not on the page. */
export async function locateText(
  page: Page,
  pageNumber: number,
  needle: string,
  options: { occurrence?: number; nfkc?: boolean } = {},
): Promise<Located & { viewer: Viewer }> {
  const result = await page.evaluate(
    ({ pageNo, text, occurrence, nfkc }) => {
      const layer = document.querySelector(
        `.pdfViewer .page[data-page-number="${pageNo}"] .textLayer`,
      );
      if (!layer) throw new Error(`no text layer on page ${pageNo}`);
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      const hay: string[] = [];
      const map: { node: Text; index: number }[] = [];
      for (
        let node = walker.nextNode() as Text | null;
        node;
        node = walker.nextNode() as Text | null
      ) {
        const data = node.data;
        for (let i = 0; i < data.length; i++) {
          if (!/\s/.test(data[i]!)) {
            // NFKC maps Kangxi radicals back to the ideographs they look like.
            const form = nfkc ? data[i]!.normalize('NFKC') : data[i]!;
            for (const unit of form) {
              hay.push(unit);
              map.push({ node, index: i });
            }
          }
        }
      }
      const target = (nfkc ? text.normalize('NFKC') : text).replace(/\s+/g, '');
      const joined = hay.join('');
      let at = -1;
      for (let n = 0; n <= occurrence; n++) {
        at = joined.indexOf(target, at + 1);
        if (at === -1) break;
      }
      if (at === -1) {
        throw new Error(
          `text not found on page ${pageNo}: ${JSON.stringify(text)} (layer has ${JSON.stringify(joined.slice(0, 160))})`,
        );
      }
      const startEntry = map[at]!;
      const endEntry = map[at + target.length - 1]!;
      const spanOf = (node: Text): HTMLElement => node.parentElement as HTMLElement;
      spanOf(startEntry.node).scrollIntoView({ block: 'center', inline: 'center' });
      const charRect = (entry: { node: Text; index: number }) => {
        const range = document.createRange();
        range.setStart(entry.node, entry.index);
        range.setEnd(entry.node, entry.index + 1);
        const r = range.getBoundingClientRect();
        return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
      };
      const all = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
      for (let k = at; k < at + target.length; k++) {
        const r = charRect(map[k]!);
        if (r.right - r.left === 0 && r.bottom - r.top === 0) continue;
        all.left = Math.min(all.left, r.left);
        all.top = Math.min(all.top, r.top);
        all.right = Math.max(all.right, r.right);
        all.bottom = Math.max(all.bottom, r.bottom);
      }
      const box = document.querySelector('[data-testid=viewer-container]')!.getBoundingClientRect();
      return {
        first: charRect(startEntry),
        last: charRect(endEntry),
        all,
        length: target.length,
        viewer: { left: box.left, top: box.top, right: box.right, bottom: box.bottom },
      };
    },
    {
      pageNo: pageNumber,
      text: needle,
      occurrence: options.occurrence ?? 0,
      nfkc: options.nfkc ?? false,
    },
  );
  return result;
}

const centre = (r: Rect): { x: number; y: number } => ({
  x: (r.left + r.right) / 2,
  y: (r.top + r.bottom) / 2,
});

function inside(r: Rect, viewer: Viewer): boolean {
  return (
    r.left >= viewer.left &&
    r.right <= viewer.right &&
    r.top >= viewer.top &&
    r.bottom <= viewer.bottom
  );
}

/**
 * Select `needle` with a real mouse drag from the leading part of its first glyph to the trailing
 * part of its last glyph, along the reading direction (derived from the two glyph positions, so
 * it works on 90/180/270 degree pages and right-to-left lines).
 */
export async function dragSelectText(
  page: Page,
  pageNumber: number,
  needle: string,
  options: { occurrence?: number; nfkc?: boolean } = {},
): Promise<void> {
  const located = await locateText(page, pageNumber, needle, options);
  const { first, last, viewer } = located;
  for (const r of [first, last]) {
    if (!inside(r, viewer)) {
      throw new Error(
        `dragSelectText: glyph outside the viewer ${JSON.stringify({ r, viewer })}; use a larger window`,
      );
    }
  }
  const a = centre(first);
  const b = centre(last);
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (dx === 0 && dy === 0) {
    // One glyph: the reading direction is unknown, assume left to right.
    dx = 1;
  }
  const norm = Math.hypot(dx, dy);
  dx /= norm;
  dy /= norm;
  // Extent of a glyph along the drag direction.
  const extent = (r: Rect): number =>
    Math.abs(dx) * (r.right - r.left) + Math.abs(dy) * (r.bottom - r.top);
  const from = { x: a.x - dx * extent(first) * 0.25, y: a.y - dy * extent(first) * 0.25 };
  const to = { x: b.x + dx * extent(last) * 0.3, y: b.y + dy * extent(last) * 0.3 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 10 });
  await page.mouse.move(to.x + 0.01, to.y);
  await page.mouse.up();
}

/** Double-click the first glyph run of `word` (selects the word, like a user). */
export async function dblclickWord(
  page: Page,
  pageNumber: number,
  word: string,
  options: { occurrence?: number } = {},
): Promise<void> {
  const located = await locateText(page, pageNumber, word, options);
  const middle = {
    left: (located.all.left + located.all.right) / 2,
    right: (located.all.left + located.all.right) / 2,
    top: (located.all.top + located.all.bottom) / 2,
    bottom: (located.all.top + located.all.bottom) / 2,
  };
  const c = centre(middle);
  await page.mouse.dblclick(c.x, c.y);
}

/** Click (once) in the middle of a located text. */
export async function clickText(
  page: Page,
  pageNumber: number,
  needle: string,
  options: { occurrence?: number } = {},
): Promise<{ x: number; y: number }> {
  const located = await locateText(page, pageNumber, needle, options);
  const c = centre(located.all);
  await page.mouse.click(c.x, c.y);
  return c;
}

export interface Alignment {
  /** Differences in CSS pixels between the text-layer glyph box and the ink drawn on the canvas. */
  leftDelta: number;
  rightDelta: number;
  topDelta: number;
  bottomDelta: number;
  /** Distance between the centres of the two boxes along each axis. */
  centerXDelta: number;
  centerYDelta: number;
  /** Ink pixels found inside the search area (0 means the canvas has no dark ink there). */
  inkPixels: number;
  lineThickness: number;
}

/**
 * Compare the text layer's glyph rectangle for `needle` with the bounding box of the dark pixels
 * that page's canvas actually drew in the same place. A shifted or mis-scaled text layer (the
 * classic failure with embedded fonts, rotation and zoom) shows up as a large delta.
 */
export async function measureAlignment(
  page: Page,
  pageNumber: number,
  needle: string,
): Promise<Alignment> {
  const located = await locateText(page, pageNumber, needle);
  return page.evaluate(
    ({ pageNo, box }) => {
      const pageEl = document.querySelector<HTMLElement>(
        `.pdfViewer .page[data-page-number="${pageNo}"]`,
      )!;
      const canvases = [...pageEl.querySelectorAll<HTMLCanvasElement>('canvas')];
      const canvas = canvases[0];
      if (!canvas) throw new Error('page canvas missing');
      const cr = canvas.getBoundingClientRect();
      const sx = canvas.width / cr.width;
      const sy = canvas.height / cr.height;
      const w = box.right - box.left;
      const h = box.bottom - box.top;
      const thin = Math.min(w, h);
      const vertical = h > w * 1.5;
      // Pad along the line by one glyph and across it by 45% of the thickness: neighbouring
      // lines (at least 1.6 line heights away in every fixture) never enter the search area.
      const padAlong = thin;
      const padAcross = thin * 0.45;
      const x0 = Math.max(
        0,
        Math.floor((box.left - (vertical ? padAcross : padAlong) - cr.left) * sx),
      );
      const x1 = Math.min(
        canvas.width,
        Math.ceil((box.right + (vertical ? padAcross : padAlong) - cr.left) * sx),
      );
      const y0 = Math.max(
        0,
        Math.floor((box.top - (vertical ? padAlong : padAcross) - cr.top) * sy),
      );
      const y1 = Math.min(
        canvas.height,
        Math.ceil((box.bottom + (vertical ? padAlong : padAcross) - cr.top) * sy),
      );
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('no 2d context');
      const { data, width } = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let ink = 0;
      for (let y = 0; y < y1 - y0; y++) {
        for (let x = 0; x < width; x++) {
          const o = (y * width + x) * 4;
          const luma = 0.299 * data[o]! + 0.587 * data[o + 1]! + 0.114 * data[o + 2]!;
          if (luma < 140 && data[o + 3]! > 128) {
            ink++;
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const cssX = (px: number) => cr.left + (x0 + px) / sx;
      const cssY = (px: number) => cr.top + (y0 + px) / sy;
      return {
        leftDelta: Math.abs(cssX(minX) - box.left),
        rightDelta: Math.abs(cssX(maxX + 1) - box.right),
        topDelta: Math.abs(cssY(minY) - box.top),
        bottomDelta: Math.abs(cssY(maxY + 1) - box.bottom),
        centerXDelta: Math.abs((cssX(minX) + cssX(maxX + 1)) / 2 - (box.left + box.right) / 2),
        centerYDelta: Math.abs((cssY(minY) + cssY(maxY + 1)) / 2 - (box.top + box.bottom) / 2),
        inkPixels: ink,
        lineThickness: thin,
      };
    },
    { pageNo: pageNumber, box: located.all },
  );
}

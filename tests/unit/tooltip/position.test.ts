import { describe, expect, it } from 'vitest';
import { placeToolbar } from '../../../components/tooltip/position';
import type { SelectionRects } from '../../../lib/selection/capture';

const size = { width: 100, height: 40 };
const viewport = { width: 800, height: 600 };

function rects(
  left: number,
  top: number,
  right: number,
  bottom: number,
  last = { left, top, right, bottom },
): SelectionRects {
  const first = { left, top, right, bottom };
  return {
    first,
    last,
    bounds: {
      left: Math.min(first.left, last.left),
      top: Math.min(first.top, last.top),
      right: Math.max(first.right, last.right),
      bottom: Math.max(first.bottom, last.bottom),
    },
  };
}

describe('placeToolbar', () => {
  it('sits above the first line, centred on it', () => {
    const placed = placeToolbar({ rects: rects(300, 300, 360, 320), size, viewport, dir: 'ltr' });
    expect(placed).toEqual({ left: 280, top: 252, side: 'above' });
  });

  it('goes below the last line when there is no room above', () => {
    const placed = placeToolbar({ rects: rects(300, 10, 360, 30), size, viewport, dir: 'ltr' });
    expect(placed?.side).toBe('below');
    expect(placed?.top).toBe(38);
  });

  it('goes below the last line of a multi-line selection that starts above the viewport', () => {
    const placed = placeToolbar({
      rects: rects(100, -50, 700, -30, { left: 100, top: 100, right: 400, bottom: 120 }),
      size,
      viewport,
      dir: 'ltr',
    });
    expect(placed?.side).toBe('below');
    expect(placed?.top).toBe(128);
  });

  it('clamps horizontally at every corner', () => {
    const topLeft = placeToolbar({ rects: rects(0, 300, 10, 320), size, viewport, dir: 'ltr' });
    const topRight = placeToolbar({ rects: rects(790, 300, 800, 320), size, viewport, dir: 'ltr' });
    expect(topLeft?.left).toBe(8);
    expect(topRight?.left).toBe(692);
  });

  it('keeps the toolbar inside the viewport in the bottom-right corner', () => {
    const placed = placeToolbar({ rects: rects(780, 570, 800, 590), size, viewport, dir: 'ltr' });
    expect(placed).toMatchObject({ side: 'above' });
    expect(placed!.left + size.width).toBeLessThanOrEqual(viewport.width - 8);
    expect(placed!.top + size.height).toBeLessThanOrEqual(viewport.height - 8);
  });

  it('floats at the bottom edge when the selection fills the viewport and its end is not visible', () => {
    const placed = placeToolbar({
      rects: rects(0, 0, 800, 20, { left: 0, top: 640, right: 800, bottom: 660 }),
      size,
      viewport,
      dir: 'ltr',
    });
    expect(placed).toEqual({ left: 0 + 8, top: 552, side: 'overlay' });
  });

  it('stays near the selection end when it fills the viewport but the last line is on screen', () => {
    const placed = placeToolbar({
      rects: rects(0, 0, 800, 20, { left: 0, top: 580, right: 800, bottom: 600 }),
      size,
      viewport,
      dir: 'ltr',
    });
    // Over the line above the last one: 580 - 40 - 8.
    expect(placed).toMatchObject({ side: 'overlay', top: 532 });
  });

  it('tucks against the start edge of a very wide first line, per reading direction', () => {
    const wide = rects(50, 300, 750, 320);
    expect(placeToolbar({ rects: wide, size, viewport, dir: 'ltr' })?.left).toBe(50);
    expect(placeToolbar({ rects: wide, size, viewport, dir: 'rtl' })?.left).toBe(650);
  });

  it('returns null when the selection is scrolled out of view', () => {
    expect(
      placeToolbar({ rects: rects(100, -200, 200, -180), size, viewport, dir: 'ltr' }),
    ).toBeNull();
    expect(
      placeToolbar({ rects: rects(100, 700, 200, 720), size, viewport, dir: 'ltr' }),
    ).toBeNull();
  });

  it('survives a toolbar wider than the viewport', () => {
    const placed = placeToolbar({
      rects: rects(10, 300, 20, 320),
      size: { width: 900, height: 40 },
      viewport,
      dir: 'ltr',
    });
    expect(placed?.left).toBe(8);
  });
});

describe('placeToolbar near the selection end', () => {
  const multi = rects(100, 300, 700, 320, { left: 100, top: 322, right: 500, bottom: 342 });

  it('puts a multi-line selection toolbar BELOW the last line, tucked at its end (LTR)', () => {
    const placed = placeToolbar({ rects: multi, size, viewport, dir: 'ltr' });
    expect(placed).toEqual({ left: 400, top: 350, side: 'below' });
  });

  it('tucks it at the left end of the last line for right-to-left text', () => {
    const placed = placeToolbar({ rects: multi, size, viewport, dir: 'rtl' });
    expect(placed).toEqual({ left: 100, top: 350, side: 'below' });
  });

  it('falls back to above the first line when there is no room below', () => {
    const low = rects(100, 500, 700, 520, { left: 100, top: 560, right: 500, bottom: 580 });
    const placed = placeToolbar({ rects: low, size, viewport, dir: 'ltr' });
    expect(placed?.side).toBe('above');
    expect(placed?.top).toBe(452);
  });

  it('keeps a one-line selection above its line, as before', () => {
    expect(
      placeToolbar({ rects: rects(300, 300, 360, 320), size, viewport, dir: 'ltr' })?.side,
    ).toBe('above');
  });
});

describe('placeToolbar and page elements on top of the selection', () => {
  const single = rects(300, 70, 360, 90);

  it('goes below when the box above would sit on a fixed header', () => {
    const placed = placeToolbar({
      rects: rects(300, 90, 360, 110),
      size,
      viewport,
      dir: 'ltr',
      isCovered: (box) => box.top < 64,
    });
    expect(placed).toMatchObject({ side: 'below', top: 118 });
  });

  it('does not anchor to a first line that is hidden behind the header', () => {
    const multi = rects(100, 20, 700, 40, { left: 100, top: 300, right: 500, bottom: 320 });
    const placed = placeToolbar({
      rects: multi,
      size,
      viewport,
      dir: 'ltr',
      isCovered: (box) => box.bottom < 64,
    });
    expect(placed?.side).toBe('below');
  });

  it('hides the toolbar when the whole selection is behind a page element', () => {
    expect(
      placeToolbar({ rects: single, size, viewport, dir: 'ltr', isCovered: () => true }),
    ).toBeNull();
  });

  it('still places it when covering cannot be avoided on either side (relaxed pass)', () => {
    const placed = placeToolbar({
      rects: single,
      size,
      viewport,
      dir: 'ltr',
      isCovered: (box) => box !== single.first && box !== single.last,
    });
    expect(placed).not.toBeNull();
  });
});

describe('placeToolbar while pinch-zoomed', () => {
  it('uses the visible area, whose origin is not the layout viewport origin', () => {
    const visible = { left: 400, top: 300, width: 200, height: 150 };
    const placed = placeToolbar({
      rects: rects(420, 320, 440, 340),
      size,
      viewport: visible,
      dir: 'ltr',
    });
    // Above would be 320 - 48 = 272, outside the visible area (top 300): goes below.
    expect(placed).toMatchObject({ side: 'below', top: 348 });
    expect(placed!.left).toBeGreaterThanOrEqual(408);
    expect(placed!.left + size.width).toBeLessThanOrEqual(592);
  });

  it('hides when the selection is outside the visible area', () => {
    expect(
      placeToolbar({
        rects: rects(100, 100, 120, 120),
        size,
        viewport: { left: 400, top: 300, width: 200, height: 150 },
        dir: 'ltr',
      }),
    ).toBeNull();
  });
});

describe('placeToolbar for vertical writing modes (FR-012)', () => {
  // Three columns of a vertical-rl paragraph: the first (right) to the last (left), DOM order.
  const columns = rects(600, 100, 620, 400, { left: 540, top: 100, right: 560, bottom: 260 });
  const overlapsAny = (box: { left: number; top: number }): boolean =>
    [columns.first, columns.last].some(
      (c) =>
        box.left < c.right &&
        box.left + size.width > c.left &&
        box.top < c.bottom &&
        box.top + size.height > c.top,
    );

  it('vertical-rl: goes to the LEFT of the last column (block end), never over the text', () => {
    const placed = placeToolbar({ rects: columns, size, viewport, dir: 'ltr', vertical: 'rl' });
    expect(placed).toMatchObject({ side: 'beside', left: 540 - 100 - 8 });
    expect(overlapsAny(placed!)).toBe(false);
  });

  it('vertical-lr: goes to the RIGHT of the last column', () => {
    const lr = rects(100, 100, 120, 400, { left: 160, top: 100, right: 180, bottom: 260 });
    const placed = placeToolbar({ rects: lr, size, viewport, dir: 'ltr', vertical: 'lr' });
    expect(placed).toMatchObject({ side: 'beside', left: 188 });
  });

  it('centres on a short last column and tucks at the bottom end of a tall one', () => {
    const short = rects(600, 100, 620, 160, { left: 540, top: 100, right: 560, bottom: 160 });
    expect(placeToolbar({ rects: short, size, viewport, dir: 'ltr', vertical: 'rl' })?.top).toBe(
      110,
    );
    const tall = rects(600, 100, 620, 500, { left: 540, top: 100, right: 560, bottom: 500 });
    expect(placeToolbar({ rects: tall, size, viewport, dir: 'ltr', vertical: 'rl' })?.top).toBe(
      460,
    );
  });

  it('uses the start side (right of the first column for vertical-rl) when the end side has no room', () => {
    const edge = rects(300, 100, 320, 400, { left: 40, top: 100, right: 60, bottom: 260 });
    const placed = placeToolbar({ rects: edge, size, viewport, dir: 'ltr', vertical: 'rl' });
    expect(placed).toMatchObject({ side: 'beside', left: 328 });
  });

  it('falls back to above or below the whole selection when nothing fits sideways', () => {
    const placed = placeToolbar({
      rects: rects(10, 300, 140, 380),
      size,
      viewport: { width: 150, height: 600 },
      dir: 'ltr',
      vertical: 'rl',
    });
    expect(placed?.side).toBe('above');
  });

  it('avoids a covered spot beside the selection when the other side is clear', () => {
    const placed = placeToolbar({
      rects: columns,
      size,
      viewport,
      dir: 'ltr',
      vertical: 'rl',
      isCovered: (box) => box.right <= 540,
    });
    expect(placed).toMatchObject({ side: 'beside', left: 628 });
  });
});

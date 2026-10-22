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

  it('floats at the bottom edge when the selection fills the viewport', () => {
    const placed = placeToolbar({
      rects: rects(0, 0, 800, 20, { left: 0, top: 580, right: 800, bottom: 600 }),
      size,
      viewport,
      dir: 'ltr',
    });
    expect(placed?.side).toBe('overlay');
    expect(placed?.top).toBe(552);
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

import type { Box, SelectionRects } from '../../lib/selection/capture';

export interface Size {
  width: number;
  height: number;
}

export interface Placement {
  left: number;
  top: number;
  /**
   * `above`: over the first line. `below`: under the last line. `overlay`: neither
   * fits (selection fills the viewport), so the toolbar floats at the bottom edge.
   */
  side: 'above' | 'below' | 'overlay';
}

export interface PlaceOptions {
  rects: SelectionRects;
  size: Size;
  viewport: Size;
  dir: 'ltr' | 'rtl';
  /** Space between the selection and the toolbar. */
  gap?: number;
  /** Minimum distance from every viewport edge. */
  margin?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function isVisible(box: Box, viewport: Size): boolean {
  return box.bottom > 0 && box.top < viewport.height && box.right > 0 && box.left < viewport.width;
}

/**
 * Where to put the toolbar, in viewport coordinates (it is `position: fixed`).
 * Returns null when the selection is entirely outside the viewport.
 *
 * Preference: above the first line, else below the last line, else floating at
 * the bottom edge. Horizontally it is centred on the first line, or tucked
 * against the reading-direction start when that line is very wide.
 */
export function placeToolbar(options: PlaceOptions): Placement | null {
  const { rects, size, viewport, dir } = options;
  const gap = options.gap ?? 8;
  const margin = options.margin ?? 8;
  if (!isVisible(rects.bounds, viewport)) return null;

  const { first, last } = rects;
  const firstWidth = first.right - first.left;
  const anchorX =
    firstWidth <= size.width * 2
      ? first.left + firstWidth / 2
      : dir === 'rtl'
        ? first.right - size.width / 2
        : first.left + size.width / 2;
  const left = clamp(anchorX - size.width / 2, margin, viewport.width - size.width - margin);

  const above = first.top - size.height - gap;
  if (above >= margin && first.bottom > 0) return { left, top: above, side: 'above' };

  const below = last.bottom + gap;
  if (below + size.height <= viewport.height - margin && last.top < viewport.height) {
    return { left, top: below, side: 'below' };
  }

  return {
    left,
    top: clamp(viewport.height - size.height - margin, margin, viewport.height),
    side: 'overlay',
  };
}

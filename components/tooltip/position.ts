import type { Box, SelectionRects } from '../../lib/selection/capture';

export interface Size {
  width: number;
  height: number;
}

/** The visible area, in the coordinates the toolbar is positioned in (the layout viewport). */
export interface Viewport extends Size {
  /** Offset of the visible area; non-zero while the page is pinch-zoomed. */
  left?: number;
  top?: number;
}

export interface Placement {
  left: number;
  top: number;
  /**
   * `above`: over the first line. `below`: under the last line. `beside`: next to the columns of
   * vertical text. `overlay`: neither
   * fits (selection fills the viewport), so the toolbar sits over the line above the selection's
   * last one, or floats at the bottom edge.
   */
  side: 'above' | 'below' | 'beside' | 'overlay';
}

export interface PlaceOptions {
  rects: SelectionRects;
  size: Size;
  viewport: Viewport;
  dir: 'ltr' | 'rtl';
  /** Vertical writing mode (`vertical-rl` or `vertical-lr`): lines are columns, stacked sideways. */
  vertical?: 'rl' | 'lr';
  /** Space between the selection and the toolbar. */
  gap?: number;
  /** Minimum distance from every viewport edge. */
  margin?: number;
  /**
   * True when a page element that is not part of the selection (a fixed or sticky header, a
   * cookie banner) sits on top of this box. The toolbar then avoids anchoring to hidden text
   * and avoids landing on such an element.
   */
  isCovered?: (box: Box) => boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

function isVisible(box: Box, view: Box): boolean {
  return (
    box.bottom > view.top && box.top < view.bottom && box.right > view.left && box.left < view.right
  );
}

/**
 * Where to put the toolbar, in viewport coordinates (it is `position: fixed`).
 * Returns null when the selection is entirely outside the visible area or hidden behind a
 * page element.
 *
 * A one-line selection gets the toolbar above it, else below. A multi-line one gets it below
 * the LAST line, at the selection's end (where the user's pointer or caret is), else above the
 * first line. The toolbar never lands on the selected text unless the selection fills the
 * viewport, in which case it floats at the bottom edge. Horizontally it is centred on its
 * anchor line, or tucked against the end (below) or start (above) edge of a very wide line,
 * per reading direction.
 */
export function placeToolbar(options: PlaceOptions): Placement | null {
  const { rects, size, dir } = options;
  const gap = options.gap ?? 8;
  const margin = options.margin ?? 8;
  const view: Box = {
    left: options.viewport.left ?? 0,
    top: options.viewport.top ?? 0,
    right: (options.viewport.left ?? 0) + options.viewport.width,
    bottom: (options.viewport.top ?? 0) + options.viewport.height,
  };
  if (!isVisible(rects.bounds, view)) return null;

  const covered = (box: Box): boolean => options.isCovered?.(box) === true;
  if (covered(rects.first) && covered(rects.last)) return null;

  if (options.vertical !== undefined) {
    // Lines are columns: above or below would land on the next columns. Go BESIDE the selection,
    // at its end (the block-end side: left for vertical-rl) else its start, aligned with that column.
    const rl = options.vertical === 'rl';
    const beside = (line: Box, after: boolean): Placement | null => {
      const left = after === rl ? line.left - size.width - gap : line.right + gap;
      const high = line.bottom - line.top;
      const centre = line.top + high / 2;
      const y =
        high <= size.height * 2
          ? centre
          : after
            ? line.bottom - size.height / 2
            : line.top + size.height / 2;
      const top = clamp(y - size.height / 2, view.top + margin, view.bottom - size.height - margin);
      const box = { left, top, right: left + size.width, bottom: top + size.height };
      if (left < view.left + margin || box.right > view.right - margin) return null;
      return covered(box) ? null : { left, top, side: 'beside' };
    };
    const placed = beside(rects.last, true) ?? beside(rects.first, false);
    if (placed !== null) return placed;
  }
  // Vertical text that has no room beside it falls back to above or below the whole selection.
  const { first, last } =
    options.vertical === undefined ? rects : { first: rects.bounds, last: rects.bounds };
  const firstHidden = covered(first);
  const lastHidden = covered(last);

  const minLeft = view.left + margin;
  const maxLeft = view.right - size.width - margin;
  const leftFor = (line: Box, edge: 'start' | 'end'): number => {
    const width = line.right - line.left;
    const tuckRight = (edge === 'end') === (dir === 'ltr');
    const anchorX =
      width <= size.width * 2
        ? line.left + width / 2
        : tuckRight
          ? line.right - size.width / 2
          : line.left + size.width / 2;
    return clamp(anchorX - size.width / 2, minLeft, maxLeft);
  };

  const aboveFirst = (strict: boolean): Placement | null => {
    const top = first.top - size.height - gap;
    if (top < view.top + margin || first.bottom <= view.top) return null;
    const left = leftFor(first, 'start');
    const box = { left, top, right: left + size.width, bottom: top + size.height };
    return strict && (firstHidden || covered(box)) ? null : { left, top, side: 'above' };
  };
  const belowLast = (strict: boolean): Placement | null => {
    const top = last.bottom + gap;
    if (top + size.height > view.bottom - margin || last.top >= view.bottom) return null;
    const left = leftFor(last, 'end');
    const box = { left, top, right: left + size.width, bottom: top + size.height };
    return strict && (lastHidden || covered(box)) ? null : { left, top, side: 'below' };
  };

  const multiLine = last.top > first.top + (first.bottom - first.top) / 2;
  const order = multiLine ? [belowLast, aboveFirst] : [aboveFirst, belowLast];
  for (const strict of [true, false]) {
    for (const candidate of order) {
      const placed = candidate(strict);
      if (placed !== null) return placed;
    }
  }

  // Nothing fits (the selection fills the viewport): stay near its END, over the line above the
  // last one when that line is on screen, else float at the bottom edge.
  const aboveLast = last.top - size.height - gap;
  if (aboveLast >= view.top + margin && last.top < view.bottom && !lastHidden) {
    return { left: leftFor(last, 'end'), top: aboveLast, side: 'overlay' };
  }
  return {
    left: leftFor(first, 'start'),
    top: clamp(view.bottom - size.height - margin, view.top + margin, view.bottom),
    side: 'overlay',
  };
}

/**
 * Reader keyboard shortcuts as a pure mapping, so they can be unit tested without a browser.
 *
 * Design rules:
 * - Nothing is handled while no document is open: Ctrl/Cmd+F then reaches Chrome's own find.
 * - Plain keys never act inside a text field, select or editable element (typing "n" in the find
 *   box must type "n"). Ctrl/Cmd+F is the one exception: it focuses the find box from anywhere.
 * - Browser shortcuts stay the browser's: Ctrl/Cmd/Alt combinations are ignored except the ones
 *   named here (find, Ctrl+Home/End).
 * - Scrolling keys (PageUp/PageDown/Home/End) scroll the viewer by a screenful even when focus is
 *   on a toolbar button, so keyboard users never have to tab into the page area first.
 *   Page-by-page navigation is `n`/`j` and `p`/`k` (PDF.js's own keys) and Ctrl+Home/End.
 */
export type ReaderCommand =
  | 'next-page'
  | 'previous-page'
  | 'first-page'
  | 'last-page'
  | 'scroll-down'
  | 'scroll-up'
  | 'scroll-start'
  | 'scroll-end'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-actual'
  | 'open-find'
  | 'find-next'
  | 'find-previous'
  | 'close-find';

export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export interface ShortcutContext {
  /** A document is on screen (ready or image-only) and no dialog is open. */
  hasDocument: boolean;
  findOpen: boolean;
  /** The event target is a text field, select or editable element. */
  editable: boolean;
  /** Focus is inside the find bar (Escape closes it only from there). */
  inFindBar: boolean;
}

export function commandForKey(event: KeyEventLike, context: ShortcutContext): ReaderCommand | null {
  if (!context.hasDocument) return null;
  const key = event.key;
  const primary = event.ctrlKey || event.metaKey;

  if (primary && !event.altKey && (key === 'f' || key === 'F')) return 'open-find';
  if (key === 'Escape' && context.findOpen && context.inFindBar && !primary && !event.altKey) {
    return 'close-find';
  }
  if (context.findOpen && !event.altKey) {
    if (key === 'F3' && !primary) return event.shiftKey ? 'find-previous' : 'find-next';
    if (primary && (key === 'g' || key === 'G'))
      return event.shiftKey ? 'find-previous' : 'find-next';
  }
  if (context.editable || event.altKey) return null;

  if (primary) {
    if (event.shiftKey) return null;
    if (key === 'Home') return 'first-page';
    if (key === 'End') return 'last-page';
    return null;
  }

  switch (key) {
    case 'PageDown':
      return event.shiftKey ? null : 'scroll-down';
    case 'PageUp':
      return event.shiftKey ? null : 'scroll-up';
    case 'Home':
      return event.shiftKey ? null : 'scroll-start';
    case 'End':
      return event.shiftKey ? null : 'scroll-end';
    case 'n':
    case 'j':
      return 'next-page';
    case 'p':
    case 'k':
      return 'previous-page';
    case '+':
    case '=':
      return 'zoom-in';
    case '-':
    case '_':
      return 'zoom-out';
    case '0':
      return 'zoom-actual';
    default:
      return null;
  }
}

/** Fraction of the viewer height a PageUp/PageDown scrolls (keeps a little overlap for context). */
export const SCROLL_PAGE_FRACTION = 0.9;

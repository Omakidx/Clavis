import { captureSelection, type CapturedSelection } from './capture';
import { hasSelection } from './composed';
import { isOwnUiNode } from './own-ui';
import { isTrustedEvent } from './trust';

/**
 * How long a real (trusted) mouseup/keyup keeps authorizing a capture. A page can still
 * time a programmatic selection to a genuine user gesture, but it can no longer show the
 * toolbar on its own, with synthetic events or by itself (security review HIGH-1).
 */
const TRUST_WINDOW_MS = 1500;

export interface ObserverTimings {
  /** After `selectionchange` with nothing else going on (touch handles, menus, programmatic). */
  change: number;
  /** After `keyup` (shift+arrow, ctrl+A). */
  key: number;
  /** After `mouseup`: the selection is final, capture as soon as the event finishes. */
  pointer: number;
}

export const DEFAULT_TIMINGS: ObserverTimings = { change: 120, key: 40, pointer: 0 };

export interface SelectionObserverOptions {
  win?: Window;
  timings?: Partial<ObserverTimings>;
  /** A new, different, qualifying selection was captured. */
  onSelection(selection: CapturedSelection): void;
  /** The selection went away, collapsed or stopped qualifying. */
  onClear(): void;
}

export interface SelectionObserver {
  /**
   * Capture the current selection right now (context-menu and toolbar-icon
   * paths) and return it WITHOUT calling `onSelection`: the caller presents it.
   */
  captureNow(): CapturedSelection | null;
  /**
   * The toolbar was dismissed with Escape: let the next real click ON the same selection (an
   * instantaneous double-click on the selected word leaves it unchanged) show the toolbar again.
   */
  allowReshow(): void;
  stop(): void;
}

function insideOwnUi(event: Event): boolean {
  return event.composedPath().some((node) => isOwnUiNode(node as Node));
}

export function sameRange(a: Range, b: Range): boolean {
  try {
    return (
      a.compareBoundaryPoints(Range.START_TO_START, b) === 0 &&
      a.compareBoundaryPoints(Range.END_TO_END, b) === 0
    );
  } catch {
    // Ranges in different trees (document versus a shadow root) are never the same selection.
    return false;
  }
}

/** Whether the pointer was released on the selected text (by position, so shadow roots work too). */
function pressedOn(range: Range, { clientX: x, clientY: y }: MouseEvent): boolean {
  return Array.from(range.getClientRects()).some(
    (r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1,
  );
}

/**
 * Framework-free selection observer. It does no work until the user selects
 * something: the listeners only look at `Selection.isCollapsed` before they
 * schedule anything.
 */
export function startSelectionObserver(options: SelectionObserverOptions): SelectionObserver {
  const win = options.win ?? window;
  const doc = win.document;
  const timings = { ...DEFAULT_TIMINGS, ...options.timings };

  let timer: number | undefined;
  let dueAt = 0;
  let pointerDown = false;
  /** Time of the last mouseup/keyup the browser created from real input. */
  let lastTrustedAt = Number.NEGATIVE_INFINITY;
  let last: CapturedSelection | null = null;
  let reshow = false;

  /** `silent` records the capture without notifying (the caller presents it itself). */
  function evaluate(silent: boolean, mayShow = true): CapturedSelection | null {
    const captured = captureSelection(win);
    if (captured === null) {
      if (last !== null) {
        last = null;
        if (!silent) options.onClear();
      }
      return null;
    }
    // Nothing real happened: a page-made selection must not raise the toolbar. It must not leave
    // the toolbar sitting on the OLD text either: a different selection clears it.
    if (!mayShow) {
      if (last !== null && !sameRange(last.range, captured.range)) {
        last = null;
        if (!silent) options.onClear();
      }
      return null;
    }
    if (!silent && last !== null && sameRange(last.range, captured.range)) return last;
    last = captured;
    if (!silent) options.onSelection(captured);
    return captured;
  }

  /**
   * Debounce that only ever moves the capture EARLIER. A late `selectionchange`
   * (browsers fire it after the fact) must not postpone a capture that `mouseup`
   * or `keyup` already asked for.
   */
  function schedule(delay: number): void {
    const due = Date.now() + delay;
    if (timer !== undefined) {
      if (due >= dueAt) return;
      win.clearTimeout(timer);
    }
    dueAt = due;
    timer = win.setTimeout(() => {
      timer = undefined;
      evaluate(false, Date.now() - lastTrustedAt <= TRUST_WINDOW_MS);
    }, delay);
  }

  /** Nothing selected and nothing shown: the event cannot matter. */
  function idle(): boolean {
    return last === null && !hasSelection(win.getSelection());
  }

  const onSelectionChange = (): void => {
    // While dragging, `mouseup` reports the final selection; capturing now would flicker.
    if (pointerDown || idle()) return;
    schedule(timings.change);
  };
  const onMouseDown = (event: Event): void => {
    // A synthetic mousedown must not be able to park the observer in "dragging".
    if (!isTrustedEvent(event) || insideOwnUi(event)) return;
    pointerDown = true;
  };
  const onMouseUp = (event: Event): void => {
    if (!isTrustedEvent(event) || insideOwnUi(event)) return;
    pointerDown = false;
    lastTrustedAt = Date.now();
    if (reshow && last !== null && pressedOn(last.range, event as MouseEvent)) last = null;
    reshow = false;
    if (idle()) return;
    schedule(timings.pointer);
  };
  const onKeyUp = (event: Event): void => {
    if (!isTrustedEvent(event) || insideOwnUi(event)) return;
    lastTrustedAt = Date.now();
    if (idle()) return;
    schedule(timings.key);
  };

  doc.addEventListener('selectionchange', onSelectionChange);
  doc.addEventListener('mousedown', onMouseDown, true);
  doc.addEventListener('mouseup', onMouseUp, true);
  doc.addEventListener('keyup', onKeyUp, true);
  // A release outside the window never reaches `mouseup`.
  const onBlur = (): void => {
    pointerDown = false;
  };
  win.addEventListener('blur', onBlur);

  return {
    captureNow: () => evaluate(true),
    allowReshow() {
      reshow = true;
    },
    stop() {
      if (timer !== undefined) win.clearTimeout(timer);
      timer = undefined;
      last = null;
      reshow = false;
      doc.removeEventListener('selectionchange', onSelectionChange);
      doc.removeEventListener('mousedown', onMouseDown, true);
      doc.removeEventListener('mouseup', onMouseUp, true);
      doc.removeEventListener('keyup', onKeyUp, true);
      win.removeEventListener('blur', onBlur);
    },
  };
}

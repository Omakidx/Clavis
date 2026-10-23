import { LIMITS } from '../config/constants';
import type { SelectionKind, SelectionSnapshot } from '../contracts/selection';
import { classifySelection } from './classify';
import { extractContext } from './context';
import {
  isEditableSelection,
  isOwnUiSelection,
  isRangeRendered,
  isSupportedDocument,
} from './eligibility';
import { selectionRange } from './composed';
import { newSelectionId } from './ids';
import { normalizeText, trimToWordBoundary, truncateText } from './text';

/** Viewport-relative box, in CSS pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface SelectionRects {
  /** First rendered line box of the selection (placement anchor above). */
  first: Box;
  /** Last rendered line box of the selection (placement anchor below). */
  last: Box;
  /** Union of all boxes. */
  bounds: Box;
}

/** A selection captured once, at selection end. Never re-read from the live Selection. */
export interface CapturedSelection {
  snapshot: SelectionSnapshot;
  /** The selection was longer than `LIMITS.maxSelectionChars`; the snapshot holds the prefix. */
  overLimit: boolean;
  /**
   * Normalized text beyond the snapshot's prefix (at most a few times the limit), kept only for
   * an over-limit selection: the source of the "Use the first 2,000 characters" cut.
   */
  fullText?: string;
  /** Reading direction of the selected text, for toolbar layout. */
  dir: 'ltr' | 'rtl';
  /** Set for vertical writing modes: the block-flow direction (`rl`: columns run right to left). */
  vertical?: 'rl' | 'lr';
  /** Independent (live) clone of the selected range, kept so the toolbar can follow scrolling. */
  range: Range;
  /** Current viewport rects, or null when the range is gone or no longer rendered. */
  getRects(): SelectionRects | null;
}

const LANG_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/;
/** Read at most this much raw selection text before normalizing (bounds select-all cost). */
const MAX_RAW_CHARS = LIMITS.maxSelectionChars * 4;

function toBox(rect: DOMRect): Box {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function union(a: Box, b: Box): Box {
  return {
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  };
}

/**
 * Rendered boxes of a range, or null if it has none. Zero-width boxes (a line end, the start of
 * the next block after a triple-click) are ignored while any box has width: they would move the
 * toolbar's anchor to a line that is not selected.
 */
export function measureRange(range: Range): SelectionRects | null {
  const all = Array.from(range.getClientRects());
  const wide = all.filter((rect) => rect.width >= 1 && rect.height > 0);
  const boxes = (
    wide.length > 0 ? wide : all.filter((rect) => rect.width > 0 || rect.height > 0)
  ).map(toBox);
  const first = boxes[0];
  const last = boxes[boxes.length - 1];
  if (first === undefined || last === undefined) return null;
  return { first, last, bounds: boxes.reduce(union) };
}

function languageHintFor(el: Element | null, doc: Document): string | undefined {
  const lang = el?.closest('[lang]')?.getAttribute('lang') ?? doc.documentElement.lang;
  return lang !== '' && LANG_TAG.test(lang) ? lang : undefined;
}

function directionOf(el: Element | null, win: Window): 'ltr' | 'rtl' {
  return el !== null && win.getComputedStyle(el).direction === 'rtl' ? 'rtl' : 'ltr';
}

const VERTICAL_MODE = /^(?:vertical|sideways)-(rl|lr)$/;

function verticalOf(el: Element | null, win: Window): { vertical?: 'rl' | 'lr' } {
  const flow = el === null ? null : VERTICAL_MODE.exec(win.getComputedStyle(el).writingMode)?.[1];
  return flow === 'rl' || flow === 'lr' ? { vertical: flow } : {};
}

/**
 * Capture the current user selection, or null when it does not qualify:
 * collapsed, in an editable field, hidden, inside Clavis's own UI, or on an
 * unsupported document. Pure local work; nothing leaves the page (FR-017).
 */
export function captureSelection(win: Window = window): CapturedSelection | null {
  const doc = win.document;
  if (!isSupportedDocument(doc)) return null;
  const selection = win.getSelection();
  if (selection === null) return null;
  // Resolved through getComposedRanges, so a selection inside an open shadow root works too.
  const range = selectionRange(selection);
  if (range === null || range.collapsed) return null;
  if (isEditableSelection(selection, doc, range) || isOwnUiSelection(selection)) return null;
  if (!isRangeRendered(range)) return null;

  // `Selection#toString` also covers text inside shadow roots, which a retargeted Range cannot.
  const normalized = normalizeText(selection.toString().slice(0, MAX_RAW_CHARS));
  if (normalized === '') return null;

  const overLimit = normalized.length > LIMITS.maxSelectionChars;
  const text = truncateText(normalized, LIMITS.maxSelectionChars);
  const anchor = range.commonAncestorContainer;
  const el = anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement;
  const languageHint = languageHintFor(el, doc);
  const kind: SelectionKind = overLimit ? 'passage' : classifySelection(text, languageHint);
  const context = extractContext(range);

  const snapshot: SelectionSnapshot = {
    selectionId: newSelectionId(),
    source: 'webpage',
    kind,
    text,
    ...(context.before === '' ? {} : { contextBefore: context.before }),
    ...(context.after === '' ? {} : { contextAfter: context.after }),
    ...(languageHint === undefined ? {} : { languageHint }),
  };

  return {
    snapshot,
    overLimit,
    ...(overLimit ? { fullText: normalized } : {}),
    dir: directionOf(el, win),
    ...verticalOf(el, win),
    range,
    getRects: () => (range.collapsed ? null : measureRange(range)),
  };
}

/**
 * "Use the first 2,000 characters": the same selection, cut on a word boundary. It is a NEW
 * snapshot (new `selectionId`, so a response to the long one can never match it) without
 * `contextAfter`, which described text beyond the cut. Nothing is sent by this step.
 */
export function trimCaptured(captured: CapturedSelection): CapturedSelection {
  const { fullText, snapshot } = captured;
  const { contextBefore, languageHint, page } = snapshot;
  const text = trimToWordBoundary(fullText ?? snapshot.text, LIMITS.maxSelectionChars);
  return {
    snapshot: {
      selectionId: newSelectionId(),
      source: snapshot.source,
      kind: classifySelection(text, languageHint),
      text,
      ...(contextBefore === undefined ? {} : { contextBefore }),
      ...(languageHint === undefined ? {} : { languageHint }),
      ...(page === undefined ? {} : { page }),
    },
    overLimit: false,
    dir: captured.dir,
    ...(captured.vertical === undefined ? {} : { vertical: captured.vertical }),
    range: captured.range,
    getRects: captured.getRects,
  };
}

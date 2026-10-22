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
import { newSelectionId } from './ids';
import { normalizeText, truncateText } from './text';

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
  /** Reading direction of the selected text, for toolbar layout. */
  dir: 'ltr' | 'rtl';
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

/** Rendered boxes of a range, or null if it has none. */
export function measureRange(range: Range): SelectionRects | null {
  const boxes = Array.from(range.getClientRects())
    .filter((rect) => rect.width > 0 || rect.height > 0)
    .map(toBox);
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

/**
 * Capture the current user selection, or null when it does not qualify:
 * collapsed, in an editable field, hidden, inside Clavis's own UI, or on an
 * unsupported document. Pure local work; nothing leaves the page (FR-017).
 */
export function captureSelection(win: Window = window): CapturedSelection | null {
  const doc = win.document;
  if (!isSupportedDocument(doc)) return null;
  const selection = win.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  if (isEditableSelection(selection, doc) || isOwnUiSelection(selection)) return null;

  const range = selection.getRangeAt(0).cloneRange();
  if (!isRangeRendered(range)) return null;

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
    dir: directionOf(el, win),
    range,
    getRects: () => (range.collapsed ? null : measureRange(range)),
  };
}

import { LIMITS } from '../config/constants';
import type { SelectionKind, SelectionSnapshot } from '../contracts/selection';
import type { Box, CapturedSelection, SelectionRects } from '../selection/capture';
import { classifySelection } from '../selection/classify';
import { isEditableSelection, isOwnUiSelection, isRangeRendered } from '../selection/eligibility';
import { newSelectionId } from '../selection/ids';
import { normalizeText, truncateText } from '../selection/text';
import { extractPdfContext } from './context';
import { normalizeKangxiRadicals } from './radicals';

/**
 * Selection capture for the PDF reader (FR-053): the same `CapturedSelection` the webpage observer
 * produces, so the shared toolbar, Listen and the explanation card treat it identically. What
 * differs is the source (`'pdf'`), the page number and where the context comes from
 * (lib/pdf/context.ts: the same page only).
 *
 * Eligibility is `captureSelection`'s, minus the document-protocol check (the reader is an
 * extension page) plus "both ends inside a PDF.js text layer of THIS viewer".
 */

/** Read at most this much raw selection text before normalizing (bounds select-all cost). */
export const RAW_SELECTION_CAP = LIMITS.maxSelectionChars * 4;

const LANG_TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/;

function elementOf(node: Node | null): Element | null {
  if (node === null) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** The `.textLayer` that holds `node`, when it belongs to `root`. */
export function textLayerOf(node: Node | null, root: Element): Element | null {
  const layer = elementOf(node)?.closest('.textLayer') ?? null;
  return layer !== null && root.contains(layer) ? layer : null;
}

/** The 1-based PDF page of a text layer (`.page[data-page-number]`), or null. */
export function pageOfLayer(layer: Element): number | null {
  const value = Number(
    layer.closest<HTMLElement>('.page[data-page-number]')?.dataset['pageNumber'],
  );
  return Number.isInteger(value) && value > 0 ? value : null;
}

/** `lang` of the text only when the PDF set one inside the viewer; the reader's own UI language says nothing about it. */
function languageHintOf(el: Element | null, root: Element): string | undefined {
  const lang = el?.closest('[lang]');
  const value =
    lang !== null && lang !== undefined && root.contains(lang) ? lang.getAttribute('lang') : null;
  return value !== null && LANG_TAG.test(value) ? value : undefined;
}

function intersect(a: Box, b: Box): Box | null {
  const box = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return box.right > box.left && box.bottom > box.top ? box : null;
}

/**
 * Live line boxes of `range`, clipped to the scrolling viewer (`clip`). Null while the selection is
 * entirely scrolled out of the viewer: the toolbar then hides, and returns when it scrolls back.
 * `first` and `last` are the first and last line that is at least partly visible, so the toolbar
 * never anchors to text nobody can see (the text layer's boxes are not clipped by the scroller).
 */
export function viewerRects(range: Range, clip: Element): SelectionRects | null {
  const view = clip.getBoundingClientRect();
  const lines: Box[] = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (rect.width < 1 || rect.height <= 0) continue;
    const visible = intersect(rect, view);
    if (visible !== null) lines.push(visible);
  }
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (first === undefined || last === undefined) return null;
  const bounds = lines.reduce((a, b) => ({
    left: Math.min(a.left, b.left),
    top: Math.min(a.top, b.top),
    right: Math.max(a.right, b.right),
    bottom: Math.max(a.bottom, b.bottom),
  }));
  return { first, last, bounds };
}

/**
 * Capture the current selection when, and only when, both of its ends are inside PDF.js text
 * layers under `root` (the scrolling viewer container). Null when it does not qualify: collapsed,
 * outside the PDF, in an input (the find box), inside Clavis's own UI, or not rendered.
 * Pure local work; nothing leaves the page.
 */
export function capturePdfSelection(win: Window, root: Element): CapturedSelection | null {
  const selection = win.getSelection();
  if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0).cloneRange();
  const layer = textLayerOf(range.startContainer, root);
  if (layer === null || textLayerOf(range.endContainer, root) === null) return null;
  const page = pageOfLayer(layer);
  if (page === null) return null;
  const doc = win.document;
  if (isEditableSelection(selection, doc, range) || isOwnUiSelection(selection)) return null;
  if (!isRangeRendered(range)) return null;

  const normalized = normalizeKangxiRadicals(
    normalizeText(selection.toString().slice(0, RAW_SELECTION_CAP)),
  );
  if (normalized === '') return null;

  const overLimit = normalized.length > LIMITS.maxSelectionChars;
  const text = truncateText(normalized, LIMITS.maxSelectionChars);
  const el = elementOf(range.commonAncestorContainer);
  const languageHint = languageHintOf(el, root);
  const kind: SelectionKind = overLimit ? 'passage' : classifySelection(text, languageHint);
  const context = extractPdfContext(range, layer);
  const dir = el !== null && win.getComputedStyle(el).direction === 'rtl' ? 'rtl' : 'ltr';

  const snapshot: SelectionSnapshot = {
    selectionId: newSelectionId(),
    source: 'pdf',
    kind,
    text,
    ...(context.before === '' ? {} : { contextBefore: context.before }),
    ...(context.after === '' ? {} : { contextAfter: context.after }),
    ...(languageHint === undefined ? {} : { languageHint }),
    page,
  };

  const captured: CapturedSelection = {
    snapshot,
    overLimit,
    ...(overLimit ? { fullText: normalized } : {}),
    dir,
    range,
    getRects: () => (range.collapsed ? null : viewerRects(range, root)),
  };
  return captured;
}

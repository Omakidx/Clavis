import { LIMITS } from '../config/constants';
import { selectionSnapshotSchema, type SelectionKind, type SelectionSnapshot } from '../contracts';

/** What was selected inside the viewer's text layers. */
export interface PdfSelection {
  /** Whitespace-normalised selected string, cut to LIMITS.maxSelectionChars. */
  text: string;
  /** 1-based page where the selection starts (a selection may span pages). */
  page: number;
  /** True when the selection was longer than the limit and has been cut. */
  truncated: boolean;
}

/** Raw selection length examined before whitespace normalisation (UTF-16 code units). */
export const RAW_SELECTION_CAP = LIMITS.maxSelectionChars * 4;

function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

function pageOf(node: Node | null): number | null {
  const pageEl = elementOf(node)?.closest<HTMLElement>('.page[data-page-number]');
  const value = Number(pageEl?.dataset['pageNumber']);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function insideTextLayer(node: Node | null, root: Element): boolean {
  const el = elementOf(node);
  return el !== null && root.contains(el) && el.closest('.textLayer') !== null;
}

function cutAtLimit(text: string): { text: string; truncated: boolean } {
  if (text.length <= LIMITS.maxSelectionChars) return { text, truncated: false };
  let end = LIMITS.maxSelectionChars;
  // Do not split a surrogate pair.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end).trimEnd(), truncated: true };
}

/**
 * Read the current window selection when, and only when, both of its ends are inside a PDF.js
 * text layer under `root`. Text is taken from window.getSelection() (architecture section 8);
 * nothing is reconstructed from canvases or from other pages.
 */
export function readPdfSelection(selection: Selection | null, root: Element): PdfSelection | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  if (!insideTextLayer(selection.anchorNode, root) || !insideTextLayer(selection.focusNode, root)) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const page = pageOf(range.startContainer) ?? pageOf(selection.anchorNode);
  if (page === null) return null;
  // Bound the raw string before any regex runs: a whole-document selection can be megabytes.
  // Four times the limit leaves room for the whitespace that normalisation removes.
  const full = selection.toString();
  let raw = full.slice(0, RAW_SELECTION_CAP);
  const last = raw.charCodeAt(raw.length - 1);
  if (raw.length === RAW_SELECTION_CAP && last >= 0xd800 && last <= 0xdbff) raw = raw.slice(0, -1);
  const normalized = raw.replace(/\s+/g, ' ').trim();
  if (normalized === '') return null;
  const cut = cutAtLimit(normalized);
  return { text: cut.text, page, truncated: cut.truncated || full.length > RAW_SELECTION_CAP };
}

/**
 * Rough kind classification for the spike. The real classifier belongs to the selection module
 * (Phase 4); this keeps the snapshot schema satisfied until it is shared.
 */
export function classifyKind(text: string): SelectionKind {
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words <= 1) return 'word';
  if (words <= 4) return 'phrase';
  const sentenceCount = text.split(/[.!?]+(?:\s|$)/).filter((s) => s.trim() !== '').length;
  return sentenceCount <= 1 && words <= 60 ? 'sentence' : 'passage';
}

/** Build and validate a `source: 'pdf'` SelectionSnapshot; null when it does not satisfy the schema. */
export function toPdfSelectionSnapshot(
  selection: PdfSelection,
  selectionId: string = crypto.randomUUID(),
): SelectionSnapshot | null {
  const result = selectionSnapshotSchema.safeParse({
    selectionId,
    source: 'pdf',
    kind: classifyKind(selection.text),
    text: selection.text,
    page: selection.page,
  });
  return result.success ? result.data : null;
}

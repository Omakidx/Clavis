import { LIMITS } from '../../lib/config/constants';
import { normalizeText, truncateText } from '../../lib/selection/text';

export interface ResultLookupInput {
  text: string;
  contextBefore?: string;
  contextAfter?: string;
}

export type ResultSelection = { kind: 'ready'; input: ResultLookupInput } | { kind: 'over-limit' };

const LEAF = '[data-clavis="card-result-text"]';

function containingLeaf(node: Node): HTMLElement | null {
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return (element?.closest(LEAF) as HTMLElement | null) ?? null;
}

/** Only a range entirely inside one visible model-written leaf may start a recursive lookup. */
export function resultSelectionFromRange(
  range: Range,
  activePanel: HTMLElement,
): ResultSelection | null {
  if (activePanel.hidden || range.collapsed) return null;
  const start = containingLeaf(range.startContainer);
  const end = containingLeaf(range.endContainer);
  if (start === null || start !== end || !activePanel.contains(start)) return null;
  if (start.closest('[data-clavis="card-result"]') === null) return null;
  const text = normalizeText(range.toString());
  if (text === '') return null;
  if (text.length > LIMITS.maxSelectionChars) return { kind: 'over-limit' };

  // Context comes from the same generated leaf. No page text, labels, or neighbouring answer
  // fields are smuggled into a child request. Keep a balanced, bounded hint around the selection.
  const beforeRange = range.cloneRange();
  beforeRange.selectNodeContents(start);
  beforeRange.setEnd(range.startContainer, range.startOffset);
  const afterRange = range.cloneRange();
  afterRange.selectNodeContents(start);
  afterRange.setStart(range.endContainer, range.endOffset);
  const half = Math.floor(LIMITS.maxContextChars / 2);
  let before = normalizeText(beforeRange.toString());
  if (before.length > half) {
    before = before.slice(-half);
    // A cut must not leave the low half of a surrogate pair at its start.
    if (/^[\uDC00-\uDFFF]/u.test(before)) before = before.slice(1);
    before = before.trimStart();
  }
  const after = truncateText(
    normalizeText(afterRange.toString()),
    LIMITS.maxContextChars - before.length,
  );
  return {
    kind: 'ready',
    input: {
      text,
      ...(before === '' ? {} : { contextBefore: before }),
      ...(after === '' ? {} : { contextAfter: after }),
    },
  };
}

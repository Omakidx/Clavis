import { LIMITS } from '../config/constants';
import { head, tail } from '../selection/context';
import { normalizeText } from '../selection/text';
import { normalizeKangxiRadicals } from './radicals';

/**
 * Bounded context for a PDF selection (architecture section 8: "Context can be taken from nearby
 * text items on that page, bounded to the same small character ceiling as webpages, not the full
 * document").
 *
 * The rules, in one place:
 * - Same page only. Text is read from the ONE `.textLayer` that holds the start of the selection,
 *   never from another page, never from the rest of the document. `contextAfter` is only taken
 *   when the selection also ENDS on that page (a selection that runs onto the next page has no
 *   "after" on the page it started on, and the next page's text is not read).
 * - Hard ceiling: `before` and `after` are cut to half of `LIMITS.maxContextChars` each, on word
 *   boundaries, so the two together never exceed it.
 * - Cheap: at most MAX_VISITED_NODES text nodes are examined per side, so a page made of
 *   thousands of tiny items costs the same as a short one.
 * - Only what a reader can see: text items that are hidden (`hidden`, `aria-hidden`,
 *   `display:none`, `visibility:hidden`, zero opacity), have no box, or lie completely outside the
 *   page box (the text layer clips them) are skipped. PDF.js draws its text transparent on
 *   purpose, so colour is NOT a visibility signal here (unlike webpages).
 * - Spans are separated by a space, exactly as `Selection#toString` separates them (the spans are
 *   absolutely positioned, so the browser treats each as a block).
 */

/** Hard ceiling on text nodes visited per side (same as webpage context). */
export const MAX_VISITED_NODES = 400;

const TEXT_NODE = 3;
const SHOW_TEXT = 4;

export interface PdfContext {
  before: string;
  after: string;
}

function deepestLast(node: Node): Node {
  let last = node;
  while (last.lastChild !== null) last = last.lastChild;
  return last;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Whether `text` is something a reader can see on the page. `cache` memoizes per parent element. */
function makeUsable(layer: Element): (text: Node) => boolean {
  const doc = layer.ownerDocument;
  const view = doc.defaultView;
  const layerBox = layer.getBoundingClientRect();
  // jsdom and other layout-less hosts report an empty box for everything: no geometry check then.
  const hasLayout = layerBox.width > 0 && layerBox.height > 0;
  const styles = new Map<Element, boolean>();

  const styleVisible = (el: Element): boolean => {
    let ok = styles.get(el);
    if (ok === undefined) {
      ok = true;
      for (let cur: Element | null = el; cur !== null; cur = cur.parentElement) {
        if (cur.hasAttribute('hidden') || cur.getAttribute('aria-hidden') === 'true') ok = false;
        else if (cur.classList.contains('endOfContent')) ok = false;
        else if (view !== null) {
          const style = view.getComputedStyle(cur);
          if (
            style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.visibility === 'collapse' ||
            parseFloat(style.opacity) === 0
          ) {
            ok = false;
          }
        }
        if (!ok || cur === layer) break;
      }
      styles.set(el, ok);
    }
    return ok;
  };

  return (text) => {
    const parent = text.parentElement;
    if (parent === null || !styleVisible(parent)) return false;
    if (!hasLayout || typeof doc.createRange !== 'function') return true;
    const range = doc.createRange();
    range.selectNodeContents(text);
    if (typeof range.getBoundingClientRect !== 'function') return true;
    const box: Box = range.getBoundingClientRect();
    if (box.right - box.left <= 0 && box.bottom - box.top <= 0) return false;
    // Entirely outside the page box: the layer clips it, so nobody sees it.
    return !(
      box.right <= layerBox.left ||
      box.left >= layerBox.right ||
      box.bottom <= layerBox.top ||
      box.top >= layerBox.bottom
    );
  };
}

function textWalker(layer: Element): TreeWalker {
  return layer.ownerDocument.createTreeWalker(layer, SHOW_TEXT);
}

function gather(
  range: Range,
  layer: Element,
  usable: (text: Node) => boolean,
  rawLimit: number,
  direction: 'before' | 'after',
): string {
  const walker = textWalker(layer);
  const parts: string[] = [];
  let total = 0;
  const backward = direction === 'before';
  const container = backward ? range.startContainer : range.endContainer;
  const offset = backward ? range.startOffset : range.endOffset;
  const step = (): Node | null => (backward ? walker.previousNode() : walker.nextNode());

  let node: Node | null;
  if (container.nodeType === TEXT_NODE) {
    const data = (container as Text).data;
    const partial = backward ? data.slice(0, offset) : data.slice(offset);
    if (usable(container)) {
      parts.push(partial);
      total += partial.length;
    }
    walker.currentNode = container;
    node = step();
  } else {
    const child = container.childNodes[offset] ?? null;
    if (backward) {
      if (child !== null) {
        walker.currentNode = child;
        node = walker.previousNode();
      } else {
        const last = deepestLast(container);
        walker.currentNode = last;
        node = last.nodeType === TEXT_NODE ? last : walker.previousNode();
      }
    } else if (child !== null) {
      walker.currentNode = child;
      node = child.nodeType === TEXT_NODE ? child : walker.nextNode();
    } else {
      walker.currentNode = deepestLast(container);
      node = walker.nextNode();
    }
  }

  for (
    let visited = 0;
    node !== null && total < rawLimit && visited < MAX_VISITED_NODES;
    visited++
  ) {
    if (usable(node)) {
      const data = (node as Text).data;
      parts.push(data);
      total += data.length;
    }
    node = step();
  }
  if (backward) parts.reverse();
  return parts.join(' ');
}

/**
 * Context around `range` from `layer`, the text layer of the page the selection starts on.
 * `range` must start inside `layer`. Total output is at most `maxChars`.
 */
export function extractPdfContext(
  range: Range,
  layer: Element,
  maxChars: number = LIMITS.maxContextChars,
): PdfContext {
  const half = Math.floor(maxChars / 2);
  // Gather more raw text than needed: whitespace collapsing shrinks it.
  const rawLimit = half * 2 + 64;
  const usable = makeUsable(layer);
  const clean = (text: string): string => normalizeKangxiRadicals(normalizeText(text));
  const before = tail(clean(gather(range, layer, usable, rawLimit, 'before')), half);
  const endsHere = layer.contains(range.endContainer);
  const after = endsHere ? head(clean(gather(range, layer, usable, rawLimit, 'after')), half) : '';
  return { before, after };
}

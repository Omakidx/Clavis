import { LIMITS } from '../config/constants';
import { isOwnUiNode } from './own-ui';
import { normalizeText } from './text';

/** Elements that end one run of text and start another. */
const BLOCK_TAGS = new Set([
  'ADDRESS',
  'ARTICLE',
  'ASIDE',
  'BLOCKQUOTE',
  'BODY',
  'DD',
  'DETAILS',
  'DIV',
  'DL',
  'DT',
  'FIELDSET',
  'FIGCAPTION',
  'FIGURE',
  'FOOTER',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'HEADER',
  'HR',
  'LI',
  'MAIN',
  'NAV',
  'OL',
  'P',
  'PRE',
  'SECTION',
  'SUMMARY',
  'TABLE',
  'TBODY',
  'TD',
  'TFOOT',
  'TH',
  'THEAD',
  'TR',
  'UL',
]);

/** Text under these elements is never context (scripts, forms, navigation, controls). */
const EXCLUDED_TAGS = new Set([
  'ASIDE',
  'BUTTON',
  'IFRAME',
  'INPUT',
  'NAV',
  'NOSCRIPT',
  'OBJECT',
  'OPTION',
  'SCRIPT',
  'SELECT',
  'STYLE',
  'SVG',
  'TEMPLATE',
  'TEXTAREA',
  'FORM',
]);

/**
 * Hard ceiling on text nodes visited per side. Context must stay local and cheap
 * even on pages made of thousands of tiny nodes (architecture section 5, step 4).
 */
const MAX_VISITED_NODES = 400;

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

export interface SelectionContext {
  before: string;
  after: string;
}

function elementOf(node: Node): Element | null {
  return node.nodeType === ELEMENT_NODE ? (node as Element) : node.parentElement;
}

function blockOf(node: Node): Element | null {
  let el = elementOf(node);
  while (el !== null && !BLOCK_TAGS.has(el.tagName)) el = el.parentElement;
  return el;
}

/** The nearest block around the selection; context never leaves it. */
export function findContextScope(range: Range): Element {
  const doc = range.commonAncestorContainer.ownerDocument ?? document;
  return blockOf(range.commonAncestorContainer) ?? doc.body ?? doc.documentElement;
}

/**
 * Every option name Chrome has used (the first three exist since Chrome 105, the last three
 * since 121); unknown dictionary members are ignored, so one object serves both.
 */
const VISIBILITY_OPTIONS = {
  checkOpacity: true,
  checkVisibilityCSS: true,
  opacityProperty: true,
  visibilityProperty: true,
  contentVisibilityAuto: true,
};

// `transparent`, `rgba(r, g, b, 0)` and the space-separated `rgb(r g b / 0)` form (NOT plain `rgb(0, 0, 0)`).
const TRANSPARENT_COLOR =
  /^(transparent|rgba\(\s*[^,)]+,\s*[^,)]+,\s*[^,)]+,\s*0(\.0+)?\s*\)|rgba?\([^),]+\/\s*0(\.0+)?%?\s*\))$/;
const CLIP_RECT = /rect\(([^)]*)\)/;
const CLIP_PATH_EMPTY = /^(inset\((50|100)%|circle\(0|polygon\(0(px)? 0(px)?,\s*0(px)? 0(px)?)/;

/** `clip: rect(...)` whose box is at most one pixel wide or high (the "screen reader only" idiom). */
function isClipRectEmpty(clip: string): boolean {
  const match = CLIP_RECT.exec(clip);
  if (match === null) return false;
  const [top, right, bottom, left] = (match[1] ?? '').split(/[\s,]+/).map((v) => parseFloat(v));
  if ([top, right, bottom, left].some((v) => v === undefined || Number.isNaN(v))) return false;
  return (
    Math.abs((right as number) - (left as number)) <= 1 ||
    Math.abs((bottom as number) - (top as number)) <= 1
  );
}

/**
 * Text a reader cannot see even though it is in the DOM: attributes, `display:none`,
 * `visibility:hidden`, zero opacity (own or an ancestor's), transparent text, the clip idioms,
 * and `content-visibility`. Style-only checks, so the result is cached per element.
 */
function isHiddenElement(el: Element): boolean {
  if (el.hasAttribute('hidden') || el.getAttribute('aria-hidden') === 'true') return true;
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === 'function' && !check.call(el, VISIBILITY_OPTIONS)) return true;
  const style = el.ownerDocument.defaultView?.getComputedStyle(el);
  if (style === undefined) return false;
  return (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    // `checkVisibility` is true for the skipping element itself, but its text is not rendered.
    style.contentVisibility === 'hidden' ||
    parseFloat(style.opacity) === 0 ||
    TRANSPARENT_COLOR.test(style.color.trim()) ||
    (style.clip !== '' && style.clip !== 'auto' && isClipRectEmpty(style.clip)) ||
    CLIP_PATH_EMPTY.test(style.clipPath.trim())
  );
}

/**
 * Per-text-node geometry. Catches what styles cannot say: `font-size:0` (no boxes),
 * off-screen positioning and `text-indent:-9999px` (entirely left of or above the document),
 * and `overflow:hidden` ancestors the text lies completely outside of or that are 1px small.
 */
function isTextVisible(text: Node, scope: Element): boolean {
  const doc = text.ownerDocument as Document;
  const view = doc.defaultView;
  const range = doc.createRange();
  range.selectNodeContents(text);
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
  if (rects.length === 0) return false;
  const scrollX = view?.scrollX ?? 0;
  const scrollY = view?.scrollY ?? 0;
  if (rects.every((r) => r.right + scrollX <= 0 || r.bottom + scrollY <= 0)) return false;
  for (let el = text.parentElement; el !== null; el = el.parentElement) {
    const overflow = view?.getComputedStyle(el).overflow ?? 'visible';
    if (overflow !== '' && overflow !== 'visible') {
      const box = el.getBoundingClientRect();
      if (box.width <= 1 || box.height <= 1) return false;
      // Scrollers legitimately hold text that is scrolled out of view; only clipping ones hide it.
      if (
        (overflow === 'hidden' || overflow === 'clip') &&
        rects.every(
          (r) =>
            r.right <= box.left ||
            r.left >= box.right ||
            r.bottom <= box.top ||
            r.top >= box.bottom,
        )
      ) {
        return false;
      }
    }
    if (el === scope) break;
  }
  return true;
}

interface TextRun {
  text: string;
  block: Element | null;
}

/** Whether a text node may contribute context. `cache` memoizes per parent element. */
function isUsable(text: Node, scope: Element, cache: Map<Element, boolean>): boolean {
  const parent = text.parentElement;
  if (parent === null) return false;
  let usable = cache.get(parent);
  if (usable === undefined) {
    usable = true;
    for (let el: Element | null = parent; el !== null; el = el.parentElement) {
      if (EXCLUDED_TAGS.has(el.tagName) && el !== scope) usable = false;
      else if (isOwnUiNode(el) || isHiddenElement(el)) usable = false;
      if (!usable || el === scope) break;
    }
    cache.set(parent, usable);
  }
  return usable && isTextVisible(text, scope);
}

function deepestLast(node: Node): Node {
  let last = node;
  while (last.lastChild !== null) last = last.lastChild;
  return last;
}

function join(runs: TextRun[]): string {
  let out = '';
  let previous: TextRun | undefined;
  for (const run of runs) {
    // Inline markup (`fo<b>o</b>`) must not gain a space; block changes must.
    if (previous !== undefined && previous.block !== run.block) out += ' ';
    out += run.text;
    previous = run;
  }
  return out;
}

function gatherBefore(range: Range, scope: Element, rawLimit: number): string {
  const doc = scope.ownerDocument;
  const walker = doc.createTreeWalker(scope, 4 /* NodeFilter.SHOW_TEXT */);
  const cache = new Map<Element, boolean>();
  const runs: TextRun[] = [];
  let total = 0;
  const { startContainer, startOffset } = range;
  let node: Node | null;
  if (startContainer.nodeType === TEXT_NODE) {
    const partial = (startContainer as Text).data.slice(0, startOffset);
    if (isUsable(startContainer, scope, cache)) {
      runs.push({ text: partial, block: blockOf(startContainer) });
      total += partial.length;
    }
    walker.currentNode = startContainer;
    node = walker.previousNode();
  } else {
    const child = startContainer.childNodes[startOffset] ?? null;
    if (child !== null) {
      walker.currentNode = child;
      node = walker.previousNode();
    } else {
      const last = deepestLast(startContainer);
      walker.currentNode = last;
      node = last.nodeType === TEXT_NODE ? last : walker.previousNode();
    }
  }
  for (
    let visited = 0;
    node !== null && total < rawLimit && visited < MAX_VISITED_NODES;
    visited++
  ) {
    if (isUsable(node, scope, cache)) {
      const text = (node as Text).data;
      runs.push({ text, block: blockOf(node) });
      total += text.length;
    }
    node = walker.previousNode();
  }
  return join(runs.reverse());
}

function gatherAfter(range: Range, scope: Element, rawLimit: number): string {
  const doc = scope.ownerDocument;
  const walker = doc.createTreeWalker(scope, 4 /* NodeFilter.SHOW_TEXT */);
  const cache = new Map<Element, boolean>();
  const runs: TextRun[] = [];
  let total = 0;
  const { endContainer, endOffset } = range;
  let node: Node | null;
  if (endContainer.nodeType === TEXT_NODE) {
    const partial = (endContainer as Text).data.slice(endOffset);
    if (isUsable(endContainer, scope, cache)) {
      runs.push({ text: partial, block: blockOf(endContainer) });
      total += partial.length;
    }
    walker.currentNode = endContainer;
    node = walker.nextNode();
  } else {
    const child = endContainer.childNodes[endOffset] ?? null;
    if (child !== null) {
      // The walker's next node after `child`'s predecessor is `child`'s first text.
      walker.currentNode = child;
      node = child.nodeType === TEXT_NODE ? child : walker.nextNode();
    } else {
      walker.currentNode = deepestLast(endContainer);
      node = walker.nextNode();
    }
  }
  for (
    let visited = 0;
    node !== null && total < rawLimit && visited < MAX_VISITED_NODES;
    visited++
  ) {
    if (isUsable(node, scope, cache)) {
      const text = (node as Text).data;
      runs.push({ text, block: blockOf(node) });
      total += text.length;
    }
    node = walker.nextNode();
  }
  return join(runs);
}

/** Last `limit` characters, starting on a word boundary when text had to be cut. */
function tail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(text.length - limit);
  const startsMidWord = text.charAt(text.length - limit - 1) !== ' ' && !cut.startsWith(' ');
  if (!startsMidWord) return cut.trimStart();
  const space = cut.indexOf(' ');
  return space === -1 ? cut : cut.slice(space + 1);
}

/** First `limit` characters, ending on a word boundary when text had to be cut. */
function head(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const endsMidWord = text.charAt(limit) !== ' ' && !cut.endsWith(' ');
  if (!endsMidWord) return cut.trimEnd();
  const space = cut.lastIndexOf(' ');
  return space === -1 ? cut : cut.slice(0, space);
}

/**
 * Bounded text immediately around `range`, from the nearest block only.
 * Never reads `document.body.innerText`; total output is at most `maxChars`.
 */
export function extractContext(
  range: Range,
  maxChars: number = LIMITS.maxContextChars,
): SelectionContext {
  const half = Math.floor(maxChars / 2);
  const scope = findContextScope(range);
  // Gather more raw text than needed: whitespace collapsing shrinks it.
  const rawLimit = half * 2 + 64;
  const before = tail(normalizeText(gatherBefore(range, scope, rawLimit)), half);
  const after = head(normalizeText(gatherAfter(range, scope, rawLimit)), half);
  return { before, after };
}

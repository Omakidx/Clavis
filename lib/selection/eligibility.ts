import { isOwnUiNode } from './own-ui';

/**
 * Which selections Clavis may react to (FR-010, FR-015, architecture section 5 step 2).
 * Everything here is cheap, synchronous DOM inspection.
 */

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

function elementOf(node: Node | null): Element | null {
  if (node === null) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

/** The focused element, looking through open shadow roots. */
export function deepActiveElement(doc: Document): Element | null {
  let active: Element | null = doc.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

function isEditableElement(el: Element | null): boolean {
  return el !== null && el.closest(EDITABLE_SELECTOR) !== null;
}

/** True when the selection sits in (or focus is on) a field the user types into. */
export function isEditableSelection(selection: Selection, doc: Document): boolean {
  if (doc.designMode === 'on') return true;
  if (isEditableElement(deepActiveElement(doc))) return true;
  return (
    isEditableElement(elementOf(selection.anchorNode)) ||
    isEditableElement(elementOf(selection.focusNode))
  );
}

/** True when the selection is inside Clavis's own toolbar or card. */
export function isOwnUiSelection(selection: Selection): boolean {
  return isOwnUiNode(selection.anchorNode) || isOwnUiNode(selection.focusNode);
}

/** Whether the range is rendered at all (display:none, visibility:hidden, zero boxes). */
export function isRangeRendered(range: Range): boolean {
  const ancestor = elementOf(range.commonAncestorContainer);
  const check = (ancestor as (Element & { checkVisibility?: (o?: object) => boolean }) | null)
    ?.checkVisibility;
  if (ancestor !== null && typeof check === 'function') {
    if (!check.call(ancestor, { checkVisibilityCSS: true })) return false;
  }
  return Array.from(range.getClientRects()).some((rect) => rect.width > 0 || rect.height > 0);
}

/** Only http(s) documents (and about:blank/srcdoc frames inside them) qualify. */
export function isSupportedDocument(doc: Document): boolean {
  const { protocol } = doc.location;
  return protocol === 'http:' || protocol === 'https:' || protocol === 'about:';
}

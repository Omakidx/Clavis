/**
 * Selections inside OPEN page shadow roots (web components).
 *
 * The document's Selection retargets such a selection to the shadow host: the range collapses
 * onto the host's position (`isCollapsed` is true) although `toString()` still returns the
 * text. `Selection.getComposedRanges({ shadowRoots })` (Chrome 137+, minimum here is 147)
 * returns the real boundaries when told which shadow roots the caller may see. Closed roots
 * cannot be reached by an extension, so selections in them are not supported.
 */

/** Shadow roots can nest; stop after this many levels instead of looping on hostile pages. */
const MAX_NESTING = 8;

type ComposedSelection = {
  getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[];
};

/** Open roots of the (at most two) elements next to a boundary point, where a retargeted range sits. */
function rootsNextTo(container: Node, offset: number): ShadowRoot[] {
  if (container.nodeType === 3) return [];
  const found: ShadowRoot[] = [];
  for (const child of [container.childNodes[offset - 1], container.childNodes[offset]]) {
    const root = (child as Element | undefined)?.shadowRoot;
    if (root !== undefined && root !== null) found.push(root);
  }
  return found;
}

/**
 * Cheap "is there anything selected" test for the observer's listeners: a non-collapsed
 * range, or a collapsed one parked next to an open shadow host (a retargeted selection).
 */
export function hasSelection(selection: Selection | null): boolean {
  if (selection === null || selection.rangeCount === 0) return false;
  if (!selection.isCollapsed) return true;
  const range = selection.getRangeAt(0);
  return rootsNextTo(range.startContainer, range.startOffset).length > 0;
}

/**
 * The user's selection as a live Range, with boundaries inside open shadow roots resolved.
 * Falls back to the plain range where `getComposedRanges` is missing or finds nothing.
 * Null when nothing is selected.
 */
export function selectionRange(selection: Selection): Range | null {
  if (selection.rangeCount === 0) return null;
  const plain = selection.getRangeAt(0);
  const getComposed = (selection as unknown as ComposedSelection).getComposedRanges;
  if (typeof getComposed !== 'function') return plain.cloneRange();

  let roots: ShadowRoot[] = [];
  let resolved: StaticRange | undefined;
  let points: Array<[Node, number]> = [
    [plain.startContainer, plain.startOffset],
    [plain.endContainer, plain.endOffset],
  ];
  for (let level = 0; level < MAX_NESTING; level++) {
    const fresh = [
      ...new Set(points.flatMap(([node, offset]) => rootsNextTo(node, offset))),
    ].filter((root) => !roots.includes(root));
    if (fresh.length === 0) break;
    roots = roots.concat(fresh);
    resolved = getComposed.call(selection, { shadowRoots: roots })[0];
    if (resolved === undefined) break;
    points = [
      [resolved.startContainer, resolved.startOffset],
      [resolved.endContainer, resolved.endOffset],
    ];
  }
  if (resolved === undefined) return plain.cloneRange();

  const range = (plain.startContainer.ownerDocument ?? document).createRange();
  try {
    range.setStart(resolved.startContainer, resolved.startOffset);
    range.setEnd(resolved.endContainer, resolved.endOffset);
  } catch {
    return plain.cloneRange();
  }
  // A Range cannot span trees: setEnd into another root collapses it. Keep the plain range then.
  return range.collapsed && !resolved.collapsed ? plain.cloneRange() : range;
}

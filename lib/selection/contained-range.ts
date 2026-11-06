/**
 * Resolve a selection only within a caller-owned container, including a known closed shadow
 * root. Unlike page capture, callers already hold this root; it is never exposed to page code.
 */
export function selectionWithin(container: HTMLElement | ShadowRoot): Range | null {
  const doc = container.ownerDocument;
  const selection = doc.getSelection();
  if (selection === null) return null;
  const root = container.getRootNode();
  const shadow = root.nodeType === 11 && 'host' in root ? (root as ShadowRoot) : undefined;
  const composed = selection as Selection & {
    getComposedRanges?: (options: { shadowRoots: ShadowRoot[] }) => StaticRange[];
  };
  let bounds: AbstractRange | undefined;
  try {
    bounds = composed.getComposedRanges?.({ shadowRoots: shadow === undefined ? [] : [shadow] })[0];
  } catch {
    // Older browser implementations can fall back only when their ordinary range is contained.
  }
  if (bounds === undefined && selection.rangeCount > 0) bounds = selection.getRangeAt(0);
  if (
    bounds === undefined ||
    bounds.collapsed ||
    !container.contains(bounds.startContainer) ||
    !container.contains(bounds.endContainer) ||
    bounds.startContainer.getRootNode() !== bounds.endContainer.getRootNode()
  )
    return null;
  try {
    const range = doc.createRange();
    range.setStart(bounds.startContainer, bounds.startOffset);
    range.setEnd(bounds.endContainer, bounds.endOffset);
    return range.collapsed ? null : range;
  } catch {
    return null;
  }
}

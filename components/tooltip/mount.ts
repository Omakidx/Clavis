function isModal(dialog: Element): boolean {
  try {
    return dialog.matches(':modal');
  } catch {
    return false;
  }
}

/**
 * The open MODAL `<dialog>` that contains `node`, looking through shadow roots, or null.
 *
 * A modal dialog makes everything outside it inert, including a top-layer toolbar that is a
 * child of <html>: it could be seen but not clicked or focused. The toolbar host is mounted
 * inside that dialog instead (it still escapes the dialog's clipping and transforms because it
 * is a popover in the top layer).
 */
export function modalDialogOf(node: Node | null): HTMLElement | null {
  let el: Element | null =
    node === null ? null : node.nodeType === 1 ? (node as Element) : node.parentElement;
  while (el !== null) {
    if (el.localName === 'dialog' && isModal(el)) return el as HTMLElement;
    // `host` exists on shadow roots only, and (unlike `instanceof`) works across frames.
    el = el.parentElement ?? (el.getRootNode() as Partial<ShadowRoot>).host ?? null;
  }
  return null;
}

/** True when `node` is `ancestor` or inside it, looking through shadow roots. */
export function isInsideComposed(node: Node | null, ancestor: Node): boolean {
  for (let current = node; current !== null;) {
    if (current === ancestor) return true;
    current = current.parentNode ?? (current as Partial<ShadowRoot>).host ?? null;
  }
  return false;
}

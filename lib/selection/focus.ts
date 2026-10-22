/**
 * Which frame should react to a "show the toolbar and take focus" request (the Alt+Shift+E
 * path), which the background sends to EVERY frame of the tab: only the one the user is in, so
 * a stale selection in another frame does not open a second toolbar that steals focus.
 *
 * `document.hasFocus()` is also true for every ANCESTOR of the focused frame, so a frame whose
 * own focused element is a child iframe never owns focus. Otherwise a frame owns it when its
 * document has focus, and the top frame takes it when no frame does (focus is in the browser UI).
 */
export function ownsFocus(doc: Document, isTopFrame: boolean): boolean {
  if (doc.activeElement?.localName === 'iframe') return false;
  return doc.hasFocus() || isTopFrame;
}

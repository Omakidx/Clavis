/**
 * Copy plain text to the clipboard (FR-019). Runs from a trusted click inside the card.
 *
 * Only the async Clipboard API, from the extension's own isolated world (a page cannot patch its
 * prototypes). There is deliberately NO textarea + `execCommand('copy')` fallback: that path
 * dispatches a composed `copy` event and puts the text in a selection the page can read, and a
 * page can make it the only path (plain http, a Permissions-Policy that blocks the async API) and
 * then replace the clipboard behind a "Copied". When the API is missing or refuses, the card says
 * copying is not available on this page.
 */
export async function copyPlainText(doc: Document, text: string): Promise<boolean> {
  try {
    const clipboard = doc.defaultView?.navigator.clipboard;
    if (clipboard === undefined) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

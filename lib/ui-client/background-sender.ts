/** The fields of `runtime.MessageSender` that the check reads. */
export interface BackgroundSenderLike {
  id?: string | undefined;
  url?: string | undefined;
  tab?: unknown;
}

/**
 * Whether a message reaching an extension page was sent by OUR service worker: our id, no tab (a
 * content script running in a web page shares our id but always has one) and the worker's own
 * script url. Used by pages that accept background events (the reader, the side panel and the
 * practice page; Phase 7 security review LOW-3, Phase 9 audit I3).
 */
export function isFromBackground(sender: BackgroundSenderLike | undefined): boolean {
  return (
    sender?.id === browser.runtime.id &&
    sender.tab === undefined &&
    sender.url === browser.runtime.getURL('/background.js')
  );
}

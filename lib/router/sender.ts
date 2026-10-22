import { EXTENSION_PAGES } from '../config/constants';

/**
 * Who sent a runtime message, derived ONLY from fields the browser fills in
 * (`sender.id`, `sender.url`, `sender.tab`, `sender.frameId`); nothing the sender wrote
 * in the message body is trusted for this.
 *
 * - `content`   a content script in a web page (http/https, or an about:blank / srcdoc
 *               frame that inherits one) with a tab.
 * - `extension` one of OUR pages, matched by EXACT path (see EXTENSION_PAGE_PATHS).
 * - `offscreen` our offscreen document, matched by exact path.
 * - `unknown`   anything else: another extension, a non-listed extension page, a page we
 *               do not recognise, an extension page embedded in a website, no url.
 */
export type SenderKind = 'content' | 'extension' | 'offscreen' | 'unknown';

/** The practice page is built by the onboarding workstream (entrypoints/practice). */
export const PRACTICE_PAGE_PATH = '/practice.html' as const;
export const OFFSCREEN_PAGE = '/offscreen.html' as const;

export const EXTENSION_PAGE_PATHS = [
  EXTENSION_PAGES.options,
  EXTENSION_PAGES.onboarding,
  EXTENSION_PAGES.popup,
  EXTENSION_PAGES.reader,
  PRACTICE_PAGE_PATH,
] as const;
export type ExtensionPagePath = (typeof EXTENSION_PAGE_PATHS)[number];

export interface ClassifiedSender {
  kind: SenderKind;
  /** Exact path of the extension page or offscreen document. */
  path?: ExtensionPagePath | typeof OFFSCREEN_PAGE;
  /** The sender's tab; absent for the popup and for the offscreen document. */
  tabId?: number;
  frameId?: number;
  /** The sender's own url (a frame's url, not the tab's). Internal routes use it; never echoed. */
  url?: string;
}

/** The fields of `runtime.MessageSender` that classification reads. */
export interface SenderLike {
  id?: string | undefined;
  url?: string | undefined;
  origin?: string | undefined;
  frameId?: number | undefined;
  tab?: { id?: number | undefined; url?: string | undefined } | undefined;
}

export interface SenderIdentity {
  runtimeId: string;
  /** Any url inside the extension, normally `runtime.getURL('/')`; only its scheme and host are used. */
  extensionOrigin: string;
}

const KNOWN_PAGES: ReadonlySet<string> = new Set(EXTENSION_PAGE_PATHS);

function parseUrl(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/** Content scripts also run in about:blank / srcdoc frames of a web page (matchOriginAsFallback). */
function isWebPageUrl(url: URL): boolean {
  return (
    url.protocol === 'http:' ||
    url.protocol === 'https:' ||
    url.href === 'about:blank' ||
    url.href === 'about:srcdoc'
  );
}

/**
 * Whether a url belongs to this extension. Compares scheme and host instead of
 * `URL.origin`, which is "null" for non-special schemes in some URL implementations.
 */
function ownsUrl(own: URL, url: URL): boolean {
  return url.protocol === own.protocol && url.host === own.host;
}

export function classifySender(sender: SenderLike, identity: SenderIdentity): ClassifiedSender {
  const unknown: ClassifiedSender = { kind: 'unknown' };
  const own = parseUrl(identity.extensionOrigin);
  if (own === undefined) return unknown;
  if (typeof sender !== 'object' || sender === null) return unknown;
  if (sender.id === undefined || sender.id !== identity.runtimeId) return unknown;
  const url = parseUrl(sender.url);
  if (url === undefined) return unknown;

  const tabId = sender.tab?.id;
  const located = {
    ...(tabId === undefined ? {} : { tabId }),
    ...(sender.frameId === undefined ? {} : { frameId: sender.frameId }),
    url: url.href,
  };

  if (ownsUrl(own, url)) {
    // An extension page embedded in a website (a frame whose tab is a web page) is not
    // the extension page it looks like: the embedding page controls its surroundings.
    const tabUrl = parseUrl(sender.tab?.url);
    if (tabUrl !== undefined && !ownsUrl(own, tabUrl)) return unknown;
    if (url.pathname === OFFSCREEN_PAGE) {
      // The offscreen document has no tab.
      return sender.tab === undefined
        ? { kind: 'offscreen', path: OFFSCREEN_PAGE, ...located }
        : unknown;
    }
    if (!KNOWN_PAGES.has(url.pathname)) return unknown;
    // Our pages are always top frames. A frame of one of them (e.g. the reader framing
    // /options.html) is not trusted as that page. Chrome only reports `frameId` for senders in a
    // tab: a page opened in a tab must be frame 0, while the real toolbar popup has no tab and
    // no frameId (none of our pages embeds another extension page, so a tab-less frame can't occur).
    // Only the popup is ever tab-less (options opens in a tab; there are no web-accessible
    // resources), so a tab-less sender must be the popup.
    const topFrame =
      sender.tab === undefined
        ? url.pathname === EXTENSION_PAGES.popup &&
          (sender.frameId === undefined || sender.frameId === 0)
        : sender.frameId === 0;
    if (!topFrame) return unknown;
    return { kind: 'extension', path: url.pathname as ExtensionPagePath, ...located };
  }

  // Not one of our pages: only a content script (which always has a tab) can be here. An
  // about:blank / srcdoc frame INSIDE one of our own pages (the practice page's frames) has
  // our origin; that is not a website, so it is not a content script.
  const origin = parseUrl(sender.origin);
  if (origin !== undefined && ownsUrl(own, origin)) return unknown;
  if (tabId === undefined || !isWebPageUrl(url)) return unknown;
  return { kind: 'content', ...located };
}

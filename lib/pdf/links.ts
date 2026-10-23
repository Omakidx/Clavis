import { ALLOWED_LINK_SCHEMES } from './limits';

/** mailto: query parameters kept (the rest, for example `attach=/etc/passwd`, is dropped). */
const MAILTO_PARAMS = ['subject', 'body', 'cc', 'bcc'] as const;

/**
 * Return a displayable, credential-free http(s)/mailto URL, or null for anything else.
 * A mailto: link keeps its address(es) and only the subject, body, cc and bcc parameters: mail
 * clients honour others such as `attach=`, which would let a PDF attach a local file to a draft
 * (Phase 7 security review LOW-4). What the dialog shows is exactly what is opened.
 */
export function toSafeExternalUrl(raw: string): URL | null {
  const url = URL.parse(raw);
  if (!url) return null;
  if (!(ALLOWED_LINK_SCHEMES as readonly string[]).includes(url.protocol)) return null;
  if (url.protocol === 'mailto:') {
    const kept: string[] = [];
    for (const [name, value] of url.searchParams) {
      const key = name.toLowerCase();
      if ((MAILTO_PARAMS as readonly string[]).includes(key)) {
        kept.push(`${key}=${encodeURIComponent(value)}`);
      }
    }
    return URL.parse(`mailto:${url.pathname}${kept.length > 0 ? `?${kept.join('&')}` : ''}`);
  }
  url.username = '';
  url.password = '';
  return url;
}

/** The part of PDF.js's PDFLinkService this module overrides. */
interface LinkServiceBase {
  addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean): void;
}

/**
 * A PDFLinkService variant that never navigates by itself (architecture section 8). PDF.js
 * already drops link targets it considers unsafe while parsing, so most hostile targets never
 * become an anchor at all; this is the second line: whatever address does reach
 * `addLinkAttributes` gets a neutral `href="#"` and no `target`, and only an http(s)/mailto
 * address (credentials stripped) can be opened, in a new tab with `noopener,noreferrer`, after
 * `confirm` resolves true. `javascript:`, `data:`, `file:`, `chrome:`, `blob:` and relative
 * addresses get a click handler that does nothing.
 */
export function confirmingLinkService<T extends new (...args: never[]) => LinkServiceBase>(
  Base: T,
  confirm: (url: string) => Promise<boolean>,
  open: (url: string) => void = (url) => void window.open(url, '_blank', 'noopener,noreferrer'),
): T {
  class ConfirmingLinkService extends (Base as new (...args: never[]) => LinkServiceBase) {
    override addLinkAttributes(link: HTMLAnchorElement, url: string): void {
      const safe = toSafeExternalUrl(url);
      link.removeAttribute('target');
      link.rel = 'noopener noreferrer nofollow';
      link.href = '#';
      if (!safe) {
        link.title = '';
        link.onclick = () => false;
        return;
      }
      link.title = safe.href;
      link.onclick = (event: MouseEvent) => {
        event.preventDefault();
        // Only the first click of a multi-click asks: a double click must not stack dialogs.
        if (event.detail > 1) return false;
        void confirm(safe.href).then((ok) => {
          if (ok) open(safe.href);
        });
        return false;
      };
    }
  }
  return ConfirmingLinkService as unknown as T;
}

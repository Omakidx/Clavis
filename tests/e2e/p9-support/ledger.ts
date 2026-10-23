import type { BrowserContext, Request } from '@playwright/test';

/**
 * A ledger of EVERY network request the browser makes, whoever makes it: pages, iframes, the
 * extension's service worker and (through a route) dedicated workers such as the PDF.js worker,
 * which Playwright's plain `request` event does not report. Used by the Phase 9 request-counting
 * and secret-boundary specs.
 *
 * Nothing can leave the machine: anything that is not the local fixture server or the (faked)
 * Groq API is recorded in `blocked` and aborted. Groq is answered by the fake that the harness
 * installed (or by a test override); a Groq request nobody answers is blocked as well.
 */
export interface LedgerEntry {
  url: string;
  method: string;
  host: string;
  /** Who asked: a document, the extension's service worker, or something else (a dedicated worker). */
  source: 'page' | 'service-worker' | 'worker';
  /** Request body, when there was one (text only). */
  body: string | undefined;
}

export interface Ledger {
  /** Every request the context saw, in order (including the local server and the fake Groq). */
  entries: LedgerEntry[];
  /** Requests to a host that is neither the local server nor Groq (always aborted). */
  blocked: string[];
  /** Position marker for `since`. */
  mark(): number;
  /** Entries recorded after `mark`. */
  since(mark: number): LedgerEntry[];
  /** `POST /chat/completions` requests, i.e. the paid ones. */
  chats(from?: number): LedgerEntry[];
  /** Calls to the models endpoint (key checks). */
  models(from?: number): LedgerEntry[];
}

const GROQ_HOST = 'api.groq.com';

function describe(request: Request): LedgerEntry {
  const url = request.url();
  let source: LedgerEntry['source'] = 'page';
  if (request.serviceWorker() !== null) {
    source = 'service-worker';
  } else {
    try {
      request.frame();
    } catch {
      // Requests of dedicated workers have no frame.
      source = 'worker';
    }
  }
  let body: string | undefined;
  try {
    body = request.postData() ?? undefined;
  } catch {
    body = undefined;
  }
  return { url, method: request.method(), host: new URL(url).hostname, source, body };
}

export async function installLedger(context: BrowserContext): Promise<Ledger> {
  const entries: LedgerEntry[] = [];
  const blocked: string[] = [];
  context.on('request', (request) => {
    // chrome-extension:// and data:/blob: loads are not network traffic.
    if (/^https?:|^wss?:/.test(request.url())) entries.push(describe(request));
  });
  // Registered after the harness's fake Groq, so it runs first: Groq and the local server fall
  // through to whatever answers them; everything else is blocked.
  await context.route(/^(https?|wss?):\/\//, (route) => {
    const url = route.request().url();
    const host = new URL(url).hostname;
    if (host === GROQ_HOST || host === '127.0.0.1' || host === 'localhost') {
      return route.fallback();
    }
    blocked.push(url);
    return route.abort('blockedbyclient');
  });
  return {
    entries,
    blocked,
    mark: () => entries.length,
    since: (mark) => entries.slice(mark),
    chats: (from = 0) =>
      entries
        .slice(from)
        .filter((e) => e.host === GROQ_HOST && e.url.endsWith('/chat/completions')),
    models: (from = 0) =>
      entries.slice(from).filter((e) => e.host === GROQ_HOST && e.url.endsWith('/models')),
  };
}

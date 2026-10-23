import type { BrowserContext, Page } from '@playwright/test';
import type { ContentWorld } from '../p3-support/content-world';
import { ACCEPT_KEY } from '../p8-accept-support/world';

/**
 * Secret-boundary probes (Phase 9). The "canary" is a fake key (`gsk_TEST...`, never a real
 * credential). A leak is the canary, or its unmistakable middle part, appearing anywhere a website,
 * a content script or a log could see it.
 */
export const CANARY = ACCEPT_KEY;
/** The key without its prefix and last four characters (Settings may show the last four). */
export const CANARY_MIDDLE = CANARY.slice('gsk_TEST'.length, -4);
export const NEEDLES = [CANARY, CANARY_MIDDLE];

/** The needles found in `text`, for a readable failure. */
export function leaksIn(text: string): string[] {
  return NEEDLES.filter((needle) => text.includes(needle));
}

interface DomNode {
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: DomNode[];
  contentDocument?: DomNode;
  shadowRoots?: DomNode[];
}

/**
 * Everything in a page's DOM as text, INCLUDING closed shadow roots and iframes: tag names,
 * attribute names and values, and text. The DevTools protocol sees what a page script cannot.
 * Input values are added by a second pass (they are properties, not attributes).
 */
export async function dumpDom(page: Page): Promise<string> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    const { root } = (await session.send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root: DomNode;
    };
    const parts: string[] = [];
    const walk = (node: DomNode): void => {
      parts.push(node.nodeName);
      if (node.nodeValue) parts.push(node.nodeValue);
      if (node.attributes) parts.push(node.attributes.join(' '));
      for (const child of node.children ?? []) walk(child);
      for (const shadow of node.shadowRoots ?? []) walk(shadow);
      if (node.contentDocument) walk(node.contentDocument);
    };
    walk(root);
    const values = await page
      .evaluate(() =>
        Array.from(document.querySelectorAll('input, textarea, select')).map(
          (el) => (el as HTMLInputElement).value,
        ),
      )
      .catch(() => [] as string[]);
    parts.push(...values);
    return parts.join('\n');
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** Web storage, IndexedDB names, cache names, cookies, window.name and history state of a page. */
export async function pageStores(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const out: unknown[] = [];
    try {
      out.push({ ...localStorage }, { ...sessionStorage });
    } catch {
      out.push('storage-denied');
    }
    out.push(document.cookie, window.name, history.state);
    try {
      out.push(((await indexedDB.databases?.()) ?? []).map((d) => d.name));
    } catch {
      out.push('idb-denied');
    }
    try {
      out.push(await caches.keys());
    } catch {
      out.push('caches-denied');
    }
    out.push(performance.getEntries().map((e) => e.name));
    return JSON.stringify(out);
  });
}

/** Installed before the page loads: records what the PAGE (main world) can observe of messages. */
export const MAIN_WORLD_SNIFFER = `(() => {
  const log = (globalThis.__p9sniff = []);
  addEventListener('message', (e) => { try { log.push('message:' + JSON.stringify(e.data)); } catch { log.push('message:?'); } }, true);
  for (const type of ['securitypolicyviolation', 'storage', 'hashchange', 'popstate']) {
    addEventListener(type, (e) => log.push(type + ':' + (e.blockedURI || e.key || '')), true);
  }
  new MutationObserver((records) => {
    for (const r of records) {
      log.push('mutation:' + r.type + ':' + (r.attributeName || '') + ':' + (r.target.nodeValue || r.target.nodeName));
      for (const n of r.addedNodes) log.push('added:' + (n.outerHTML ? n.outerHTML.slice(0, 200) : n.nodeValue));
    }
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})();`;

export interface Recorded {
  /** Messages the extension code in this document SENT (JSON). */
  sent: string[];
  /** Replies to them (JSON, or ERR:message). */
  replies: string[];
  /** Messages RECEIVED from the background (JSON). */
  incoming: string[];
  /** `storage.onChanged` events delivered to this document (JSON). */
  changes: string[];
}

const RECORDER = `(() => {
  const key = Symbol.for('p9.recorder');
  if (globalThis[key]) return;
  const rec = (globalThis[key] = { sent: [], replies: [], incoming: [], changes: [] });
  const wrap = (rt) => {
    const original = rt.sendMessage.bind(rt);
    rt.sendMessage = (...args) => {
      try { rec.sent.push(JSON.stringify(args[0])); } catch { rec.sent.push('?'); }
      const result = original(...args);
      return Promise.resolve(result).then(
        (reply) => { try { rec.replies.push(JSON.stringify(reply)); } catch { rec.replies.push('?'); } return reply; },
        (error) => { rec.replies.push('ERR:' + String(error && error.message)); throw error; },
      );
    };
  };
  wrap(chrome.runtime);
  if (typeof browser !== 'undefined' && browser.runtime !== chrome.runtime) wrap(browser.runtime);
  chrome.runtime.onMessage.addListener((message) => { try { rec.incoming.push(JSON.stringify(message)); } catch { rec.incoming.push('?'); } return false; });
  chrome.storage.onChanged.addListener((changes, area) => { rec.changes.push(area + ':' + JSON.stringify(changes)); });
})()`;

/** Record every message and storage event the extension code of this document sees. */
export async function installRecorder(world: ContentWorld): Promise<void> {
  await world.evaluate(RECORDER);
}

export function readRecorder(world: ContentWorld): Promise<Recorded> {
  return world.evaluate<Recorded>(`globalThis[Symbol.for('p9.recorder')]`);
}

/** The same recorder for an extension page (main world of chrome-extension://), added before it loads. */
export const EXTENSION_PAGE_RECORDER = `(() => {
  const rec = (globalThis.__p9rec = { sent: [], replies: [], incoming: [], changes: [] });
  const original = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (...args) => {
    try { rec.sent.push(JSON.stringify(args[0])); } catch { rec.sent.push('?'); }
    const result = original(...args);
    return Promise.resolve(result).then(
      (reply) => { try { rec.replies.push(JSON.stringify(reply)); } catch { rec.replies.push('?'); } return reply; },
      (error) => { rec.replies.push('ERR:' + String(error && error.message)); throw error; },
    );
  };
  chrome.runtime.onMessage.addListener((m) => { try { rec.incoming.push(JSON.stringify(m)); } catch { rec.incoming.push('?'); } return false; });
})();`;

/** Collect every console line and page error of every page, worker and extension page in the context. */
export function collectLogs(context: BrowserContext): string[] {
  const lines: string[] = [];
  context.on('console', (message) => lines.push(`${message.type()}: ${message.text()}`));
  context.on('weberror', (error) => lines.push(`weberror: ${error.error().message}`));
  const watch = (page: Page): void => {
    page.on('pageerror', (error) => lines.push(`pageerror: ${error.message}`));
  };
  context.pages().forEach(watch);
  context.on('page', watch);
  return lines;
}

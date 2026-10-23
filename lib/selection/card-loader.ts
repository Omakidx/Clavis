import { browser } from 'wxt/browser';
import { MESSAGE_VERSION } from '../config/constants';
import { actionError, EXPLAIN_CARD_GLOBAL, type ExplainCardApi } from './ui-api';

/**
 * Loads the explanation card on the first Explain (D-08: it is not part of the observer bundle).
 * The content script asks the background (LOAD_EXPLAIN_CARD), which injects
 * `content-scripts/explain-card.js` into THIS frame; the card then registers itself on a
 * symbol-keyed global of the extension's isolated world, which the page cannot see.
 *
 * Plain objects and no zod: this file ships inside the observer (budget 18 KB gzip, D-20).
 */

/** The card, when it is already running in this frame. */
export function loadedExplainCard(): ExplainCardApi | undefined {
  return (globalThis as Record<symbol, ExplainCardApi | undefined>)[EXPLAIN_CARD_GLOBAL];
}

export interface CardLoaderDeps {
  send(message: unknown): Promise<unknown>;
  wait(ms: number): Promise<void>;
  /** How long to wait for the card to register after the background says it is injected. */
  registerTimeoutMs: number;
}

const defaultDeps: CardLoaderDeps = {
  send: (message) => browser.runtime.sendMessage(message),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  registerTimeoutMs: 2000,
};

const POLL_MS = 25;

let loading: Promise<ExplainCardApi> | null = null;

/**
 * Resolves with the card, loading it first if needed (one load at a time per frame). Rejects with
 * `actionError('cardLoadFailed')` when the background cannot inject it or it never registers.
 */
export function loadExplainCard(deps: Partial<CardLoaderDeps> = {}): Promise<ExplainCardApi> {
  const ready = loadedExplainCard();
  if (ready !== undefined) return Promise.resolve(ready);
  loading ??= load({ ...defaultDeps, ...deps }).finally(() => {
    loading = null;
  });
  return loading;
}

async function load(deps: CardLoaderDeps): Promise<ExplainCardApi> {
  let reply: unknown;
  try {
    reply = await deps.send({ v: MESSAGE_VERSION, type: 'LOAD_EXPLAIN_CARD' });
  } catch {
    throw actionError('cardLoadFailed');
  }
  if ((reply as { ok?: unknown } | null | undefined)?.ok !== true)
    throw actionError('cardLoadFailed');
  // The script has run by the time the background replies; the wait only covers a slow start.
  for (let waited = 0; ; waited += POLL_MS) {
    const card = loadedExplainCard();
    if (card !== undefined) return card;
    if (waited >= deps.registerTimeoutMs) throw actionError('cardLoadFailed');
    await deps.wait(POLL_MS);
  }
}

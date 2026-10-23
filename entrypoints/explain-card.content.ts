import { createExplainCard } from '../components/explanation';
import { EXPLAIN_CARD_GLOBAL, type ExplainCardApi } from '../lib/selection/ui-api';

// The explanation card (Phase 5, D-08): NOT part of the always-loaded observer (budget 18 KB gzip,
// D-20), so it is its own bundle, built to content-scripts/explain-card.js (EXPLAIN_CARD_SCRIPT_FILE
// in lib/config/constants.ts). The background injects it into the sender's frame with
// `scripting.executeScript` when the content script sends LOAD_EXPLAIN_CARD on the first Explain.
//
// Like the observer it is declared with an empty `matches` and `registration: 'runtime'`, so it
// never appears in the manifest `content_scripts` and asks for no host access of its own.
//
// It runs in the extension's isolated world of that frame (the same world as the observer), so the
// registry below, keyed by a symbol, is unreachable for the page.
export default defineContentScript({
  matches: [],
  registration: 'runtime',
  // No postMessage announcing the extension id to the page, and no teardown on a forged
  // "script started" document event (see entrypoints/content.ts).
  noScriptStartedPostMessage: true,
  main(ctx) {
    // An orphaned script after an extension update cannot reach the background: never start.
    if ((browser.runtime as { id?: string } | undefined)?.id === undefined) return;

    const world = globalThis as Record<symbol, ExplainCardApi | undefined>;
    // A second injection replaces the first (its card, requests and cache are dropped).
    world[EXPLAIN_CARD_GLOBAL]?.destroy();
    const card = createExplainCard();
    world[EXPLAIN_CARD_GLOBAL] = card;

    // Only when the runtime is truly gone: a page can dispatch the event that aborts the context.
    ctx.onInvalidated(() => {
      if ((browser.runtime as { id?: string } | undefined)?.id !== undefined) return;
      card.destroy();
      if (world[EXPLAIN_CARD_GLOBAL] === card) delete world[EXPLAIN_CARD_GLOBAL];
    });
  },
});

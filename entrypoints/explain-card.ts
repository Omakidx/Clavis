import { createExplainCard } from '../components/explanation';
import { onRuntimeGone, runtimeAlive } from '../lib/selection/runtime-guard';
import { EXPLAIN_CARD_GLOBAL, type ExplainCardApi } from '../lib/selection/ui-api';

// The explanation card (Phase 5, D-08): NOT part of the always-loaded observer (budget 18 KB gzip,
// D-20), so it is its own bundle, built to explain-card.js (EXPLAIN_CARD_SCRIPT_FILE in
// lib/config/constants.ts). The background injects it into the sender's frame with
// `scripting.executeScript` when the content script sends LOAD_EXPLAIN_CARD on the first Explain.
//
// An unlisted script, like the observer (see entrypoints/observer.ts, audit L1): no WXT
// ContentScriptContext, so nothing is announced to the page, and it asks for no host access.
//
// It runs in the extension's isolated world of that frame (the same world as the observer), so the
// registry below, keyed by a symbol, is unreachable for the page.
export default defineUnlistedScript({
  main() {
    // An orphaned script after an extension update cannot reach the background: never start.
    if (!runtimeAlive()) return;

    const world = globalThis as Record<symbol, ExplainCardApi | undefined>;
    // A second injection replaces the first (its card, requests and cache are dropped).
    world[EXPLAIN_CARD_GLOBAL]?.destroy();
    const card = createExplainCard();
    world[EXPLAIN_CARD_GLOBAL] = card;

    // Only when the runtime is truly gone (update or removal).
    onRuntimeGone(() => {
      if (world[EXPLAIN_CARD_GLOBAL] !== card) return;
      card.destroy();
      delete world[EXPLAIN_CARD_GLOBAL];
    });
  },
});

import { bundledPreactLoader } from '../components/tooltip/bundled-loader';
import { t } from '../lib/i18n';
import { createSelectionController } from '../lib/selection/controller';
import { loadedExplainCard, loadExplainCard } from '../lib/selection/card-loader';
import { ownsFocus } from '../lib/selection/focus';
import { createListenController } from '../lib/selection/listen';
import { isShowNoticeMessage } from '../lib/selection/notice';
import {
  OBSERVER_GLOBAL,
  type SelectionControllerLike,
  type ToolbarActions,
} from '../lib/selection/ui-api';
import { isOpenSelectionMessage } from '../lib/site-access/messages';

// Framework-free selection observer with a bundled Preact toolbar (D-08, spike B option c;
// budget <= 18 KB gzipped for the whole file, D-20). Do not import React or the explanation card
// (components/explanation) here: the card is its own bundle, loaded on the first Explain click.
//
// D-02: registered at RUNTIME via browser.scripting.registerContentScripts after the
// user grants optional host permissions (lib/site-access), so it never appears in the
// manifest `content_scripts`. The same file is injected on demand via `activeTab`
// for users who declined site access.
//
// `matches` is intentionally empty: for `registration: 'runtime'` WXT copies
// `matches` into the manifest `host_permissions`, which would force an all-sites
// install prompt. The real match patterns (http://*/*, https://*/*) are passed to
// registerContentScripts from lib/site-access.
export default defineContentScript({
  matches: [],
  registration: 'runtime',
  allFrames: true,
  runAt: 'document_idle',
  // WXT announces every start with `window.postMessage({ type: '<extension id>:<name>:wxt:...' }, '*')`,
  // which tells any page script the extension id (fingerprinting). Off: the document CustomEvent
  // that WXT also dispatches is a forgeable "a newer script started" signal, so teardown below
  // never trusts it; symbol-keyed replacement (OBSERVER_GLOBAL) handles re-injection instead.
  noScriptStartedPostMessage: true,
  main(ctx) {
    // After an extension update the old script can outlive its runtime (every call then fails
    // with "Extension context invalidated"): never start from such a context.
    if ((browser.runtime as { id?: string } | undefined)?.id === undefined) return;

    const world = globalThis as Record<symbol, SelectionControllerLike | undefined>;
    // Registered AND activeTab-injected (or re-injected after an update) into the same frame:
    // the newest instance replaces the old one, which removes its listeners and its toolbar.
    world[OBSERVER_GLOBAL]?.stop();

    // Listen (Phase 6): TTS_SPEAK with the selected text only, no AI request and no Groq key.
    // The background reports the end of playback with TTS_EVENT, handled in `onMessage` below.
    const speech = createListenController();
    const actions: ToolbarActions = {
      listen: speech.listen,
      openVoiceSettings: speech.openVoiceSettings,
      // Phase 5: the card is loaded by the first Explain (LOAD_EXPLAIN_CARD -> the background
      // injects content-scripts/explain-card.js into this frame) and draws inside the toolbar.
      // The request, its states and its errors all live in the card; nothing is sent before this
      // press (FR-017).
      async explain(context) {
        const card = await loadExplainCard();
        await card.present(context);
      },
      // A trim makes a new snapshot: the old selection's explanation is not wanted any more.
      trim: () => loadedExplainCard()?.dismiss(),
      dismiss: (context) => loadedExplainCard()?.dismiss(context.snapshot.selectionId),
    };

    const controller = createSelectionController({ loadToolbar: bundledPreactLoader, actions });
    const onMessage = (
      message: unknown,
      sender: { id?: string } | undefined,
      sendResponse: (response: unknown) => void,
    ): true | undefined => {
      // Only our own background reports playback state (a request id it never saw is ignored too).
      if (sender?.id === browser.runtime.id && speech.handleEvent(message)) return undefined;
      if (isOpenSelectionMessage(message)) {
        const focus = message.focus === true;
        // The shortcut reaches every frame: only the frame the user is in reacts.
        if (focus && !ownsFocus(document, window === window.top)) {
          sendResponse({ ok: true, shown: false });
          return undefined;
        }
        void controller
          .openForCurrentSelection(focus ? { focus: true } : {})
          .then((shown) => sendResponse({ ok: true, shown }));
        return true;
      }
      if (isShowNoticeMessage(message)) {
        void controller
          .showNotice(t('toolbarNoticeFrameAccess'))
          .then((shown) => sendResponse({ ok: true, shown }));
        return true;
      }
      return undefined;
    };
    browser.runtime.onMessage.addListener(onMessage);

    // Remove listeners, observer, toolbar host and card. Runs for a newer injection (through the
    // symbol-keyed global, which a page cannot reach) and when the runtime is gone.
    let stopped = false;
    const instance: SelectionControllerLike = {
      stop() {
        if (stopped) return;
        stopped = true;
        try {
          browser.runtime.onMessage.removeListener(onMessage);
        } catch {
          // The runtime is already gone; the listener went with it.
        }
        controller.stop();
        loadedExplainCard()?.destroy();
        if (world[OBSERVER_GLOBAL] === instance) delete world[OBSERVER_GLOBAL];
      },
    };
    world[OBSERVER_GLOBAL] = instance;

    // WXT also aborts the context when a document event with its name arrives, and a page can
    // dispatch one. Tear down only when the extension runtime is truly gone (update or removal).
    ctx.onInvalidated(() => {
      if ((browser.runtime as { id?: string } | undefined)?.id === undefined) instance.stop();
    });
  },
});

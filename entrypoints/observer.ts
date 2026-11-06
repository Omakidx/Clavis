import { loadToolbar } from '../lib/selection/toolbar-loader';
import { t } from '../lib/i18n';
import { createSelectionController } from '../lib/selection/controller';
import { loadedExplainCard, loadExplainCard } from '../lib/selection/card-loader';
import { ownsFocus } from '../lib/selection/focus';
import { createListenController } from '../lib/selection/listen';
import { isShowNoticeMessage } from '../lib/selection/notice';
import { onRuntimeGone, runtimeAlive } from '../lib/selection/runtime-guard';
import {
  OBSERVER_GLOBAL,
  type SelectionControllerLike,
  type ToolbarActions,
} from '../lib/selection/ui-api';
import { isOpenSelectionMessage } from '../lib/site-access/messages';

// Framework-free selection observer (budget <= 18 KB gzip, D-20). Toolbar and card UI are
// injected separately by the background on first use. Never import their UI or artwork here.
//
// D-02: registered at RUNTIME via browser.scripting.registerContentScripts after the
// user grants optional host permissions (lib/site-access), so it never appears in the
// manifest `content_scripts`. The same file is injected on demand via `activeTab`
// for users who declined site access.
//
// An UNLISTED script, not `defineContentScript` (audit L1): WXT's ContentScriptContext always
// dispatches a document CustomEvent named after the extension id when a content script starts,
// whatever `noScriptStartedPostMessage` says, so a page that knows the published id could detect
// Clavis. An unlisted script creates no such context and emits nothing a page can hear. The build
// output is `observer.js` (OBSERVER_SCRIPT_FILE); replacing an older instance is symbol-keyed
// (OBSERVER_GLOBAL) and the runtime-gone teardown is lib/selection/runtime-guard.ts.
export default defineUnlistedScript({
  main() {
    // After an extension update the old script can outlive its runtime (every call then fails
    // with "Extension context invalidated"): never start from such a context.
    if (!runtimeAlive()) return;

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
      // injects explain-card.js into this frame) and draws inside the toolbar.
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

    const controller = createSelectionController({ loadToolbar, actions });
    const onMessage = (
      message: unknown,
      sender: { id?: string } | undefined,
      sendResponse: (response: unknown) => void,
    ): true | undefined => {
      // Only our own background reports playback state (a request id it never saw is ignored too).
      if (sender?.id === browser.runtime.id && speech.handleEvent(message)) return undefined;
      if (isOpenSelectionMessage(message)) {
        const focus = message.focus === true;
        // Explain from the context menu or the popup: only our own background asks for it.
        const explain = message.explain === true && sender?.id === browser.runtime.id;
        // The shortcut reaches every frame: only the frame the user is in reacts.
        if (focus && !ownsFocus(document, window === window.top)) {
          sendResponse({ ok: true, shown: false });
          return undefined;
        }
        void controller
          .openForCurrentSelection({
            ...(focus ? { focus: true } : {}),
            ...(explain ? { explain: true } : {}),
          })
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
    let stopWatching = (): void => undefined;
    const instance: SelectionControllerLike = {
      stop() {
        if (stopped) return;
        stopped = true;
        try {
          browser.runtime.onMessage.removeListener(onMessage);
        } catch {
          // The runtime is already gone; the listener went with it.
        }
        stopWatching();
        controller.stop();
        loadedExplainCard()?.destroy();
        if (world[OBSERVER_GLOBAL] === instance) delete world[OBSERVER_GLOBAL];
      },
    };
    world[OBSERVER_GLOBAL] = instance;

    // Remove everything when the extension runtime is truly gone (update or removal).
    stopWatching = onRuntimeGone(() => instance.stop());
  },
});

import { bundledPreactLoader } from '../components/tooltip/bundled-loader';
import { t } from '../lib/i18n';
import { createSelectionController } from '../lib/selection/controller';
import { ownsFocus } from '../lib/selection/focus';
import { createLocalActions } from '../lib/selection/local-actions';
import { isShowNoticeMessage } from '../lib/selection/notice';
import { OBSERVER_GLOBAL, type SelectionControllerLike } from '../lib/selection/ui-api';
import { isOpenSelectionMessage } from '../lib/site-access/messages';

// Framework-free selection observer with a bundled Preact toolbar (D-08, spike B option c;
// budget <= 18 KB gzipped for the whole file, D-20). Do not import React here: the Phase 5
// explanation card is loaded lazily on the first Explain click.
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
  main(ctx) {
    // After an extension update the old script can outlive its runtime (every call then fails
    // with "Extension context invalidated"): never start from such a context.
    if ((browser.runtime as { id?: string } | undefined)?.id === undefined) return;

    const world = globalThis as Record<symbol, SelectionControllerLike | undefined>;
    // Registered AND activeTab-injected (or re-injected after an update) into the same frame:
    // the newest instance replaces the old one, which removes its listeners and its toolbar.
    world[OBSERVER_GLOBAL]?.stop();

    const controller = createSelectionController({
      loadToolbar: bundledPreactLoader,
      // Phase 4: Listen and Explain only drive local visual states. Phase 5 and 6 pass their
      // own ToolbarActions (AI_EXPLAIN, TTS_SPEAK) here.
      actions: createLocalActions(),
    });
    world[OBSERVER_GLOBAL] = controller;

    const onMessage = (
      message: unknown,
      _sender: unknown,
      sendResponse: (response: unknown) => void,
    ): true | undefined => {
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

    // Extension update or a newer injection: remove listeners, observer and toolbar host.
    ctx.onInvalidated(() => {
      try {
        browser.runtime.onMessage.removeListener(onMessage);
      } catch {
        // The runtime is already gone; the listener went with it.
      }
      controller.stop();
      if (world[OBSERVER_GLOBAL] === controller) delete world[OBSERVER_GLOBAL];
    });
  },
});

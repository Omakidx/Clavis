import { createSelectionController } from '../lib/selection/controller';
import { backgroundInjectionLoader, dynamicImportLoader } from '../lib/selection/loaders';
import { OBSERVER_GLOBAL, type ToolbarLoader } from '../lib/selection/ui-api';
import { isOpenSelectionMessage } from '../lib/site-access/messages';

// Framework-free selection observer (D-08, budget <= 15 KB gzipped). Do not import
// React here. Spike B option (c) bundles a PREACT toolbar on purpose (the measured winner);
// it is tree-shaken out of the a/b measurement builds.
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

// The env comparisons are inlined (not hoisted into a variable) so the bundler folds
// them at build time and drops the unused variants' code. Default (variable unset) is
// option (c), the recommendation of docs/decisions/spike-b-toolbar.md.
function chooseLoader(): ToolbarLoader {
  if (import.meta.env.VITE_CLAVIS_TOOLBAR_VARIANT === 'a') return backgroundInjectionLoader;
  if (import.meta.env.VITE_CLAVIS_TOOLBAR_VARIANT === 'b') return dynamicImportLoader;
  // A dynamic import is used only so the branches above can drop this whole: Preact is not
  // marked side-effect free, so a static import would keep it in builds a and b.
  // WXT inlines it into the same file, so in build c nothing is fetched at runtime.
  return (options) =>
    import('../components/tooltip/bundled-loader').then((m) => m.bundledPreactLoader(options));
}

export default defineContentScript({
  matches: [],
  registration: 'runtime',
  allFrames: true,
  runAt: 'document_idle',
  main() {
    const world = globalThis as Record<symbol, unknown>;
    // Registered AND activeTab-injected into the same frame: only the first instance runs.
    if (world[OBSERVER_GLOBAL] !== undefined) return;
    const controller = createSelectionController({
      loadToolbar: chooseLoader(),
      // Spike B: toolbar actions are recorded in the card only; Phase 4/5 wire Listen and Explain.
      onAction: () => undefined,
    });
    world[OBSERVER_GLOBAL] = controller;

    browser.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      if (!isOpenSelectionMessage(message)) return undefined;
      void controller
        .openForCurrentSelection(message.focus === true ? { focus: true } : {})
        .then((shown) => sendResponse({ ok: true, shown }));
      return true;
    });
  },
});

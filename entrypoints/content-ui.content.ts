import { publishUi } from '../lib/selection/ui-api';

// Lazily loaded React UI (D-08, budget <= 60 KB gzipped). NOT in the manifest: injected by the
// background (option a) or imported by the observer (option b), or via activeTab for declined
// access. Option (c), the recommendation, bundles a Preact toolbar into the observer instead, so
// this file is empty there until Phase 5 needs a lazily loaded React card.
//
// `matches: []` keeps WXT from copying a pattern into `host_permissions`
// (see entrypoints/content.ts). Output: content-scripts/content-ui.js.
export default defineContentScript({
  matches: [],
  registration: 'runtime',
  allFrames: true,
  runAt: 'document_idle',
  main() {
    if (
      import.meta.env.VITE_CLAVIS_TOOLBAR_VARIANT !== 'a' &&
      import.meta.env.VITE_CLAVIS_TOOLBAR_VARIANT !== 'b'
    ) {
      return;
    }
    // Dynamic so React is dropped from the bundle when the branch above is dead (React packages
    // are not marked side-effect free). Inlined by WXT and settled in the same microtask drain,
    // so the UI is published before `executeScript` / `import()` resolve in the observer.
    void import('../components/tooltip/react-renderer').then(async ({ createReactRenderer }) => {
      const { createToolbar } = await import('../components/tooltip/toolbar');
      publishUi({ createToolbar: (options) => createToolbar(createReactRenderer(), options) });
    });
  },
});

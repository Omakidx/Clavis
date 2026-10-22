// Framework-free selection observer (D-08, budget <= 15 KB gzipped). Do not import
// React or any UI library here.
//
// D-02: registered at RUNTIME via browser.scripting.registerContentScripts after the
// user grants optional host permissions, so it never appears in the manifest
// `content_scripts`.
//
// `matches` is intentionally empty: for `registration: 'runtime'` WXT copies
// `matches` into the manifest `host_permissions`, which would force an all-sites
// install prompt. The real match patterns (http://*/*, https://*/*) are passed to
// registerContentScripts in Phase 3, from the granted optional permissions.
export default defineContentScript({
  matches: [],
  registration: 'runtime',
  allFrames: true,
  runAt: 'document_idle',
  main() {
    // Phase 4: observe `selectionchange` and report qualifying selections.
  },
});

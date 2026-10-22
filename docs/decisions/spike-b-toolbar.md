# Spike B: site access, selection and toolbar UI loading (D-02, D-08)

Status: complete. Date: 2026-10-22. Branch `phase-2-spikes`.
Chrome for Testing 156 (Playwright 1.64.1 bundled Chromium), Linux, 16 cores, WXT 0.21.4, React 19.3, Preact 11.0.1.

## Decision

**Option (c): a Preact toolbar bundled directly in the always-loaded observer.** The React explanation card is
loaded lazily in Phase 5, when the user first clicks Explain.

| Question | Answer |
| --- | --- |
| Which UI loading option? | (c) Preact toolbar in the observer. Options (a) background injection and (b) dynamic import of a web-accessible chunk both miss the budgets because of React, not because of the loading mechanism. |
| Observer size | 12.54 KB gzip (budget 15 KB, `npm run size` ok). Headroom for Phase 4 is 2.5 KB. |
| First toolbar | p50 about 32 ms, p95 60 to 74 ms on this (heavily loaded) machine. At 4x CPU slowdown: p95 143 to 149 ms, right at the 150 ms budget. |
| Later toolbars | p95 (conservative, frame-based) 35 to 44 ms, 27 to 33 ms at 4x. Budget 50 ms. |
| Site access | D-02 works end to end with the real Chrome prompt, real context menu, real toolbar icon and a keyboard shortcut (all automated, see "Permission flow"). |

Two consequences for other documents (manager to apply):

1. D-08 / tech-stack section 6: the **UI-on-first-selection budget (60 KB gzip) cannot hold for a React card**.
   React 19 plus react-dom plus our toolbar is **69.4 KB gzip**. Either raise the lazy-UI budget for the React card
   (about 75 to 80 KB) or author the card in Preact (`preact/compat` keeps React components usable, about +4 KB).
   With option (c) this no longer sits on the toolbar's critical path, so it is a Phase 5 decision, not a blocker.
2. The default build (variable unset) is option (c). `content-scripts/content-ui.js` is an empty 1.2 KB shell in that
   build, so `scripts/size-budgets.json` stays green without changes.

## What was built

| Area | Files |
| --- | --- |
| Site access (background) | `lib/site-access/{registration,injection,background,messages}.ts` |
| Site access (extension pages) | `lib/site-access/use-site-access.ts`, popup and onboarding edits |
| Selection (framework-free) | `lib/selection/{text,classify,context,eligibility,capture,observer,controller,ids,ui-api,loaders,variant}.ts` |
| Toolbar (Shadow DOM) | `components/tooltip/{toolbar,position,view,preact-renderer,react-renderer,bundled-loader}.ts`, `toolbar.css` |
| Entrypoints | `entrypoints/content.ts` (observer), `entrypoints/content-ui.content.ts` (lazy React UI for a and b) |
| Tests | `tests/unit/{selection,site-access}/**` (165 tests), `tests/e2e/spike-b-*.spec.ts`, `tests/e2e/spike-b-support/**`, `tests/fixtures/web/**` |

The three UI loading options share one toolbar tree (`view.ts` renders through a `createElement`-compatible factory,
so React and Preact draw identical DOM). They differ only in who loads what:

| Option | Observer does | Needs |
| --- | --- | --- |
| a | `runtime.sendMessage` -> background `scripting.executeScript({files:[content-ui.js]})` into the sender frame; UI publishes itself on a symbol-keyed global in the shared isolated world | nothing extra |
| b | `import(runtime.getURL('content-scripts/content-ui.js'))` | `web_accessible_resources` with `use_dynamic_url: true`. **WXT cannot declare this from an entrypoint file** (it only emits WAR entries for content-script CSS, with the script's own `matches`, which are empty here). It needs `wxt.config.ts` or a WXT module. Measured with a manifest-patched copy. |
| c | `createToolbar(createPreactRenderer())` directly | Preact in the observer bundle |

Build switch: `VITE_CLAVIS_TOOLBAR_VARIANT=a|b|c` (unset = c), folded at build time so the other variants' code and
Preact/React are tree-shaken (verified: content.js 5.1 KB gzip for a and b, 11.8 KB for c).

## Measurements

### Sizes (gzip level 9, KB = 1024 bytes; `node tests/e2e/spike-b-support/build-variants.mjs`)

| Option | Always-loaded `content-scripts/content.js` raw / gzip | Lazy `content-scripts/content-ui.js` raw / gzip | Budget |
| --- | --- | --- | --- |
| a background injection | 14.44 KB / **5.78 KB** | 223.64 KB / **69.52 KB** | 15 KB / 60 KB |
| b dynamic import | 14.38 KB / **5.75 KB** | 223.64 KB / **69.52 KB** | 15 KB / 60 KB |
| c Preact bundled (default) | 31.15 KB / **12.54 KB** | 3.35 KB / 1.21 KB (empty shell, React card comes in Phase 5) | 15 KB / 60 KB |

WXT's own content-script wrapper (context, locationchange watcher, logger) costs about 3.4 KB raw (an empty `main()` built to 3.42 KB) in every `content.js`.
React UI exceeds the 60 KB budget by 9.4 KB (16 percent) in a and b. CSS is inlined in the JS (`?inline`, adopted
stylesheet), so the figures already include styles.

### Latency, selection end to toolbar visible

Every sample is a fresh page load (new tab) of `tests/fixtures/web/article.html` from a local HTTP server; the first
load per browser is discarded. Selection is a real double-click through Playwright's mouse. "First" includes loading
the UI. "Repeat" is Escape, then selecting another word on the same page. Times in ms, p50 / p95 (nearest rank).
`dom` = toolbar visible in the DOM; `frame` = first animation frame after that (see error bars).

Two complete runs, 30 loads per option at 1x CPU, 20 at 4x CPU slowdown (`Emulation.setCPUThrottlingRate`, page main
thread only), 12 for the cold-worker case. Variants ran interleaved (a, b, c, a, b, c ...) in three browsers so the
load from other processes hit all options alike.

**Run 2** (load average 18 to 27 on 16 cores during the run):

| Option | Scenario | n | First, dom | First, frame | Repeat, dom | Repeat, frame |
| --- | --- | --- | --- | --- | --- | --- |
| a | warm worker, 1x | 30 | 137.0 / 237.7 | 137.9 / 238.7 | 9.3 / 26.4 | 21.9 / 35.3 |
| b | warm worker, 1x | 30 | 128.1 / 229.6 | 128.9 / 231.4 | 7.4 / 29.3 | 18.7 / 36.6 |
| **c** | warm worker, 1x | 30 | **31.1 / 58.6** | **32.8 / 60.1** | 4.2 / 15.1 | 18.4 / 34.7 |
| a | warm worker, 4x CPU | 20 | 373.7 / 441.0 | 374.4 / 448.5 | 29.6 / 55.0 | 31.5 / 64.5 |
| b | warm worker, 4x CPU | 20 | 379.1 / 523.4 | 385.3 / 528.1 | 27.1 / 51.6 | 30.9 / 52.2 |
| **c** | warm worker, 4x CPU | 20 | **93.1 / 143.3** | **97.4 / 144.1** | 16.5 / 25.7 | 21.4 / 26.7 |
| a | cold worker, 1x | 12 | 134.9 / 186.4 | 135.7 / 188.2 | 7.4 / 11.1 | 18.7 / 24.7 |
| c | control, 1x | 12 | 26.6 / 37.9 | 29.0 / 41.4 | 2.9 / 11.0 | 16.3 / 24.0 |

**Run 1** (load average 20 falling to 15), same method:

| Option | Scenario | First, frame | Repeat, frame |
| --- | --- | --- | --- |
| a | warm, 1x | 142.0 / 356.3 | 20.3 / 56.7 |
| b | warm, 1x | 134.8 / 364.3 | 18.9 / 40.4 |
| c | warm, 1x | 35.4 / 74.0 | 19.2 / 43.8 |
| a | warm, 4x | 385.2 / 511.7 | 31.5 / 50.7 |
| b | warm, 4x | 360.3 / 492.3 | 27.9 / 56.0 |
| c | warm, 4x | 108.6 / 149.4 | 20.4 / 33.4 |
| a | cold worker, 1x | 135.5 / 191.5 | 17.3 / 26.6 |
| c | control, 1x | 24.6 / 41.0 | 15.4 / 25.1 |

Budgets: first toolbar p95 <= 150 ms including UI load; later toolbars p95 <= 50 ms.

| Option | First p95, 1x | First p95, 4x | Later p95 (frame), 1x / 4x | Verdict |
| --- | --- | --- | --- | --- |
| a | 239 to 356 ms: **fails** (cold worker: 188 to 192) | 449 to 512 ms: **fails** | 35 to 57 / 51 to 65: marginal / fails | fails |
| b | 231 to 364 ms: **fails** | 492 to 528 ms: **fails** | 37 to 40 / 52 to 56: ok / fails | fails |
| c | 60 to 74 ms: passes | 144 to 149 ms: **passes by 1 to 6 ms** | 35 to 44 / 27 to 33: passes | passes |

What the numbers say:

- The loading mechanism is not the problem; **React's parse and evaluation is**. a (service-worker round trip plus
  `executeScript`) is only about 9 ms slower than b (dynamic import), and a **cold** worker costs nothing measurable
  on top of a warm one (135 vs 137 ms p50) because starting a tiny worker is hidden under evaluating 223 KB of React.
  Even a perfect loader for a React chunk would sit near 125 ms p50 at 1x and 350 ms at 4x.
- c spends about 30 ms p50 (1x), most of it forced layout from `getClientRects` (about 12 ms self time in a CDP profile of
  the first selection) plus capture and render. It scales roughly 3x with the 4x slowdown, which is why its 4x p95 is
  close to the limit. Phase 4 should keep the observer free of extra synchronous work (no storage round trip on the
  first selection) to protect that margin.
- Repeat latency is dominated by frame granularity: `dom` p50 is 3 to 9 ms, `frame` adds up to one 16.7 ms frame.

### Method and error bars

- Timestamps never leave the page: a probe injected with `addInitScript` (main world, before page scripts) records
  `performance.now()` at the capture-phase `mouseup` or `keyup` that ends the selection (`t0`), when a
  MutationObserver sees the toolbar host switch to display:block while popover-open (`tDom`; the root is closed, see below), and at the next
  `requestAnimationFrame` (`tFrame`). One clock, so Playwright and CDP latency are excluded.
- Error: `tDom` is accurate to well under 1 ms (the observer callback runs as a microtask right after the extension
  task). `tFrame` over-estimates by 0 to 16.7 ms (about 8 ms average at 60 Hz) and is the conservative figure.
  Neither includes rasterization and presentation. `t0` includes the observer's own scheduling (`setTimeout(0)`).
- The machine was shared and heavily loaded (load average 15 to 27 on 16 cores: other agents, a day-old headless
  Chrome GPU process, Firefox, Blender). Absolute numbers are pessimistic and p95 is noisy; the ordering was the same in
  both runs and in an earlier unloaded n=3 smoke run (a 115, b 95, c 24 ms p50). **Re-run on a quiet reference machine
  before treating the 4x p95 of c (143 to 149 ms) as a pass.**
- 4x CPU throttling is a stand-in for a mid-range laptop; it slows the page, not the service worker or the browser
  process. The fixture is served from localhost with no network latency. Chromium 156 headless, one window.
- Reproduce: `node tests/e2e/spike-b-support/build-variants.mjs`, then
  `CLAVIS_EXTENSION_DIR=.output-spike-b/chrome-mv3 npx playwright test tests/e2e/spike-b-measure.spec.ts`
  (about 4 minutes; `CLAVIS_MEASURE_RUNS`, `_THROTTLED_RUNS`, `_COLD_RUNS` change n).

## Permission flow findings (D-02, FR-009, FR-015, FR-018)

All automated unless marked manual. "Real UI" tests run in visible Chromium under `xvfb-run` and drive Chrome's native
dialogs with `xdotool` (`tests/e2e/spike-b-real-ui.spec.ts`, opt-in with `CLAVIS_E2E_REAL_UI=1`).

1. **Install shows no all-sites warning.** `chrome.developerPrivate.getExtensionsInfo` on `chrome://extensions` reports
   `hasAllHosts: false`, only `https://api.groq.com/*`, and no simple-permission warnings for the shipped manifest; a
   control copy that declares the origins as required reports `hasAllHosts: true`, so the check is not vacuous.
   (A Web Store install dialog is still worth one manual look.)
2. **The permission prompt can be automated.** In headless Chromium `permissions.request` stays pending forever. In a
   visible window it is a modal titled "Clavis has requested additional permissions" with "Read and change all your
   data on all websites", Deny focused. `Tab` then `Space` presses Allow, `Return` presses Deny. Allow resolves `true`,
   `permissions.onAdded` registers the observer, and a new tab shows the toolbar with no further action. Deny leaves
   everything off and the button usable again.
3. **Revoke and re-grant work.** `permissions.remove` and Chrome's own Site access switch (chrome://extensions details:
   On click / On all sites, driven through `developerPrivate.updateExtensionConfiguration`) fire `onRemoved` / `onAdded`;
   the registration disappears and returns, and new pages follow it.
4. **Already-open tabs are not injected after a grant.** The registered script only runs on later navigations; a tab
   opened before the grant shows no toolbar until it is reloaded (tested). Phase 3 decision: either inject into open
   http(s) tabs when `onAdded` fires (host access exists by then, `tabs.query({url})` works) or tell the user to reload.
5. **Registration details.** `persistAcrossSessions: true`, `allFrames: true`, `runAt: document_idle`, `excludeMatches`
   for the two Web Store hosts, `matchOriginAsFallback: true` so `about:blank` and `srcdoc` frames are covered (reader
   apps use them; tested with a srcdoc frame). `matchOriginAsFallback` needs **Chrome 119**: below that Chrome rejects the
   property, so registration retries without it (unit tested only; Chrome 116 to 118 were not available). **Proposal:
   raise `minimum_chrome_version` to 119**, or accept losing blank/srcdoc frames on 116 to 118.
   Forced refreshes (install/update) use `updateContentScripts`, so there is never a moment with no observer;
   concurrent reconciles are serialized because registering the same id twice is an error.
6. **Declined path, context menu: works (real UI).** Right-click on a selection shows "Explain with Clavis" (just above
   Inspect); choosing it injects into the clicked frame of that tab only (a second tab stays untouched), no host
   permission and no registered script involved.
7. **Declined path, toolbar icon.** The action has a popup, so `action.onClicked` never fires. Clicking the icon grants
   `activeTab` for the tab and opens the popup; its **Explain on this page** button (shown only while site access is not
   granted) asks the background to inject into all frames and open the toolbar for the current selection (real UI test).
   `chrome.action.openPopup()` does **not** grant `activeTab`: the popup then shows "Chrome did not give Clavis access
   to this tab..." (dedicated message), so test the fallback only with a real click.
8. **Declined path, keyboard shortcut (new, recommended).** A manifest `commands` entry is a user gesture too, so it
   grants `activeTab`, works with or without site access, and moves keyboard focus into the toolbar (the only way
   in for keyboard users; the toolbar sits at the end of the DOM and must not steal Tab). Tested with a patched
   manifest (`Alt+Shift+E`). The shipped manifest does **not** have it yet: see "Required changes".
9. **LIMIT: `activeTab` does not cover cross-origin iframes.** Right-click in a same-origin iframe works; in a
   cross-origin iframe Chrome answers "Cannot access contents of the page. Extension manifest must request permission
   to access the respective host." (tested). With all-frames injection (popup, shortcut) the accessible frames still
   work and the inaccessible ones are skipped, so a page full of ad iframes does not break the top document.
   Selections inside cross-origin iframes need site access. Phase 4 should show a message for that case; a possible
   improvement is injecting into the top frame and using the context menu's `selectionText` (no rect, no context).
10. **Restricted pages.** `chrome://extensions` returns `restricted` ("Cannot access a chrome:// URL"), the Web Store is
    excluded in the registration and refused before any attempt; neither throws and the popup says so. Web pages
    cannot reach the injection routes (no `runtime.sendMessage` without `externally_connectable`); the routes also
    check `sender.id`, and the popup route checks that the sender is an extension page.
11. **Missing manifest keys crash the worker.** `chrome.commands` is `undefined` when the manifest has no `commands`;
    touching it threw during startup and took onboarding down with it (caught by E2E). It is guarded and unit tested.
12. Chrome lists Clavis under "Access requested" in the Extensions (puzzle) menu on a fresh install with the optional
    permissions. Clicking it opens the popup. Worth a look at the wording, but nothing to fix in code.

## Selection and toolbar findings (FR-010 to FR-017)

- Mouse (double-click, drag), keyboard (Shift+Arrow extension, Ctrl+A) and programmatic selections all produce one
  toolbar next to the selection on: plain article, nested inline markup, scroll container, fixed header with an extreme
  z-index, RTL (Arabic/Hebrew), same-origin, cross-origin and `srcdoc` iframes, viewport corners, rotated text, and a
  320 px wide viewport (the equivalent of heavy browser zoom; real zoom was not driven).
- Chrome only extends an existing selection with Shift+Arrow in static text (no caret without caret browsing), so the
  keyboard fixtures grow a double-click selection; RTL needs ArrowLeft to grow forward.
- **Snapshot retention (FR-014).** The snapshot is captured at selection end, never re-read. Button presses call
  `preventDefault` on `mousedown` and set an "interacting" flag on `pointerdown`, so a page that clears the selection on
  mousedown (simulated) neither dismisses the toolbar nor changes the recorded snapshot. Escape, outside press, and
  selection removal after the interaction dismiss it. A late `selectionchange` can never postpone a capture that
  `mouseup` asked for (the debounce only moves earlier; found by unit test).
- **No work before selection.** The listeners only check `Selection.isCollapsed`; UI loads on the first qualifying
  selection with a stale-selection guard for slow loads.
- **Placement.** Above the first line, else below the last, else floating at the bottom edge; clamped to the viewport;
  follows scrolling of the window and of scroll containers through a capture-phase `scroll` listener, throttled with
  `requestAnimationFrame`; hides when the selection leaves the viewport. The host uses the **popover API (top layer)**
  so no z-index war: it stays above a `z-index: 2147483647` header (tested). Fallback is a high z-index without the API.
- **Isolation.** Shadow DOM, **closed** (see "Security review follow-up"), styles in a constructable stylesheet (a `<style>` element would be blocked by a
  strict page `style-src` CSP), `:host { all: initial }`, inline `!important` host styles against page CSS.
- **Eligibility.** Ignores collapsed, inputs, textarea, select, contenteditable (except `contenteditable="false"`
  islands), password fields, `designMode`, hidden (`display:none`, `visibility:hidden`, no boxes), Clavis's own UI and
  non-http(s) documents.
- **Context.** From the nearest block only, at most 500 characters per side (1,000 total), never `body.innerText`;
  scripts, styles, forms, nav, buttons, `hidden` and `aria-hidden` are skipped; 400 text nodes visited at most per
  side; whole words only; inline markup does not gain spaces (`un<b>break</b>able`).
- **IDs.** `crypto.randomUUID` does not exist on plain-http pages (content scripts inherit the page's secure-context
  status), so `selectionId` is built from `getRandomValues`; the contract schema accepts it (unit tested).
- **FR-017.** No request to `api.groq.com` from the page or the worker on selecting, dismissing, Listen or Explain
  (Playwright context-level request tracking, with a positive control that proves the tracker sees both page and worker
  requests). The fixture server saw only the fixture itself.
- **Accessibility.** `role="toolbar"` with a name, native buttons, roving focus with arrows/Home/End (RTL aware),
  visible focus ring, `role="status"` for the card, no animation (reduced motion trivially respected), all strings
  through `t()`.

## Popup fallback design

`entrypoints/popup/App.tsx` calls `useSiteAccess()` (reads `permissions.contains`, follows `onAdded/onRemoved`). While
status is `not-granted` it shows **Explain on this page** plus a hint. Click: `tabs.query({active, currentWindow})`,
then `runtime.sendMessage({type:'CLAVIS_INJECT_TAB', tabId, url})`; the background injects observer and UI into all
reachable frames with the `activeTab` grant and asks each to show its toolbar. Replies map to messages: `shown` closes the
popup; "No text is selected"; "can't run on this kind of page"; "Chrome did not give Clavis access to this tab";
generic failure. Everything is plain text through `t()`. The onboarding step calls `permissions.request` synchronously
in the click handler (`useSiteAccess().grant`), shows a pending, granted, denied or error status, and "Not now"
explains the right-click alternative (it does not persist the choice yet; that is Phase 3).

## Security review follow-up (HIGH-1, LOW-4)

A page script could drive the toolbar: select text programmatically, click the open shadow root's Explain button and
read the card. Fixed:

- **Host is a plain `div[popover]`**, no custom tag, no id/class/data attributes; own-UI checks use a `WeakSet` on a
  symbol-keyed global of the isolated world (`lib/selection/own-ui.ts`). The root is `attachShadow({mode: 'closed'})`
  and lives only in the toolbar's closure, so `host.shadowRoot` is `null` to pages. A page that pre-defines likely tag
  names as custom elements with `attachInternals()` finds nothing to upgrade. Page patches of `attachShadow`,
  `createElement` and `customElements.define` never run for the extension (its world has its own prototypes); both
  are asserted. The host is `display:none` while idle and `block` while shown.
- **Trusted events only** (`lib/selection/trust.ts`, `event.isTrusted`): toolbar clicks, arrow keys, Escape, outside
  `pointerdown` and the "interacting" pointer flag ignore synthetic events; the observer shows the toolbar only when a
  trusted `mouseup`/`keyup` happened within 1.5 s of the capture, so a page-made selection plus fake events does
  nothing. Residual risk: a page can still time a programmatic selection to a genuine user gesture; the user then
  sees (and must click) the toolbar, and Phase 5 must show the text before sending. The extension's own paths
  (context menu, popup, shortcut, via `runtime.sendMessage`) are unaffected.
- **Context hiding (LOW-4)**: elements are checked with `checkVisibility` using every option spelling
  (`opacityProperty`, `visibilityProperty`, `contentVisibilityAuto` and the legacy ones) plus computed style
  (`display`, `visibility`, `opacity` of any ancestor, transparent color, `clip`, `clip-path`,
  `content-visibility:hidden`); each text node must have a non-empty box that is not entirely left of or above the
  document and not clipped by an `overflow:hidden` ancestor or a 1px box. Text merely scrolled out of view in a
  scroller stays. Verified in real Chrome by bundling the production module (`spike-b-context.spec.ts`), which found
  one real gap (`content-visibility:hidden`) that the unit mocks could not.
- **Tests.** The closed root cannot be pierced by Playwright locators, so specs read it through the DevTools protocol
  (`DOM.getDocument` with `pierce`, `tests/e2e/spike-b-support/toolbar.ts`) and click with real mouse events; nothing is
  shipped for tests. `spike-b-hostile.spec.ts` (fixture `hostile.html`) covers synthetic events, a page-made selection,
  pre-defined custom elements, patched prototypes and the real-mouse path; it fails (2 of 4) when the trust check is
  disabled. The latency probe now watches the host's `display`/`:popover-open` since it cannot look inside.
- **Phase 3 (per-tab rate limit, one in-flight AI request per tab)** is not blocked: every toolbar action already
  carries `selectionId` and runs from a trusted click, and the background receives `sender.tab.id` for content-script
  messages, so the router can key limits on the tab.

## Required changes outside this spike's files

1. `wxt.config.ts`: add `commands: { 'explain-selection': { suggested_key: { default: 'Alt+Shift+E' }, description:
   '__MSG_toolbarCommandExplain__' } }` (the message key already exists), and update `scripts/expected-permissions.json`
   and architecture section 3 if commands are audited there. Optional for option (c) otherwise.
2. `wxt.config.ts` `minimum_chrome_version`: at least 119 (see finding 5), or accept the 116 to 118 gap.
3. Option (b) only (not recommended): `web_accessible_resources: [{ resources: ['content-scripts/content-ui.js'],
   matches: ['http://*/*','https://*/*'], use_dynamic_url: true }]`.
4. `scripts/size-budgets.json`: paths already match (`content-scripts/content.js`, `content-scripts/content-ui*.js`).
   Revisit the 61,440 byte lazy-UI cap when the React card lands (69.4 KB gzip today for toolbar plus React).
5. `lib/contracts/messages.ts`: Spike B messages (`CLAVIS_INJECT_UI`, `CLAVIS_INJECT_TAB`, `CLAVIS_OPEN_SELECTION`) are
   plain objects in `lib/site-access/messages.ts` because the observer must not import zod (the contracts chunk is
   91 KB). Fold them into the Phase 3 router; keep the guards zod-free for the observer side.
6. Delete the variant switch in Phase 4: keep `entrypoints/content.ts` with `bundledPreactLoader`, delete
   `lib/selection/loaders.ts`, `lib/selection/variant.ts`, the React renderer and `content-ui.content.ts` until the card.

## Manual verification in your own Chrome

1. `npm run build` (or `WXT_OUT_DIR=.output-spike-b npx wxt build`), open `chrome://extensions`, enable Developer mode,
   Load unpacked, select `.output*/chrome-mv3`.
2. The welcome page opens. On the extension's details page confirm no "read and change all your data on all websites"
   is listed as granted (only the Groq host is), and that Site access offers no all-sites access yet.
3. Welcome page, **Enable on websites**: Chrome shows "Clavis has requested additional permissions". Allow.
   The page says website access is on. In the extension's service worker console:
   `chrome.scripting.getRegisteredContentScripts()` returns one script (`clavis-observer`).
4. Open any https article in a **new** tab (existing tabs need a reload), double-click a word: the toolbar (Listen,
   Explain) appears next to it. Escape closes it. Drag-select a sentence, Shift+Arrow to grow it, scroll while it is
   open. Click Explain: a placeholder card with your text appears and the toolbar stays.
5. `chrome://extensions` > Clavis > Details > Site access > **On click**: the registration disappears (re-run the
   console command, `[]`), new tabs show no toolbar. Switch back to **On all sites**: it returns.
6. Declined path: remove access (or use a fresh profile, choose Not now). Select text on a page: nothing appears.
   Right-click it: **Explain with Clavis** shows the toolbar. Reload, select again, click the Clavis toolbar icon and
   **Explain on this page**: same result. After adding the `commands` entry, press Alt+Shift+E: toolbar plus focus.
7. Check that a page with a cross-origin iframe (any news site with ads) still works for text in the main document,
   and that `chrome://extensions` and the Web Store do nothing and do not show errors.

## Open issues and follow-ups

- **Keyboard entry to the toolbar** needs the `commands` entry (above). Without it keyboard-only users cannot reach
  the buttons (FR-013 and FR-016 are met in code, not yet through the shipped manifest).
- **Cross-origin iframes under `activeTab`** are refused by Chrome (finding 9): needs a user-facing message in Phase 4
  and maybe the `selectionText` fallback.
- **Modal `<dialog>`**: a page that opens `showModal()` makes everything outside the dialog inert, including our
  top-layer host. Not handled; append the host inside the open dialog if one exists.
- **Selections inside page shadow roots** (web components) are not seen: `Selection` retargets to the host. Chrome's
  `getComposedRanges()` can fix this.
- **Per-site disable (FR-009)** cannot be read by the observer: the secret-boundary rule makes `storage.local`
  TRUSTED_CONTEXTS only. Prefer rewriting `excludeMatches` with `updateContentScripts` when a site is disabled (no
  round trip, no code in pages) over asking the background on every first selection (a worker round trip cost about 9 ms
  warm in the a-versus-b comparison above, more when the worker is cold).
- **Grant must reach open tabs** (finding 4) and the declined choice must be persisted (Phase 3).
- **Phase 5 card budget** (see Decision). If the card stays React, load it on the first Explain click through option
  (a): it needs no manifest change, and its roughly 130 ms overlaps the AI request.
- Not tested: real browser zoom (only narrow viewports), pinch zoom and `visualViewport`, touch selection handles,
  Chrome 116 to 118, other OSes, a quiet reference machine for the absolute numbers, and the Web Store install dialog.
- Classification is heuristic by design (abbreviations such as "e.g." are handled, "Ph.D. thesis." and similar are
  not); it steers actions and never what is sent. Unspaced scripts use `Intl.Segmenter` (only for those scripts).

## How to run everything

```text
npx vitest run tests/unit/selection tests/unit/site-access
node tests/e2e/spike-b-support/build-variants.mjs                     # builds a, b, c and the default
CLAVIS_EXTENSION_DIR=.output-spike-b/chrome-mv3 npx playwright test tests/e2e/spike-b-selection.spec.ts tests/e2e/spike-b-declined.spec.ts
CLAVIS_E2E_REAL_UI=1 CLAVIS_EXTENSION_DIR=.output-spike-b/chrome-mv3 \
  xvfb-run -a -s "-screen 0 1920x1080x24" npx playwright test tests/e2e/spike-b-real-ui.spec.ts   # needs xdotool + ImageMagick
CLAVIS_EXTENSION_DIR=.output-spike-b/chrome-mv3 npx playwright test tests/e2e/spike-b-measure.spec.ts
```

`npx playwright test tests/e2e/spike-b-*.spec.ts` runs all of them; the real-UI spec and the measurement need their
preconditions (display and build variants) and skip themselves otherwise.

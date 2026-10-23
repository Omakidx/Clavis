# Phase 8 spike: opening a per-tab side panel from a trusted click (FR-042)

**Date:** 2026-10-23 · **Chrome:** Chrome for Testing 156.0.8078.4 (Playwright's bundled Chromium; the extension's minimum is 147) · **OS:** Linux, `xvfb-run`, real mouse through `xdotool` · **Evidence:** `tests/e2e/p8-sidepanel-spike.spec.ts` (a scratch extension in `tests/e2e/p8-sidepanel-support/spike-ext`), `tests/e2e/p8-sidepanel-realui.spec.ts` (the shipped build).

```text
CLAVIS_E2E_REAL_UI=1 xvfb-run -a -s "-screen 0 1920x1080x24" \
  npx playwright test tests/e2e/p8-sidepanel-spike.spec.ts tests/e2e/p8-sidepanel-realui.spec.ts --workers=1
```

## Question

`chrome.sidePanel.open()` "may only be called in response to a user action". The card is a content script's Preact UI in a closed shadow root; the click happens in the page, the API lives in the service worker. Does a message from a trusted click carry the gesture to the worker, and what must the worker do?

## Findings

| Pattern in the service worker (message from a **real mouse click** in the content-script card) | Result |
| --- | --- |
| A. `setOptions({ tabId, path, enabled: true })` **not awaited**, then `open({ tabId })`, same synchronous turn | **Works.** The real panel opened at `panel.html?tab=<id>`. |
| B. `await setOptions(...)`, then `open(...)` | **Fails:** "`sidePanel.open()` may only be called in response to a user gesture." |
| C. `setOptions` done earlier (no gesture needed), then `open()` alone in the handler | Works. |
| D. `open()` six seconds after the click (`setTimeout`) | Fails (same error). |
| E. Message with **no user activation** (sent by a timer, 7 s after load; a probe that waits 1.5 s is still inside the 5 s activation Playwright's `goto` leaves, so use 7 s) | Fails (same error). The same with an `await Promise.resolve()` first, and with `open()` and no earlier `setOptions`, also fails. |
| F. An extension page (reader, practice) calls `setOptions` + `open` itself from its own click | Works. (Not used: the hand-off needs the worker anyway, and one code path is simpler.) |

**Conclusion.** The gesture of a trusted click reaches the worker through `runtime.sendMessage`, but only for the synchronous part of the message event. The shipped route (`OPEN_SIDE_PANEL`, `lib/router/handlers/sidepanel.ts`) therefore validates, stores the hand-off, calls `setOptions` and `open` without awaiting anything in between, and only then awaits their results. The same message from a content script with no gesture is refused by Chrome, so a compromised content script cannot pop the panel open (checked on the shipped build: reply `INTERNAL_ERROR`, nothing kept, panel not left enabled). The card's click handler must also reach `runtime.sendMessage` synchronously (a unit test asserts it).

## Panel facts that shaped the design

- **Per tab.** `setOptions({ tabId, path, enabled: true })` makes the panel exist for that tab only; another tab reports `{ enabled: false }`. The tab id rides in the panel's own path (`sidepanel.html?tab=7`), because the panel page cannot ask for its tab: `chrome.tabs.getCurrent()` is `undefined` there.
- **Sender shape.** The real panel's messages arrive with `sender.id` = our id, `sender.url` = its full url (query included), **no `sender.tab`, no `frameId`** (same as the popup). `classifySender` accepts a tab-less sender for exactly `/popup.html` and `/sidepanel.html`.
- **Tab options survive navigation.** After the tab navigated, `getOptions({ tabId })` still said enabled with the same path, and the panel stayed open. Chrome does not clear the explanation, so the worker does: it drops the hand-off when the tab starts loading another page (`tabs.onUpdated` `status: 'loading'`; no host permission needed) and tells the panel.
- **No default panel.** WXT turns `entrypoints/sidepanel` into `side_panel.default_path`, which would offer one shared panel on every tab and keep showing one tab's explanation after a tab switch. `wxt.config.ts` removes that key in `build:manifestGenerated`; the panel exists only where the worker enabled it. The manifest gains only the `sidePanel` permission.
- **Chrome's own UI.** The real panel is not exposed to Playwright as a page, so the real-UI spec checks `runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })` (document url ends `?tab=<id>`) and keeps a screenshot; locator-level tests open the same page in an ordinary tab (`tests/e2e/p8-sidepanel-flow.spec.ts`).
- Headless Chromium also opens the panel for Playwright's synthesised (trusted) clicks, so the card-to-worker-to-panel path has headless E2E coverage too.

## Not covered

- A worker restart while a panel is open is covered by unit tests and by opening a panel for a tab with nothing held (same code path); the worker itself was not killed mid-test.
- Windows and macOS: not run (same API; Linux only by hand, D-14).

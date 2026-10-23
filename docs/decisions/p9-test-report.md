# Phase 9 test report: requirement-traceable verification of the release candidate

Independent, black-box verification of Clavis for the Phase 9 gate ("no blocking bugs, security leaks, policy conflicts or broken core flows", [execution-phases.md](../execution-phases.md#phase-9--qa-performance-reliability-privacy-and-security)). Written by the verification specialist, not by the implementers. Scope: the **automated verification** half of Phase 9. Performance and memory budgets, the release-candidate version and the ZIP/CI hardening are in [p9-performance.md](p9-performance.md); the security, privacy and permissions audit is in [phase-9-security-review.md](phase-9-security-review.md). This report cites them and does not repeat them.

**Verdict (details in section 8): the release candidate meets the Phase 9 gate for everything that can be verified without a person, with no blocking defect found.** Four new defects were found and reproduced (none blocking; one Medium, three Low), plus earlier-phase defects that stay open. Six checks need a human before the listing goes public (section 7).

## 1. Method

- **Traceability first.** Every requirement ID in [requirements.md](../requirements.md) (FR-001 to FR-079), the nonfunctional requirements (section 5), the error catalogue (section 7), the abuse cases (section 8), the verification matrix rows (section 9) and the user journeys were mapped to the tests that verify them (section 6). The inventory existed already: 81 e2e spec files with 898 tests and 107 unit files with about 1,500 tests before this phase. A gap is a requirement or Phase 9 checklist item with no test that observes the behaviour; the new tests below close those gaps and do not repeat existing ones.
- **Lowest layer that proves it.** Pure logic as unit tests (fuzzing, invariants, the route table), the real background composition over a fake browser as integration tests (`registerBackground` with real stores, router, limiter and Groq adapter), and Chrome end to end only where the behaviour is the browser's (storage access level, service worker termination, restarts, the closed shadow root, real mouse input).
- **Black box.** Nothing was asserted from production internals. Specs drive the built extension with real trusted mouse and keyboard input and read the closed-shadow-root toolbar and card through the DevTools protocol, like the Phase 4, 7 and 8 acceptance suites (shared helpers are reused, never edited).
- **One ledger of all traffic.** `tests/e2e/p9-support/ledger.ts` records every http(s) request from pages, frames, the service worker and (through a route) dedicated workers, and aborts anything that is not the local fixture server or the faked Groq API. "Zero requests" is therefore measured, not assumed. It has a positive control (a page, a worker and the service worker each make a request to a canary host and all three are seen and blocked).
- **A hostile world on purpose.** Fake keys start with `gsk_TEST`. The fake Groq echoes the key, the prompt and markup in every error body; the fake model echoes hostile selected text back in every field. Nothing reaches the real Groq or any other host. Defects are `test.fail` with a `// DEFECT Qn:` comment; each was run once **without** `test.fail` and failed for the stated reason (evidence in section 4).
- **No weakening.** No assertion was relaxed, skipped or deleted. Where a test needed the machine to be in a state (no voice), the state is produced by a scripted `chrome.tts`, so the test does not depend on the machine.
- **Self-checks.** Every scanner has a test that shows it fails when the thing it looks for is present (the leak scan, the request ledger, the structure probe, the route policy, the log and sink scanner, the interleaving checker was also mutation-checked against a deliberately broken session).

## 2. Environment, build and commands

| Item | Value |
| --- | --- |
| Machine | Linux 5.15, Playwright 1.64.1 bundled Chromium (Chrome for Testing, new headless), shared box, 1-minute load average 10 to 21 (other agents running Playwright and builds) |
| Branch / base | `phase-9-qa`, on commit 4491f55 plus the working tree of the other Phase 9 agents (not committed) |
| Build under test | production build, `WXT_OUT_DIR=.output-p9-verify npx wxt build` (built 2026-10-23 14:05 from the working tree: version 1.0.0, observer and card as unlisted scripts `observer.js` and `explain-card.js`, i.e. with the Phase 9 audit fixes already in; the same output was zipped with `wxt zip` (`clavis-1.0.0-chrome.zip`, 2.62 MB) for the ZIP test) |
| Groq | answered by Playwright routes; fake `gsk_TEST...` keys; no external network (one exception: `spike-a-groq.spec.ts`, an older spec, makes 3 requests to the real `api.groq.com` with a fake key and expects 401) |
| Chrome UI | headless; Chrome's own permission prompt, context menu and toolbar icon are not clickable headless. Stand-ins used (as in Phases 3 to 8): a manifest copy that lists the optional origins as granted; the real `contextMenus.onClicked` listener driven by dispatching the event inside the service worker. The real prompt, menu, icon and shortcut run in the opt-in `*-realui.spec.ts` specs under `xvfb-run` (run in this phase on the final build: 24 of 24 passed, section 3) |

```text
# build (own directory; other agents build and run Playwright concurrently)
WXT_OUT_DIR=.output-p9-verify npx wxt build

# new Phase 9 specs (11 files, own output directory)
CLAVIS_EXTENSION_DIR=.output-p9-verify/chrome-mv3 npx playwright test \
  tests/e2e/p9-groq-failures.spec.ts tests/e2e/p9-reselection.spec.ts tests/e2e/p9-declined-access.spec.ts \
  tests/e2e/p9-request-ledger.spec.ts tests/e2e/p9-fuzz-selection.spec.ts tests/e2e/p9-secret-boundary.spec.ts \
  tests/e2e/p9-onboarding-access.spec.ts tests/e2e/p9-pdf-flow.spec.ts tests/e2e/p9-journey.spec.ts \
  tests/e2e/p9-frames-and-history.spec.ts tests/e2e/p9-min-chrome-smoke.spec.ts \
  --workers=3 --output=test-results/p9-qa

# new Phase 9 unit and integration tests
npx vitest run tests/unit/p9

# whole suites
CLAVIS_EXTENSION_DIR=.output-p9-verify/chrome-mv3 npx playwright test --workers=3 --output=test-results/p9-qa-full
npx vitest run
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.node.json
npx eslint <files>  &&  npx prettier --check <files>

# the minimum-Chrome smoke on a pinned Chrome for Testing 147 binary (needs a person or CI to provide it)
CLAVIS_CHROME_PATH=/path/to/chrome-147/chrome CLAVIS_EXTENSION_DIR=.output/chrome-mv3 \
  npx playwright test tests/e2e/p9-min-chrome-smoke.spec.ts --output=test-results/p9-min-chrome
```

## 3. Results

### 3.1 Summary

| Suite | Result |
| --- | --- |
| New Phase 9 E2E (11 files, 97 tests) | **All pass, twice in a row** (`--repeat-each=2`: 194 of 194, 2.9 min, 3 workers, machine load 10 to 21). Four of the 97 are the expected failures of the four defects (`test.fail`); each was also run 10 to 15 times in a row (45 of 45 deterministic) |
| New Phase 9 unit and integration tests (7 files, 75 tests) | **All pass** (`npx vitest run tests/unit/p9`) |
| Whole Playwright suite on the final build (`--workers=3`, 17.3 min) | 1,005 tests in 97 files: **956 passed, 2 failed, 37 skipped, 10 did not run**. Both failures were classified and re-run (3.2); the 37 skips are opt-in or build-specific (3.3); the 10 "did not run" are the later tests of the two serial files that contained the failures, and all pass on re-run (13 tests, one expected failure for P3) |
| Real Chrome UI (opt-in, `CLAVIS_E2E_REAL_UI=1`, `xvfb-run`, one worker) | **24 of 24 pass** on the final build: `p4-matrix-realui` 2, `p8-accept-realui` 10 (journeys 1 to 3: Chrome's real permission prompt, context menu, toolbar icon, popup, Alt+Shift+E, keyboard-only path, real side panel, a real PDF tab), `p8-sidepanel-realui` 2, `spike-b-real-ui` 9 (Allow, Deny, revoke, Chrome's Site access switch, cross-origin iframe limit), `p9fix-i6-activetab-navigation` 1 |
| Whole unit suite (`npx vitest run`) | **116 files, 2,081 tests, all pass** (18 s) |
| Typecheck (`tsc --noEmit` and `-p tsconfig.node.json`), ESLint (whole repo), Prettier (whole repo) | **Clean** |

### 3.2 The two failures of the full run (not product defects)

- `p5-card-flow` "core answer, then Roots costs exactly one more request, and reopening it costs none": `no [data-clavis="card-tab"][data-tab="core"]` at the second burst of back-to-back tab clicks (the card re-renders between two clicks with no wait in the test). **Flaky under load**: 1 failure in 22 runs at load average 15 to 19 (the full run), passed in all 15 other runs (the whole file, the test alone, 12 repeats with `--workers=4`, the targeted re-run). Not touched (an earlier phase's spec).
- `p8-accept-placeholders` "the ZIP exists and holds the same files as the build": **environment prerequisite**, the spec needs `wxt zip` with the same `WXT_OUT_DIR` (it reads the ZIP next to the build). After `WXT_OUT_DIR=.output-p9-verify npx wxt zip` all of its tests pass (the 4 it covers: same file set, no developer wording, every page loads only files in the ZIP, every link resolves; the privacy-policy test stays the expected failure P3).

### 3.3 Skipped by design (37 of the full run)

24 real-UI tests (opt-in, run separately above), 10 in `p8-sidepanel-spike` (a gesture spike that needs its own scratch extension), 3 in `p8-explain-features` (needs the forced-flags build `CLAVIS_FORCE_FEATURES=1`, which the release audit forbids shipping). No test was skipped or weakened to get a green run.

### 3.4 What each new E2E file contains

| File | Tests | Covers |
| --- | ---: | --- |
| `p9-groq-failures.spec.ts` | 29 | 10 HTTP statuses on the card, 429 variants, 11 unreadable answers, bounded rendering, envelope check for 11 statuses, the per-tab throttle, 30 s deadline, service worker termination, cancellation by Close and by key removal |
| `p9-reselection.spec.ts` | 9 | stale Roots answer, same word again, selection cleared while loading, new selection over a shown answer, navigation, tab close, toolbar persistence, hostile mousedown handler, **Q1** |
| `p9-declined-access.spec.ts` | 7 | declined profile: nothing registered; context menu -> card; reload; popup route; no selection; first-send question; no key |
| `p9-request-ledger.spec.ts` | 4 | the one-session ledger (highlight, Explain, tabs, side panel, reload, reader, practice page: 7 paid requests for 7 actions), key check counts, double-click on Explain, ledger positive control |
| `p9-fuzz-selection.spec.ts` | 26 | baseline, structure-probe self-check, 19 hostile selections, 3 hostile contexts, final sweep, **Q2** |
| `p9-secret-boundary.spec.ts` | 11 | real wizard key, web page success + 16 failure forms + panel, reader, storage widening, route probe, main-world sniffer, key removal and session key, restart, persistence of the access level (+ control), sweep control |
| `p9-onboarding-access.spec.ts` | 2 | access-already-granted step, **Q3** |
| `p9-pdf-flow.spec.ts` | 3 | 100-page route with Listen and Explain, no voice, bad/good file sequence |
| `p9-journey.spec.ts` | 1 | new profile: setup, highlight, Listen, Explain, second tab, dismiss |
| `p9-frames-and-history.spec.ts` | 4 | iframes (same and cross origin), single-page route change (**Q4** and recovery), Back |
| `p9-min-chrome-smoke.spec.ts` | 1 | web APIs, storage denial, toolbar, Explain, reader, on the browser named by `CLAVIS_CHROME_PATH` |

Unit and integration (`tests/unit/p9/`): `background-integration` 31, `fuzz-text-pipeline` 13, `route-sender-invariants` 10, `logging-static-scan` 8, `message-size-bounds` 7, `background-entry` 4, `session-interleavings` 2 (1,500 random runs).


## 4. Defects (triaged)

> **Dispositions (2026-10-23, before the Phase 9 commit):** Q1–Q4 are fixed and their `test.fail` wrappers removed (Q3: the access step records an already-granted choice and shows "Website access is on"; Q1: a tab's in-flight requests, incl. its side panel's, are aborted when the tab starts loading — this includes pushState route changes; Q4: the toolbar and card hide when the selected text leaves the DOM; Q2: surrogate-safe truncation in the card and toolbar). Copy: HTTP 413 maps to `SELECTION_TOO_LONG`; Clavis's own throttles say "Too many requests from Clavis" (`reason: 'local-limit'`). The default E2E suite is fully offline (`spike-a-groq` live tests need `CLAVIS_E2E_LIVE_GROQ=1`; a p4 control fetch is aborted). P3 stays open (Phase 10).

Severity follows the Phase 7 and 8 reports (Blocking: breaks a core flow or leaks; High; Medium: a real user is hurt but there is a workaround; Low: cosmetic or rare). **Blocking: none.** Each defect is a `test.fail` test that fails today and will turn red ("Expected to fail, but passed") when the defect is fixed: delete that one `test.fail` line.

### New in this phase

| ID | Sev. | Blocking? | Requirement | Summary | Reproduction | Test |
| --- | --- | --- | --- | --- | --- | --- |
| **Q3** | Medium | No (workaround exists) | UJ-01, FR-001, FR-009 | **The welcome wizard cannot be passed when website access is already granted.** The "Website access" step then shows neither "Enable on websites" nor "Not now", never records the choice (`onboarding.siteAccessChoice` stays `unset`), and `components/onboarding/steps.ts` enables Next only when the choice is not `unset`, so the only control left is Back. Reached by: switching "Site access" to "On all sites" on chrome://extensions before finishing setup; running the tutorial again after Clear all data (it clears Clavis's records, not Chrome's permission); or the grant arriving while the step is open. Phase 8 left this as "a risk to check by hand"; it is real. Workaround: close the tab and use Settings > Groq API key (the wizard gives no hint). Fix idea: when Chrome already reports access granted and the choice is `unset`, record `granted` and show Next. | A profile whose manifest lists the optional origins as granted (`startWorld({ granted: true })`), open the welcome page, press Next, "I understand", Next: the step has only Back. | `p9-onboarding-access.spec.ts` › `DEFECT Q3` (fails with `getByRole('button', { name: 'Next' })` not found). The stand-in profile used by every other journey test hits it, so `p9-support/onboarding.ts` bridges that one step. |
| **Q1** | Low | No | NFR "Support cancellation and stale-response prevention when the user ... navigates"; architecture section 6 "Selection changed: abort if possible"; section 8 case 7 | **A request in flight survives navigation of its tab.** The worker aborts a request only on `AI_CANCEL`, tab close, key change or a newer request of the same tab (`lib/router/register.ts` listens to `tabs.onRemoved` only). If the page navigates (link, reload, address bar), nothing tells the worker, the paid Groq call runs to completion (up to its 30 s deadline) and the answer goes to nobody. No data is exposed and the card never shows it (stale-answer prevention holds); the cost is at most one wasted request per navigation. Dismiss (Escape, Close) and tab close do cancel. | Open an article, press Explain with the Groq answer held, `page.goto` another page: the held request is not aborted and can still be fulfilled afterwards (checked with `requestfailed` / `requestfinished`). Fix idea: abort `inFlight` for a tab on `tabs.onUpdated` `status: 'loading'` (the hand-off already does this). | `p9-reselection.spec.ts` › `navigation › DEFECT Q1` |
| **Q4** | Low | No | FR-014 "Dismiss on ... selection removal"; architecture section 5 rule 8 | **The toolbar and card linger over a page that deleted the selected text.** When a single-page app replaces its content, Chrome fires no `selectionchange`, the observer (selectionchange, mouseup, keyup only) never learns the selection is gone, and the toolbar (or an open card) floats until the user presses Escape or clicks. `removeAllRanges()` and `collapse()` do dismiss it. Nothing stale is sent or shown wrongly (the card still describes what was selected). | Explain a word, then `history.pushState` and replace `main`'s children: the toolbar is still shown 5 s later. | `p9-frames-and-history.spec.ts` › `DEFECT Q4`; the companion test shows a click plus a new selection recovers (fresh request, no leftover). |
| **Q2** | Low (cosmetic) | No | NFR "preserve Unicode" | **The card header can cut an emoji in half.** It shows `state.text.slice(0, 200)` (`components/explanation/ExplanationCard.tsx`, `HEADER_TEXT_CHARS`); an astral character straddling the 200th UTF-16 unit leaves a lone surrogate, drawn as a replacement character. The request and the side panel carry the whole selection intact, and `truncateText` in the same module is surrogate-safe. | Select a paragraph of 199 letters then 👍: the header text ends in U+FFFD. | `p9-fuzz-selection.spec.ts` › `DEFECT Q2` |

### Earlier defects, status in this run

| ID | Sev. | What | Status |
| --- | --- | --- | --- |
| P3 (Phase 8) / I9 (Phase 9 audit) | Medium for release, known | Settings > Privacy policy link points at an unpublished placeholder (`omakidx.github.io/clavis/privacy/`, `lib/ui-client/links.ts`); FR-074 needs a public policy | **Open until Phase 10 (D-15).** Tracked by `p8-accept-placeholders.spec.ts` (`test.fail`). Blocks submission, not the candidate. |
| D1, D3, D4, D5 (Phase 7) | Medium, Low, Low, Low | Fit width after a window resize; zero-page PDF stuck on "Opening"; unreadable file shows the wrong message; Kangxi radicals from Chrome-printed CJK PDFs | **Fixed before the Phase 7 commit**: their `test.fail` lines are gone and the four regression tests (`p7-accept-open` "fit width FOLLOWS a window resize", `p7-accept-states` "ZERO pages" and "permissions removed", `p7-accept-actions` "Kangxi radicals") pass in this run. The header of [p7-reader-acceptance.md](p7-reader-acceptance.md) still says four are open: stale |

### Observations (no failing test; for the manager's judgement)

- **O-1 (copy, Info).** HTTP 413 maps to `NETWORK_ERROR`, whose text says "Clavis can't reach Groq. Check your internet connection". Groq answers 413 when a request exceeds a token-per-minute limit, so the advice misleads. The mapping is documented (architecture section 6: 5xx and others are "provider or network error") and tested (`p9-groq-failures` › `413`).
- **O-2 (copy, Info).** Clavis's own per-tab throttle (20 requests a minute, D-21) answers `RATE_LIMITED`, which the card words as "Groq's rate limit was reached". Behaviour verified (`p9-groq-failures` › `cost control`): refused before any request is sent, another tab unaffected.
- **O-3 (by design).** The card header shows the first 200 characters of the selection (CSS clamps it to two lines); the request and the side panel carry up to 2,000. See Q2 for the one wrinkle.
- **O-4 (UX, Info).** The card is a top-layer overlay near the selection and can cover the reader's own toolbar buttons (Playwright could not click "Next page" with a card open); the page box, keyboard shortcuts and Escape work. Not changed.
- **O-5 (test infrastructure, important for whoever writes restart tests).** After a browser restart, the first request of the restarted service worker can bypass Playwright's `context.route` and reach the real network (observed: a fake key answered by the real Groq with 401, which then marked the stored key invalid). Restart specs must start Chrome with `--host-resolver-rules` that leave only 127.0.0.1 resolvable and wait until the fake has seen a probe (`p9-support/restart.ts`: `primeWorkerRoutes`). Not a product issue.
- **O-6 (suite hygiene).** `spike-a-groq.spec.ts` (3 tests) talks to the real `api.groq.com`, so the full suite is not network-free.
- **O-7.** Pre-existing: Phase 8 observations O-3 and O-5 (Settings model select with no key; folded popup help) are unchanged and unaffected by this phase.

## 5. Phase 9 checklist: gap closure

"Automated verification" (execution-phases.md):

| Item | Status | Evidence |
| --- | --- | --- |
| Typecheck, lint and unit suite pass in CI | **Pass** | `tsc --noEmit` (both configs), `eslint`, `prettier --check` on every file added here; `vitest run` 116 files, 2,081 tests, all pass (section 3) |
| `chrome.runtime`/storage message integration tests and secret-boundary checks | **Closed (new)** | Unit/integration: `p9/background-integration.test.ts` (the real `registerBackground` over fake storage: key lifecycle, 12 provider statuses and 6 bad bodies against a hostile Groq, cancellation, key removal, restart, side-panel hand-off), `p9/route-sender-invariants.test.ts` (every route x every sender class against the policy), `p9/background-entry.test.ts`. E2E: `p9-secret-boundary.spec.ts` (11 tests: real onboarding typed key, success and ten failures across card, side panel and reader with a console/message/event/DOM/storage/network sweep, storage widening attempts, all routes from a content script, restart and persistence of the access level) |
| E2E: full setup -> grant site access -> highlight -> Listen -> Explain -> open tab -> dismiss | **Closed (new)**, plus existing | `p9-journey.spec.ts` (real wizard with typed key; stand-in for the permission prompt; scripted voice; request ledger). Existing: `p8-accept-journey.spec.ts` parts 1 and 2; with Chrome's real prompt, menu, icon, side panel: `p8-accept-realui.spec.ts` journeys 1 to 3 (xvfb, opt-in) |
| E2E: declined-access path: context menu -> Explain -> card | **Closed (new)** | `p9-declined-access.spec.ts` (7 tests: nothing registered; the real `onClicked` listener -> card with one request, in that tab only; reload; popup route; no selection; first-send question not answered for the user; no key). Native menu/icon/shortcut: `p8-accept-realui.spec.ts` journey 2, `p4-matrix-realui.spec.ts` |
| E2E: local PDF open -> page navigation -> select -> Listen -> Explain | **Closed (new)** | `p9-pdf-flow.spec.ts` (100-page file, page 88, "quokka": Listen speaks exactly that word, Explain labelled `pdf` page 88; page 89 and a second word; no voice; sequence of bad and good files) |
| Mock Groq 401/403/404/429/5xx, invalid JSON, huge answers, missing key, offline, worker cancellation | **Closed (new)** | `p9-groq-failures.spec.ts` (400, 401, 403, 404, 408, 413, 429 with, without and absurd `Retry-After`, 500, 502, 503; 11 kinds of unreadable answer incl. 3 MiB body and over-limit fields; fields at their limits in a 640 x 360 window; 30 s deadline; service worker terminated mid-request; cancellation by Close and by key removal; per-tab throttle). Missing key and offline: `p8-accept-states.spec.ts` (all three surfaces) and `p9-declined-access.spec.ts` |
| Regression: navigation/reselection stale answers, toolbar persistence | **Closed (new); 2 defects** | `p9-reselection.spec.ts` (Roots answer in flight when the word changes; same word after Escape; selection cleared while loading; navigation; closing the tab; Q1), `p9-frames-and-history.spec.ts` (iframes same- and cross-origin, single-page route change, Back; Q4), `p9/session-interleavings.test.ts` (1,500 random interleavings of the real `ExplainSession`) |
| PDF large-file/malformed/encrypted/scan-only and voice-absent fixtures | **Pass** (existing, plus a combined sequence) | `p7-accept-states.spec.ts` (32 generated fixtures incl. 5,001 pages, 100 MiB + 1, AES-128/256, scans, bombs), `p9-pdf-flow.spec.ts` (voice absent via scripted empty `chrome.tts`; sequence not-a-PDF, noise, empty, good, encrypted, scan-only, 5,001 pages, good) |
| Automated accessibility audits; manual keyboard and screen-reader spot checks | **Pass (automated); manual = Gap** | axe (WCAG 2.x A/AA and best practice) on the toolbar in 11 states x 2 schemes (`p4-toolbar-a11y`), the card in 17 states x 2 schemes (`p5-card-a11y`), every reader state (`p7-accept-a11y`), every extension page and the side panel at 3 widths (`p8-accept-a11y`, `p8-polish-axe`). Keyboard-only paths: `p8-accept-realui` journey 1d. Screen readers (NVDA, VoiceOver, Orca): **human**, section 7 |

"Security, privacy and performance":

| Item | Status | Evidence |
| --- | --- | --- |
| Capture network traffic: zero selection-only AI requests | **Closed (new)** | `p9-request-ledger.spec.ts` (one session: double-click, drag, triple-click, keyboard, Ctrl+A, scroll, Escape, Listen on a web page, the reader and the practice page: zero requests to any host); earlier: `p4-matrix-access` FR-017, `p4-matrix-security` |
| Inspect content-script messages/DOM/storage: the key never leaves trusted contexts | **Closed (new)** | `p9-secret-boundary.spec.ts` (see above; also: the content script may send only 9 public message types; `storage.onChanged` delivers nothing for local/session; `sync` holds nothing; the page's main world sees no message or storage event) |
| Fuzz selected text: HTML, jailbreak text, URLs, Unicode: no code execution | **Closed (new)** | `p9-fuzz-selection.spec.ts` (19 hostile selections + 3 hostile contexts through toolbar -> Explain -> card -> side panel with the model echoing the payload: nothing executes, no element or attribute not in a benign card, text preserved, payload only inside one nonce-tagged block; 1 defect Q2), `p9/fuzz-text-pipeline.test.ts` (seeded generators, 1,500 inputs per invariant) |
| PDF worker and scripts bundled, no remote executable code | **Pass** | Runtime: `p7-accept-open` (offline, only `chrome-extension://` requests, worker canary), `p9-pdf-flow` (ledger: no foreign host); static: `p9/logging-static-scan.test.ts` (no eval, `new Function`, string timers, HTML sinks, `fetch` outside `lib/ai/groq.ts`, unlisted URL literals); ZIP audit and `selftest`: see p9-performance.md and `npm run ci` |
| Audit minimum manifest permissions and dashboard justifications | **Covered elsewhere** | [phase-9-security-review.md](phase-9-security-review.md), [store/permission-justifications.md](../store/permission-justifications.md); `scripts/expected-permissions.json` + `audit-zip --strict`; `p8-accept-flags` (manifest) |
| Per-site disable, granting access later, revoking (registration removed) | **Pass** (existing) | `p3-background-site-access.spec.ts`, `p4-matrix-access.spec.ts` (FR-015 disabled host, revoke and re-grant through Chrome's Site access switch), `p8-accept-realui` journey 1 and 2 |
| `web_accessible_resources` expose nothing | **Pass** (existing) | `p8-accept-flags` (manifest), `p7-reader-security`, `p5-card-security` L1; Phase 9 audit "no `web_accessible_resources`" |
| Memory budget for the reader, no unbounded canvases | **Covered elsewhere** | [p9-performance.md](p9-performance.md); `p7-accept-find` FR-059 (at most 14 canvases) |
| First and repeat toolbar p95; AI latency tracking | **Covered elsewhere** | [p9-performance.md](p9-performance.md), `p9-perf-toolbar.spec.ts`; earlier `p4-toolbar-latency`, `p4-matrix-perf` |
| Count Groq requests per session: one per Explain, one per newly opened tab, zero on reopen | **Closed (new)** | `p9-request-ledger.spec.ts` (7 paid requests for 7 deliberate actions across web page, side panel, reload, reader and practice page; a double-click on Explain is one request; saving a key is one `/models` call and Test connection one more); `p9-groq-failures` (no automatic retry for any failure) |
| Inspect the ZIP for secrets, debug keys, `.env`, localhost URLs, source maps | **Covered elsewhere** | [p9-performance.md](p9-performance.md) section "package inspection"; `p8-accept-placeholders` (ZIP unpacked, same files as the build); `p9/logging-static-scan.test.ts` (URL literals in extension code) |
| Recheck Chrome/Groq/PDF.js advisories | **Covered elsewhere** | `npm audit` 0 vulnerabilities ([phase-9-security-review.md](phase-9-security-review.md)); Chrome and Groq advisories at release time: **human** |
| Minimum-Chrome (147) smoke incl. the content-script storage-denial check (Phase 1 follow-up) | **Spec written; needs a pinned binary** | `p9-min-chrome-smoke.spec.ts` runs on whatever `CLAVIS_CHROME_PATH` names (Playwright's Chromium otherwise; passes there). Running it on a Chrome for Testing 147 build requires downloading one: not done here, see section 7 |
| Storage access level persists across a browser restart (Phase 3 and 9 audit open item) | **Closed (new)** | `p9-secret-boundary.spec.ts`: after a restart, with the worker's code replaced by an empty script so nothing can re-apply the lockdown, a content script is still denied `local` and `session`; a control proves the same read succeeds when no lockdown was ever applied |

## 6. Traceability matrix

Status: **Pass** (verified by at least one observing test), **Gap** (not verifiable by an automated test, reason given), **N/A** (Could, Later or Won't for v1, or flagged off; the absence is itself tested where noted). `E:` is `tests/e2e/<file>` ("p5-card-states" means `p5-card-states.spec.ts`); `U:` is `tests/unit/<dir>/<file>`; titles are shortened. New Phase 9 tests are marked **(P9)**. The older acceptance reports with the same mapping in more detail: [p4-acceptance-matrix.md](p4-acceptance-matrix.md) (FR-010 to FR-018), [p7-reader-acceptance.md](p7-reader-acceptance.md) (FR-050 to FR-059), [p8-acceptance.md](p8-acceptance.md) (integration, FR-019, FR-030 to FR-043 as a whole).

### 6.1 Installation, onboarding and settings (FR-001 to FR-009)

| ID | Pri. | Status | Evidence |
| --- | --- | --- | --- |
| FR-001 | Must | Pass | U: `p9/background-entry.test.ts` **(P9)** (install opens `/onboarding.html` once; `update`, `chrome_update`, `shared_module_update` and startup never do; the listener is the real entry point). E: `p8-accept-journey` "install opens the welcome page once; a new user finishes setup using only the screens", `p3-ui-onboarding` "acknowledgement and the declined access choice persist across a reload". A real Chrome cannot show "no second page on update" (`--load-extension` always installs): unit only |
| FR-002 | Must | Pass | E: `p5-card-states` "key but no acknowledgement: the approved copy shows, nothing is sent", `p8-explain-direct` "before the first send was confirmed", `p9-declined-access` "first use after skipped setup" **(P9)**, `p3-ui-onboarding` "renders every step with ... the approved disclosure copy". U: `i18n/messages` "keeps the approved disclosure copy verbatim (D-16)", `router/ai-modes` "first-send disclosure acknowledgement" (11), `p9/background-integration` "first Explain without an acknowledged disclosure sends nothing; only a content script can acknowledge it" **(P9)** |
| FR-003 | Must | Pass | U: `onboarding/wizard` "links to the Groq keys page in a new tab and explains how to paste the key", `ui-client` links; E: `p8-accept-placeholders` "every link on it resolves" |
| FR-004 | Must | Pass | E: `p3-background-key` "TEST_API_KEY re-checks; 401 flips it to invalid", `p3-ui-onboarding` "a fake key is shown as rejected (401) or not verified (offline), and never rendered", `p9-request-ledger` "saving a key makes exactly one models request" **(P9)**. U: `router/key-lifecycle`, `settings/api-key-section` "Test connection reports working, rejected and unreachable keys differently" |
| FR-005 | Must | Pass | U: `router/key-lifecycle` `toModelInfos (FR-005)`, `router/ai` "stays ready and reports the preferred model, even if it left the model list", `settings/model-section`; E: `p5-card-states` / `p8-accept-states` "model unavailable (404): Choose another model", `p9-groq-failures` 400/404 **(P9)** (never switches silently) |
| FR-006 | Must | Pass | E: `p3-ui-settings` "preferences save at once, persist across a reload, and reset to defaults", `p3-background-settings` "start as defaults, persist across a worker restart, and reset"; U: `router/settings` `UPDATE_PREFERENCES (FR-006)`, `onboarding/wizard` "preferences step" |
| FR-007 | Must | Pass | E: `p3-background-key` (persistent / session-only / switching never both / REMOVE clears both), `p3-ui-settings` "connect, show only the last four, then remove the key after confirmation", `p9-secret-boundary` "removing the key leaves nothing of it in any storage area" **(P9)**; U: `p9/background-integration` "removing the key empties both areas and the very next Explain asks to set up" **(P9)** |
| FR-008 | Should | Pass | U: `settings/privacy-and-help` `help section (FR-008)` (tutorial, practice page, reader links); E: `p3-ui-practice` (practice page selection, Listen, keyboard path), `p5-card-practice`, `p8-polish-help` |
| FR-009 | Must | Pass (+ defect Q3) | E: `spike-b-declined` (no install-time all-sites warning; grant button pending state; Not now), `p4-matrix-access` (registered on grant, revoke and re-grant), `p3-background-site-access` (automatic, per-site disable, on-demand, open tabs); real prompt: `p8-accept-realui` journey 1 "Allow registers the observer, also in tabs that were open"; U: `onboarding/wizard` "asks Chrome for permission synchronously inside the click", `settings/site-access-section`. **Q3**: the wizard dead-ends when access is already granted (`p9-onboarding-access`) |

### 6.2 Selection, toolbar and accessibility (FR-010 to FR-019)

| ID | Pri. | Status | Evidence |
| --- | --- | --- | --- |
| FR-010 | Must | Pass | E: `p4-matrix-detection` (235 attempts over 26 fixtures, mouse and keyboard, 100 % detection), `p4-matrix-fr` "FR-010 ..." (mouse, keyboard, Ctrl+A, fields skipped, non-HTTP not eligible); frames: `p9-frames-and-history` "Explain inside a same-origin and a cross-origin iframe" **(P9)** |
| FR-011 | Must | Pass | E: `p4-matrix-fr` "FR-011 word / phrase / sentence / passage classification and normalisation"; U: `selection/classify`, `selection/text`, `p9/fuzz-text-pipeline` "normalizeText ... idempotent ... never changes any other character" **(P9)** |
| FR-012 | Must | Pass | E: `p4-matrix-fr` "FR-012 placement" (8 layouts, RTL, corners, scroll, 320 px, 200 %/400 % zoom, pinch, dialog, iframes), `p4-toolbar-coverage` (zoom, vertical writing, fixed headers); U: `tooltip/position` (26). Defect D-1 (vertical writing) fixed in Phase 4 |
| FR-013 | Must | Pass | E: `p4-matrix-fr` "FR-013 Listen, Slow and Explain, by mouse and by keyboard" |
| FR-014 | Must | Pass (+ defect Q4) | E: `p4-matrix-fr` "FR-014 dismissal, and persistence while the toolbar is used" (Escape, click outside, selection removal by click and by script, no flicker, page that clears the selection on press), `p9-reselection` "toolbar persistence and dismissal while an explanation exists" **(P9)** (card pressed, scroll, Escape drops the cache, hostile mousedown handler). **Q4**: removal of the text by the page itself is not noticed |
| FR-015 | Must | Pass | E: `p4-matrix-access` "FR-015 restricted and unsupported pages get no injection", "respect disabled sites", "tooltip behaviour: automatic or on-demand"; `p3-background-site-access` (Web Store excluded, disabled sites in iframes) |
| FR-016 | Must | Pass (automated) / Gap (screen reader) | axe on every state (see section 5), `p4-toolbar-a11y` "structure and targets" (roles, names, 24 px targets, 200 % zoom, reduced motion, forced colors, focus ring), `p5-card-keyboard`, `p8-accept-realui` journey 1d. No real screen reader: section 7 |
| FR-017 | Must | Pass | E: `p9-request-ledger` "one session: highlight sends nothing to any host" **(P9)** (every kind of highlight, Listen, reader, practice page: zero requests to any host, all sources), `p4-matrix-access` "FR-017 ... selecting, growing, scrolling, dismissing and re-selecting", `p4-matrix-security`, `p4-toolbar-limit` "trimming sends nothing" |
| FR-018 | Must | Pass | E: **(P9)** `p9-declined-access` (real `onClicked` listener -> card, one request, that tab only; popup route; no selection; first-send question; no key), `p8-explain-direct`, `p4-matrix-access` "site access declined", `p3-background-frame-notice`; native menu, icon, shortcut: `p4-matrix-realui`, `p8-accept-realui` journey 2 |
| FR-019 | Should | Pass | E: `p5-card-flow` "... Copy copies the visible tab", `p5-card-security` L2 (copy never exposes text to the page), `p8-accept-realui` (Copy by key announces "Copied"); U: `explanation/copy` |

### 6.3 Pronunciation (FR-020 to FR-026)

| ID | Pri. | Status | Evidence |
| --- | --- | --- | --- |
| FR-020 | Must | Pass (scripted voice) / Gap (audible) | E: `p6-listen-voices` "idle -> playing (Stop) -> Replay ... with only the selected text spoken", `p9-journey` and `p9-pdf-flow` **(P9)** (the scripted `chrome.tts.speak` receives exactly the word's characters; no request). Audible output and real voices: section 7 |
| FR-021 | Must | Pass (scripted) | E: `p6-listen-voices`, `p7-accept-actions` "a PDF word and a PDF sentence play, Stop, Slow and Replay ... one `speak` call of the right length"; U: `speech/service` (61), `selection/listen` (27) |
| FR-022 | Must | Pass | E: `p6-listen-voices` (Stop, Slow = 0.75, Replay, a new selection stops the previous utterance), `p6-speech-events` (a second request supersedes the first; Stop wins while starting) |
| FR-023 | Must | Pass | E: `p6-listen-webpage` "no-voice message with the Linux hint, never a playing state", `p6-speech-no-voice` (word and sentence, every sender), `p9-pdf-flow` "with no voice on the device ..." **(P9)** (deterministic, via a scripted empty voice list) |
| FR-024 | Must | Pass | E: `p6-speech-events` "no voice for the language: NO_VOICE ..., never another language", "Listen uses on-device voices only (D-22)"; U: `speech/voice-selection`, `speech/service` "voice choice ... (FR-024, FR-025)" |
| FR-025 | Should | Pass | E: `p6-listen-settings` "lists voices on-device and online, saves the choice, and Test voice speaks with that voice", "no voices ... disables what cannot work"; U: `settings/voice-section` (27) |
| FR-026 | Could | N/A | Not in v1 (IPA, recorded audio); the UI shows none (`p8-accept-controls` sweep) |

### 6.4 AI explanation and provider behaviour (FR-030 to FR-043)

| ID | Pri. | Status | Evidence |
| --- | --- | --- | --- |
| FR-030 | Must | Pass (mechanics) / Gap (live quality) | E: `p5-ai-explain` "every Must mode returns a validated result with exactly one Groq request each", `p9-request-ledger` **(P9)** (exactly one paid request per Explain across 5 surfaces). Answer quality on real fixtures (polysemous `bank`, idioms): the live evaluation of Phase 5 ([p5-prompt-eval.md](p5-prompt-eval.md): 100 % schema validity, D-09); a live run is **not repeatable here** (needs a key), section 7 |
| FR-031, FR-032 | Must | Pass (mechanics) / Gap (live quality) | E: `p5-card-flow` "core answer", `p8-explain-ux`; U: `explanation/model` "result blocks and their plain text" (two examples marked as AI-written). Quality: live evaluation as above |
| FR-033 | Must | Pass | E: `p5-card-flow` "core answer, then Roots costs exactly one more request, and reopening it costs none", `p9-reselection` "a Roots answer still in flight when another word is selected" **(P9)**; U: `explanation/model` "roots mark uncertainty" |
| FR-034 | Must | Pass | E: `p8-accept-scopes` (tab sets by kind), `p8-sidepanel-flow` "Load related words"; U: `explanation/model` "related words say Not applicable for an empty list" |
| FR-035 | Must | Pass | E: `p5-card-flow` "a sentence gets Core and Simplify only; Simplify is requested on first open", `p8-accept-scopes` (phrase: Core, Roots, Related, Simplify). Spec drift O-2 of Phase 8 was fixed in the docs |
| FR-036, FR-037 | Should | N/A (flagged off, `FEATURES` false) | Absence tested: `p8-accept-flags` "the build has the flags off", "no tab set ... ever offers Grammar or Translate", "a request for a Grammar or Translate answer is refused by the service worker"; built behaviour with flags forced: `p8-explain-features`, `p5-card-a11y` (flags forced on), U: `explanation/card` "Grammar and Translate tabs with their flags forced on". Release gate for turning them on: a live evaluation (section 7) |
| FR-038 | Must | Pass | E: `p9-request-ledger` **(P9)** (request counts after every user action; reopening a loaded tab and pressing Explain again send nothing; a double-click is one request), `p5-card-flow` "Explain again on the same selection re-shows the card without another request", `p8-sidepanel-flow` "opening it sends nothing"; U: `explanation/session` "lazy tabs and cache", `p9/session-interleavings` **(P9)** (never a request for an already-answered tab, in 1,500 random interleavings) |
| FR-039 | Must | Pass | E: `p9-groq-failures` **(P9)** (the full table of statuses and bad answers with wording and action per state; the 30 s deadline; no infinite spinner), `p5-card-states`, `p8-accept-states` (same text and behaviour on webpage, practice page and reader) |
| FR-040 | Must | Pass | U: `ai/groq-modes` "capability cache" (json_schema -> json_object fallback once, remembered), `ai/groq` "400 handling"; E: `p5-ai-explain` "capability cache: a model that rejects json_schema falls back once, survives a worker restart, and is re-probed after a model change" |
| FR-041 | Must | Pass | E: `p9-fuzz-selection` **(P9)** (19 + 3 hostile inputs: markup/script/svg/iframe/form/meta/entities/markdown/URLs/template syntax echoed by the model: no execution, no new element or attribute, no request, text preserved), `p7-accept-security`, `p7-reader-security`, `p8-accept-text`; U: `explanation/card` "renders model text as plain text", `contracts/explain` "accepts HTML and Markdown in model output as literal plain text", `p9/logging-static-scan` (no HTML sink in extension code) |
| FR-042 | Should | Pass | E: `p8-sidepanel-flow` (per-tab panel, hand-off, no request on open, SPA/navigation empties it, a web page cannot open or frame it), `p8-sidepanel-hosts`, `p8-sidepanel-realui` (real panel), `p9-fuzz-selection` (panel text and structure under hostile text), `p9-secret-boundary` (panel DOM scan) |
| FR-043 | Later (D-24) | N/A | Absence tested: `p8-accept-flags` "FR-043 is absent: explaining the same text again asks Groq again, and nothing about it is stored"; `p8-accept-journey` 1c (nothing in storage, IndexedDB or caches) |

### 6.5 PDF reader (FR-050 to FR-060)

Full per-fixture evidence in [p7-reader-acceptance.md](p7-reader-acceptance.md); summary and the new combined tests:

| ID | Pri. | Status | Evidence |
| --- | --- | --- | --- |
| FR-050 | Must | Pass | E: `p7-accept-open` "FR-050 open a local PDF" (file chooser, drop, offline, no web request, Close PDF releases pages and the worker), `p9-pdf-flow` **(P9)** (chooser, ledger: nothing foreign) |
| FR-051 | Must | Pass | E: `p7-accept-render` (embedded TrueType/Type1C/CJK/Type3, JPEG 2000 and JBIG2 under the D-17 CSP, 100/150/175 %/fit width) |
| FR-052 | Must | Pass | E: `p7-accept-render` (text layer vs canvas ink, real-mouse drag selects the authored line, 4 rotations). Open Arabic-shaping limit O6 (browser selection of mixed-direction glyph spans), documented |
| FR-053 | Must | Pass | E: `p7-accept-actions`, `p8-accept-states` / `p8-accept-scopes` (identical wording, buttons, behaviour and styles on web page, practice page, reader), `p9-pdf-flow` **(P9)** (Listen + Explain on page 88 and 89; snapshot `source: 'pdf'` with page; no stale answer after page navigation) |
| FR-054 | Must | Pass (+ defect D1) | E: `p7-accept-open` "FR-054 pages, zoom, page count, fit width", `p9-pdf-flow` (typed page number on a 100-page file) |
| FR-055 | Must | Pass (+ D3, D4) | E: `p7-accept-states` (password AES-128/256, corrupt, zero-byte, not-a-PDF, truncated, image-only, limits 5,000/5,001 pages and 100 MiB), `p9-pdf-flow` "one reader tab through a sequence of bad and good files" **(P9)** (each failure is specific and recoverable, the next good file behaves normally, no console error, password nowhere) |
| FR-056 | Must | Pass | E: `p7-accept-open` "FR-056 the reader launches only when the user chooses it" (no redirect, no `webRequest`/`file:///*` in the manifest), `p8-accept-realui` journey 3 |
| FR-057 | Should | Pass | E: `p7-accept-find` "FR-057 find in document" (14) |
| FR-058, FR-060 | Later, Won't | N/A | Absence tested: `p7-accept-open` "FR-058 and FR-060 are not presented in v1" |
| FR-059 | Must | Pass | E: `p7-accept-find` "FR-059 virtualised pages" (at most 14 canvases, bounded heap, responsive), numbers and the 800-page walk in [p9-performance.md](p9-performance.md) |

### 6.6 Data, reliability and publishing (FR-070 to FR-079)

| ID | Pri. | Status | Evidence |
| --- | --- | --- | --- |
| FR-070 | Must | Pass | E: `p9-secret-boundary` **(P9)**, `p3-background-boundary` (content script cannot read storage; refused on every privileged route), `p3-background-key`; U: `p9/route-sender-invariants` **(P9)**, `p9/background-integration` **(P9)**, `router/router` "sender matrix", `security/storage-lockdown` |
| FR-071 | Must | Pass | E: `p3-ui-settings` "a session-only key is reported as such"; U: `i18n/messages` "never claims the key is encrypted or in a vault", `settings/api-key-section`, `p9/background-integration` "a session-only key never touches storage.local" **(P9)** |
| FR-072 | Must | Pass | E: `p9-groq-failures` **(P9)** (401 and 403: Update key, settings kept; 429: countdown, honoured, clamped, HTTP-date), `p8-accept-states`; U: `router/ai` "a 401 from Groq flips the key to invalid and keeps every setting (FR-072)", `p9/background-integration` "... settings kept" for 12 statuses **(P9)**, `ai/groq` `parseRetryAfter` |
| FR-073 | Must | Pass | E: `p5-ai-explain` "provider failures ... log metadata only", `p9-secret-boundary` **(P9)** (every console line of every page and worker contains no key or selection); U: `p9/logging-static-scan` **(P9)** (every `console.*` is the redacting logger or a constant plus an error name; only five metadata fields can be logged), `security/logger`, `ai/groq` "logs metadata only", `pdf/password` "never logs the password" |
| FR-074 | Must | **Gap (Phase 10)** | Policy drafted and aligned with the code ([privacy-policy.md](../privacy-policy.md), [phase-9-security-review.md](phase-9-security-review.md)); the link in Settings is a placeholder until it is published (D-15): `p8-accept-placeholders` (`test.fail`, defect P3) |
| FR-075 | Must | Pass | `p9/logging-static-scan` **(P9)** (no eval, no `new Function`, no remote import, no script element), ZIP audit `audit-zip --strict` and `selftest` ([p9-performance.md](p9-performance.md)), `p7-accept-security` "the page loads only extension scripts and styles", `smoke` |
| FR-076 | Must | Pass | `scripts/expected-permissions.json` + `audit-zip`; `p8-accept-flags` (manifest); `p9/route-sender-invariants` (the routes that use each permission are reachable only by the right senders); [phase-9-security-review.md](phase-9-security-review.md) |
| FR-077 | Must | Pass (build) / Gap (unpacked ZIP on clean Chrome) | Every spec here runs against the production build. `p8-accept-placeholders` unpacks the `wxt zip` output and shows its file set equals the build. A fresh-profile install of the ZIP itself and the manual Windows/macOS pass (D-14): section 7 |
| FR-078 | Should | Pass | E: `p3-ui-settings` "Clear all data removes the key, preferences and the site list", `p3-background-settings` "CLEAR_ALL_DATA leaves no Clavis record in either storage area", `p8-accept-journey` 1c ("Clear all data empties every panel"); U: `p9/background-integration` (clear aborts the in-flight request and forgets the hand-off) **(P9)** |
| FR-079 | Later | N/A | Not in v1 |

### 6.7 Nonfunctional requirements (section 5)

| Requirement | Status | Evidence |
| --- | --- | --- |
| User intent gates every AI request; no crawling, no hidden PDF upload | Pass | `p9-request-ledger` **(P9)**, `p4-matrix-security`, `p7-accept-open` (no request for any fixture), `p9-pdf-flow` |
| Key never in code or build artifacts; only the privileged context calls Groq | Pass | `p9-secret-boundary` **(P9)** (every request to Groq came from the service worker, key only in `Authorization`), `p9/background-integration` (url, body and other headers key-free), `p9/logging-static-scan` (`fetch` only in `lib/ai/groq.ts`), `scripts/scan-secrets.mjs` + gitleaks in `npm run ci` |
| No eval, remote JavaScript, unsafe HTML, analytics SDKs, broad dynamic host permissions | Pass | `p9/logging-static-scan` **(P9)**, `eslint.config.js` rules, `audit-zip --strict`, manifest tests (`p8-accept-flags`, `spike-b-declined`) |
| Inspect/sanitise page and Groq content before display; page text is untrusted model context | Pass | `p9-fuzz-selection`, `p9/fuzz-text-pipeline` **(P9)**; `p5-ai-explain` "a selection that tries to close its delimiter stays inside it on the wire", `p7-accept-security`; U: `ai/modes` "prompt injection cannot leave its delimiters, in any mode". Live-model obedience of injections: Gap (live key), see [p5-prompt-eval.md](p5-prompt-eval.md) |
| Request ids, payload size limits, schema validation, sender checks | Pass | U: `contracts/*` (107), `router/router` "oversized messages", `echoes only a well-formed UUID`, `p9/message-size-bounds` **(P9)**, `p9/route-sender-invariants` **(P9)**, `p9/background-integration` **(P9)** |
| No persisted raw page/PDF excerpts | Pass | `p8-accept-journey` 1c, `p8-sidepanel-flow` "nothing in extension storage", `p8-accept-flags` "nothing about it is stored", `p9/background-integration` "side panel hand-off ... never stored, never logged" **(P9)** |
| Tooltip first paint from local interaction; API latency never stalls selection | Pass | `p4-toolbar-latency`, `p4-matrix-perf`, `p9-perf-toolbar` ([p9-performance.md](p9-performance.md)); `p9-groq-failures` (a held request does not block selection or another tab) |
| Always-loaded content script budget | Pass (CI) | `npm run size` (`scripts/size-budgets.json`, D-20) |
| Cancellation and stale-response prevention on selection change or navigation | Pass (+ defect Q1, Q4) | `p9-reselection`, `p9-frames-and-history`, `p9-groq-failures` "cancellation" **(P9)**; `p5-card-states` "cancellation and stale answers"; U: `explanation/session` "abort, supersede and stale responses", `p9/session-interleavings` **(P9)** |
| Retry only transient failures within bounded attempts; honour `Retry-After`; no auth retry loops | Pass (stricter than asked) | The product never retries by itself: `p9-groq-failures` (one request for every status and bad answer, however long we wait), `p5-ai-explain` "never retried automatically", `p9/background-integration` (12 statuses). `Retry-After` honoured: `p9-groq-failures` (3 forms) |
| Survive MV3 service worker suspension; no durable in-memory state | Pass | `p9-groq-failures` "the service worker is terminated mid-request" **(P9)**; `p3-background-key` / `p3-background-settings` (state survives a worker restart); `p9-secret-boundary` (restart); U: `p9/background-integration` "after a worker restart nothing is replayed" |
| Bounded PDF memory, explicit cleanup | Pass | `p7-accept-find` FR-059, `p7-accept-open` "Close PDF ...", [p9-performance.md](p9-performance.md) |
| Real-browser E2E with realistic PDFs (inaccessible, large, multi-column) | Pass | `p7-accept-*` (32 generated fixtures), `p9-pdf-flow` |
| Dependency lockfile, security updates, licence checks | Pass (advisories) / Gap (licences) | `npm audit` 0 vulnerabilities ([phase-9-security-review.md](phase-9-security-review.md)); third-party notices and PDF.js Apache-2.0 notice shipping: Phase 10 |
| Accessibility: labels, focus order, Escape, live announcements, 200 % zoom, reduced motion, high contrast, target size | Pass (automated) / Gap (manual) | see FR-016; `p4-toolbar-a11y`, `p5-card-a11y`, `p7-accept-a11y`, `p8-accept-a11y`, `p8-accept-text` (reduced motion). Screen readers: section 7 |
| Localisation: strings through `chrome.i18n`, Unicode and RTL preserved | Pass | U: `i18n/messages`, `i18n/unused-keys`; E: `p8-accept-text` (Arabic, Hebrew, Japanese, emoji, Devanagari round trip, RTL answers), `p9-fuzz-selection` (bidi controls, ZWJ, emoji, combining marks; except Q2), `p4-matrix-fr` (Unicode kept) |

### 6.8 Error catalogue (section 7)

| Condition | Status | Evidence |
| --- | --- | --- |
| Missing/invalid key: Connect Groq / Update key | Pass | `p8-accept-states` "no key" and "401" on all three surfaces, `p5-card-states`, `p9-declined-access` "no key" **(P9)**, `p9-groq-failures` 401 and 403 **(P9)** |
| Invalid/unavailable model: Choose another model | Pass | `p8-accept-states` "model unavailable (404)", `p9-groq-failures` 400, 404 **(P9)** (400 and 422 map here by design) |
| Groq 429: Rate limit reached, retry guidance, bounded | Pass | `p5-card-states` "429 with Retry-After", `p8-accept-states` "429 ... no request loop", `p9-groq-failures` "429 without a Retry-After header", "huge Retry-After is clamped" **(P9)** |
| Offline / timeout: You're offline / Can't connect, Retry | Pass | `p5-card-states` "offline", `p8-accept-states` (offline and "Can't connect"), `p9-groq-failures` "Groq never answers: ... 30 s deadline" and 408 **(P9)** |
| Bad/unsafe model JSON: Couldn't format explanation | Pass | `p9-groq-failures` "unreadable answers" (11 kinds) **(P9)**, `p5-card-states`, `p8-accept-states`; U: `p9/background-integration` (6 bad bodies, no echo) |
| TTS no voice: Voice not available on this device | Pass | `p6-listen-webpage`, `p6-speech-no-voice`, `p9-pdf-flow` **(P9)** |
| TTS ended/error: stop spinner, enable Replay | Pass | `p6-speech-events` "an engine error after the start is reported as error", `p6-listen-voices` (Replay after end), `p4-toolbar-a11y` "Listen ended by an error" |
| PDF scanned only: This PDF appears image-only | Pass | `p7-accept-states` "FR-055 image-only and missing text", `p9-pdf-flow` sequence **(P9)** (no toolbar, nothing selectable). Known: O1 (`scan-then-text.pdf` shows the banner although page 6 has text), documented in Phase 7 |
| PDF password/encryption: prompt or limitation | Pass | `p7-accept-states` "FR-055 passwords", `p7-accept-states` "password text never reaches any request, storage or message", `p9-pdf-flow` **(P9)** (password not in any Groq body) |
| Selection over 2,000 characters: Selection too long / Use the first 2,000 characters | Pass | `p4-toolbar-limit` (7), `p4-matrix-fr` "selection constraints", `p7-accept-actions` "a selection over 2,000 characters ... trimming sends only the first 2,000" |
| Site access not granted: no automatic toolbar; menu and icon work; Settings offers it; never re-prompt without a gesture | Pass | `p9-declined-access` **(P9)**, `p4-matrix-access` "site access declined", `p8-accept-realui` journey 2; U: `onboarding/wizard` "asks Chrome for permission synchronously inside the click", `settings/site-access-section` |
| Unsupported page: This page doesn't allow the extension | Pass | `p4-matrix-access` "chrome:// pages ... never run the observer", "a restricted tab refuses the on-demand injection route cleanly", `spike-b-declined` popup "says so when the current tab is a page extensions cannot run on" |

### 6.9 Abuse cases (section 8)

| # | Case | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Malicious page tries to capture the key | Pass | `p3-background-boundary`, `p9-secret-boundary` **(P9)** (storage denied and cannot be widened, `onChanged` silent, the 14 privileged routes refused from a content script and the public ones answered with no key, DOM/console/message sweep, restart, persistence of the level), `p9/route-sender-invariants` **(P9)** |
| 2 | Prompt injection in selected text | Pass (mechanics) / Gap (live model) | `p9-fuzz-selection` **(P9)** (forged nonce tags, look-alike brackets, jailbreak text: one nonce-tagged block, no raw bracket, never in the system message), `p9/fuzz-text-pipeline` **(P9)** (600 random prompts), `p5-ai-explain`, `p7-accept-security`; U: `ai/modes` / `ai/prompts-schema`. Whether a real model obeys: `scripts/eval/explain-eval.ts` with a key, section 7 |
| 3 | Selected private data (editable fields, logging, persistence) | Pass | `p4-matrix-fr` "selection constraints: inputs, passwords, textareas and editable regions are skipped", `p9fix-context-editable` (Phase 9 audit M1), `p9/logging-static-scan` and `p9-secret-boundary` (no selection in any log), `p8-accept-flags`, `p8-sidepanel-flow` (not stored) |
| 4 | PDF with malicious links or scripts | Pass | `p7-accept-security` (21 fixtures: hostile text, javascript:/file:/data:/Launch/GoToR links, AcroForm JS, hostile names, CSP canary), `p7-reader-security`; U: `pdf/annotations`, `pdf/hostile`, `reader/links` |
| 5 | Service worker restarted mid-request | Pass | `p9-groq-failures` "the service worker is terminated mid-request" **(P9)** (real CDP termination: NO_RESPONSE message, Try again, no second request, late answer discarded, one new request after Try again); U: `p9/background-integration` "after a worker restart nothing is replayed" **(P9)**; U: `ui-client/request` (`AI_EXPLAIN` is never retried) |
| 6 | Model output looks like HTML/script/Markdown | Pass | `p9-fuzz-selection` (model echo of 19 payloads), `p9-groq-failures` (HTML error page as an answer), `p5-card-states`; U: `explanation/card` "renders model text as plain text", `contracts/explain` |
| 7 | Excessive token use | Pass (+ defect Q1) | `p9-request-ledger` **(P9)**, `p9-groq-failures` "cost control" **(P9)** (20 a minute per tab, refused before any request), 11 bad-answer kinds with one request each; U: `router/limiter`, `ai/modes` token budgets. **Q1**: one wasted request per navigation |
| 8 | Extension fingerprinting through `web_accessible_resources` | Pass | `p8-accept-flags` (no `web_accessible_resources`), `p5-card-security` L1 (no page-visible message carries the extension id), `p4-matrix-security` (host is a plain `div`), `p9-secret-boundary` (the page's main world sees no message, storage event or policy violation) |

### 6.10 Verification matrix (section 9) and journeys

| Dimension | Status | Evidence |
| --- | --- | --- |
| Web DOM fixtures | Pass | 26 fixtures + frames, shadow roots, dialog: `p4-matrix-detection` / `p4-toolbar-coverage` ([p4-acceptance-matrix.md](p4-acceptance-matrix.md)); iframes with Explain: `p9-frames-and-history` **(P9)** |
| Selection fixtures | Pass | `p4-matrix-detection` (word, phrase, sentence, passage, keyboard, double and triple click, nested inline, punctuation, collapsed) |
| Semantic fixtures (polysemous, idioms, technical term, no etymology, uncommon name, ambiguous sentence) | **Gap (live key)** | Prompts and mechanics: `ai/modes`, `p5-ai-explain`; quality by the live evaluation of Phase 5 ([p5-prompt-eval.md](p5-prompt-eval.md)); a live pass of these fixtures on the release build needs a key (section 7) |
| Site access (granted, declined via menu and icon, granted later, revoked) | Pass | `p3-background-site-access`, `p4-matrix-access`, `p9-declined-access` **(P9)**, `p8-accept-realui` |
| Speech (word, sentence, Stop/Replay, rapid repeat, en-US, en-GB, no voice, online-only, no accent promise) | Pass (scripted) / Gap (audible, Windows/macOS) | `p6-*`, `p9-journey`, `p9-pdf-flow`; voices on Windows and macOS: unverified by design (D-14), section 7 |
| PDF (local text, multi-page, multi-column, rotated, zoom, password, corrupt, scan-only, 100+ pages) | Pass | `p7-accept-*`, `p9-pdf-flow` |
| API (good key, bad key, missing model, 400, 401, 403, 404, 429, 500, offline, malformed, timeout, worker stop) | **Closed (new)** | `p9-groq-failures`, `p9/background-integration` |
| Security (key boundary, HTML injection, prompt injection, oversized messages, corrupt PDF, unexpected sender) | Pass | `p9-secret-boundary`, `p9-fuzz-selection`, `p9/route-sender-invariants`, `router/router` "rejects an oversized message before parsing it", `p9/message-size-bounds` **(P9)** (the worst legal Explain message made of 6-byte-per-character control characters is below the 32 KiB bound and answered; one character over any limit is refused before anything is sent), `p7-accept-states`, `p3-background-boundary` |
| Usability (keyboard-only, screen reader, reduced motion, 200 % zoom, narrow screen, error recovery) | Pass (automated) / Gap (screen reader) | see FR-016; error recovery: `p9-pdf-flow` sequence, `p9-groq-failures` Try again |
| UJ-01 first setup | Pass (+ defect Q3) | `p9-journey` **(P9)**, `p8-accept-journey` 1, `p8-accept-realui` 1 |
| UJ-02 / UJ-03 word and sentence on a web page | Pass | `p9-journey`, `p8-accept-scopes`, `p5-card-flow` |
| UJ-02b site access declined | Pass | `p9-declined-access` **(P9)**, `p8-accept-realui` 2 |
| UJ-04 local PDF | Pass | `p9-pdf-flow`, `p7-accept-*`, `p8-accept-realui` 3 |
| UJ-05 missing key / quota | Pass | `p8-accept-states`, `p9-groq-failures`, `p9-declined-access` |
| UJ-06 unsupported content | Pass | `p4-matrix-access`, `p7-accept-states` (image-only), `p8-accept-realui` 3 (native PDF viewer help) |

### 6.11 Decisions with testable behaviour

D-02 (optional access + `activeTab`): `spike-b-declined`, `p4-matrix-access`, `p9-declined-access`. D-05 (core + lazy tabs): `p5-card-flow`, `p9-request-ledger`. D-07 (`chrome.tts` only): `p6-speech-no-voice` "no offscreen document is ever created". D-08 (bundled toolbar, card on first Explain): `p5-card-flow` "nothing is sent and no card is loaded until Explain is pressed", `npm run size`. D-10 (plain text only): `p9-fuzz-selection`. D-16 (disclosure copy): `i18n/messages`, `p5-card-states`. D-17 (CSP): `p7-accept-render` (wasm decoders), `audit-zip`. D-18 (Chrome 147): `p9-min-chrome-smoke` (spec ready; pinned binary needed). D-20 (18 KB budget): `npm run size`. D-21 (20 a minute): `p9-groq-failures` "cost control". D-22 (on-device voices): `p6-speech-events`. D-24 (side panel, no cache): `p8-sidepanel-*`, `p8-accept-flags`. D-09 (model): live evaluation, [p5-prompt-eval.md](p5-prompt-eval.md).

## 7. Needs a human (or a pinned binary, a key, another OS)

1. **Screen reader spot checks** (NVDA, VoiceOver, Orca) of the toolbar, card, side panel, reader and Settings: roles, names, live-region announcements and focus are asserted (axe, ARIA tabs pattern, `role=status`), not heard.
2. **Voices on Windows and macOS** and an audible check on Linux with `speech-dispatcher` + `espeak-ng` (D-14, R-02): Listen is verified against a scripted `chrome.tts` and the honest no-voice path only. Before the listing is public, one manual pass of the release smoke test on Windows or macOS is a launch blocker (requirements section 9); the same spec files run on those CI runners without voices.
3. **A live Groq run** with a real key: (a) the semantic fixtures of section 9 on the release build, (b) the injection fixtures against the real model (`scripts/eval/explain-eval.ts`), (c) the evaluation of the Grammar and Translate prompts, which is the gate for flipping `FEATURES.grammarTab` / `translateTab`, (d) rate-limit behaviour on a real free-tier account. Mechanics are all tested; quality is not.
4. **Minimum Chrome 147** (D-14, D-18): download a Chrome for Testing 147 build and run `p9-min-chrome-smoke.spec.ts` with `CLAVIS_CHROME_PATH` (command in section 2). It checks the web APIs the bundle needs, the storage denial, the toolbar, one Explain and the reader on that browser. Not run here because it needs a downloaded binary.
5. **Real Chrome UI on the release build**: re-run the opt-in real-UI specs under xvfb (`p8-accept-realui`, `p4-matrix-realui`, `p8-sidepanel-realui`, `spike-b-real-ui`) once the version bump and the ZIP are final and a check that Chrome's password manager does not offer to save the key on Settings (Phase 3 gap; the field is `autocomplete="new-password"`, but a headless run cannot show the offer).
6. **Release housekeeping that is not code**: publish the privacy policy and set the real link (P3, D-15), a fresh-profile install of the final ZIP on Windows or macOS, store-dashboard data-use certifications, publisher name and email, third-party notices (PDF.js Apache-2.0), and a Chrome and Groq advisory check on the day of submission.

Not covered by any test and not claimed: touch selection handles and real browser zoom (only equivalent viewports and pinch zoom), ChromeOS, branded Chrome with `--load-extension` (137+ ignores it; use Chrome for Testing), a physical mouse and screen magnifiers, visual-regression screenshots.

## 8. Release-candidate verdict against the Phase 9 gate

| Gate clause | Verdict | Basis |
| --- | --- | --- |
| No blocking bugs | **Met** | Four new defects (Q1 Low, Q2 Low, Q3 Medium, Q4 Low) and the earlier open set (P3 for Phase 10): none breaks a core flow for a user who does not hit a narrow condition. Q3 is the only one a new user can meet in setup, with a workaround through Settings; fixing it before release is recommended |
| No security leaks | **Met** | The key was searched for in every message, reply, event, DOM (including closed shadow roots), web storage, console line and request of onboarding, Explain (success and 16 failure forms), the side panel, the reader and a restart, and found only in the `Authorization` header to `api.groq.com` and the one storage record. Storage access level persists across restarts. Selected text is quoted data and never markup (22 hostile inputs). Route x sender policy holds for all 23 routes. Combined with [phase-9-security-review.md](phase-9-security-review.md) (no Critical or High; M1 fixed) |
| No policy conflicts | **Met for code; open for publication** | Permissions and manifest unchanged and audited ([phase-9-security-review.md](phase-9-security-review.md)); no remote code, no eval, no foreign host in any run. The public privacy policy (FR-074, D-15) is not yet published: a Phase 10 submission blocker, not a code conflict |
| No broken core flows | **Met** | Setup (with Q3 bridged), highlight, Listen, Explain, lazy tabs, side panel, dismiss, declined access, local PDF (open, navigate, select, Listen, Explain) and every provider failure were driven end to end on the production build |

**Verdict: the release candidate passes the Phase 9 gate for all automatically verifiable criteria.** Before the listing is made public: the six items in section 7, the privacy-policy publication, and (recommended) the fix of Q3.

## 9. Maintenance notes

- Re-run after any change in `lib/router` (routes and sender rules: `p9/route-sender-invariants`), `lib/ai` (statuses and prompts: `p9-groq-failures`, `p9/background-integration`, `p9/fuzz-text-pipeline`), `lib/selection` or `components/explanation` (`p9-reselection`, `p9-frames-and-history`, `p9-fuzz-selection`), `components/onboarding` (`p9-onboarding-access`, `p9-journey`), `lib/pdf` / `components/reader` (`p9-pdf-flow`), or the background entry point (`p9/background-entry`).
- When a defect is fixed its `test.fail` test fails with "Expected to fail, but passed": delete that one `test.fail(` wrapper (Q1 `p9-reselection`, Q2 `p9-fuzz-selection`, Q3 `p9-onboarding-access`, Q4 `p9-frames-and-history`). After Q3 is fixed, `p9-support/onboarding.ts` can be replaced by the p8 `walkOnboarding` helper.
- A new route must be added to the policy in `p9/route-sender-invariants.test.ts` on purpose; a new `console.*` call or URL literal must be added to `p9/logging-static-scan.test.ts` on purpose.
- Fixtures added: `tests/fixtures/web/p9-fuzz.html` (three paragraphs whose text the fuzz specs set as plain text). Support code: `tests/e2e/p9-support/` (`ledger`, `card`, `secrets`, `restart`, `worker`, `pdf`, `onboarding`).

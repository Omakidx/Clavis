# Phase 8 acceptance: integrated UX and accessibility

**Date:** 2026-10-23 · **Build:** production, `WXT_OUT_DIR=.output-p8-accept npx wxt build` and `wxt zip` (the ZIP was unpacked and swept) · **Browser:** Chrome for Testing 156 (Playwright's Chromium), Linux, `xvfb-run` for the real-UI specs · **Groq:** answered by Playwright routes, fake `gsk_TEST` keys, no external network · **Profile:** a new profile per spec (no seeded key, onboarding state or preferences).

Independent of the implementers' specs (`p8-polish-*`, `p8-explain-*`, `p8-sidepanel-*`), which were read to avoid duplicating them. Suite: `tests/e2e/p8-accept-*.spec.ts` and `tests/e2e/p8-accept-support/`.

```text
WXT_OUT_DIR=.output-p8-accept npx wxt build && WXT_OUT_DIR=.output-p8-accept npx wxt zip
CLAVIS_EXTENSION_DIR=.output-p8-accept/chrome-mv3 npx playwright test tests/e2e/p8-accept- --workers=6
CLAVIS_E2E_REAL_UI=1 CLAVIS_EXTENSION_DIR=.output-p8-accept/chrome-mv3 \
  xvfb-run -a -s "-screen 0 1920x1080x24" npx playwright test tests/e2e/p8-accept-realui.spec.ts --workers=1
```

Use `--output=<dir>` when other agents also run Playwright: they all share `test-results/`, which Playwright empties at the start of a run (this broke two of my early runs with `ENOENT .playwright-artifacts`).

## Method

| Layer | What it does | Files |
| --- | --- | --- |
| Journeys, headless | Install, welcome wizard (typed key, every button found by its label), practice page, Listen, Explain, first-send question, card, side panel, Copy, two tabs, navigation, close, Clear all data | `p8-accept-journey.spec.ts` |
| Journeys, real browser UI | Chrome's real permission prompt (Allow), real context menu, real toolbar icon and popup, real `Alt+Shift+E`, the browser's own find bar to select without a mouse, the real side panel, a real PDF tab | `p8-accept-realui.spec.ts` (opt-in) |
| Scope and states | Tab sets by word, phrase, sentence, passage on a web page, the practice page and the reader; 401, 404, 429, offline, "Can't connect", bad answer and no-key states on all three surfaces, compared text, buttons, behaviour and computed styles | `p8-accept-scopes`, `p8-accept-states` |
| Accessibility | axe on the production card inside its closed shadow root (see below), computed text contrast, side panel and every extension page, light and dark, 1000, 360 and 320 px | `p8-accept-a11y`, `p8-accept-pages` |
| Text | Right-to-left page, selection and answer; Unicode round trip; reduced motion | `p8-accept-text` |
| Placeholder sweep | The ZIP is unpacked: file set equals the build, strings and pages free of developer wording, every page reference exists, every link on every screen resolves; every enabled control on 21 screens is pressed and must change something | `p8-accept-placeholders`, `p8-accept-controls` |
| Build content | Flags off, no forced-flags marker, side panel shipped, no cache or history, no Grammar or Translate anywhere | `p8-accept-flags` |
| Defects | `test.fail` tests, each also run without `test.fail` | `p8-accept-defects` (P3 is in `p8-accept-placeholders`) |

Two techniques are new and worth reusing:

- **axe inside the closed root** (`p8-accept-support/axe.ts`). The card and toolbar live in a closed shadow root, which axe cannot reach. The DevTools protocol can: the root's nodes and style sheets are copied into an open root on an audit host in the same document and axe runs there. It was checked on purpose (a nameless button and an image without alt are found). axe reports colour contrast there as "needs review", so contrast is computed on the real computed styles (`contrastProblemsInRoot`, also checked against a forced bad colour).
- **The dead-control sweep has a self-check** (a synthetic page with one inert and one working button: only the inert one is reported).

## Journey results

| # | Journey | Result |
| --- | --- | --- |
| 1 | Install, welcome page opens once, "Not now", key typed and verified, practice page, select, Listen (no-voice note), Explain (one request, none before the click), card, Open in side panel (a panel for this tab only; opening it sends nothing), Load Related words in the panel (one request), Copy (what the card shows), Close, Escape | Pass. Defect P1 on this path (below). |
| 1b | Setup skipped, popup then "Connect Groq" then Settings at the key, key pasted, Explain shows the approved first-send wording (D-16) with nothing sent, then once confirmed, one request; Copy to the real clipboard | Pass |
| 1c | Two tabs, different selections: each panel shows only its own; a third tab says to select again; navigation empties that tab's panel only; closing a tab drops its hand-off; Clear all data empties every panel; nothing stored in `chrome.storage`, IndexedDB or caches | Pass |
| 1d | Real prompt: Enable on websites, Allow, observer registered, a tab that was already open gets the toolbar without a reload; keyboard only: find bar selects, toolbar appears (FR-010), `Alt+Shift+E` focuses Listen, Right Right Enter opens the card, Tab order Close, tab, answer, Copy, Open in side panel; Copy by key announces "Copied"; Close keeps focus on Explain; Escape dismisses card and toolbar and focus returns to the page; Enter on Open in side panel opens the real panel | Pass |
| 2 | Declined: the help is at the end of setup, in the popup and in Settings, says the same thing in all three; right-click item, popup button and keys it names work (toolbar on that tab only, no registration, no permission); "Enable on websites" from the popup's own help button opens Settings, Allow, the toolbar is automatic; "Only when I ask" hides it, as the help warns, and the shortcut still shows it | Pass. P4 (copy gap). |
| 3 | A `.pdf` tab: the real popup's first button is "How to read PDFs with Clavis" (so the notice shows), it opens Settings at the PDF help, whose steps work: popup "Open PDF reader", file chooser, select, Explain, Open in side panel (real panel for the reader tab) | Pass |
| 4 | Tab sets by scope; every error state on three surfaces | Pass; same text, buttons, behaviour and styles everywhere |
| 5 | Accessibility sweep | Pass: 0 axe violations, 0 contrast failures, no horizontal scroll, card inside the window at every width |
| 6 | Placeholder sweep | One failure: P3 |
| 7 | Flags and cache | Pass |

## Results by Phase 8 task

| Task | Verdict | Evidence |
| --- | --- | --- |
| Explain and Listen look and behave the same in webpage and PDF reader | Met | `p8-accept-states` (text, buttons, behaviour and computed styles identical on web page, practice page and reader), `p8-accept-scopes` |
| Word, phrase, sentence aware action sets | Met | Word: Core, Roots, Related words. Phrase: plus Simplify. Sentence and passage: Core, Simplify. Requests only when a tab opens, none on reopening |
| Side panel for long answers, per tab | Met | Journeys 1, 1c, 1d, 3; real panel for web pages, practice page and reader; keyboard open |
| Copy, dismiss, retry, provider status, no-key prompts | Met | 401 "Update key", 404 "Choose another model", 429 countdown with no loop, offline, "Can't connect", unreadable answer, no key "Connect Groq"; each button lands in the right Settings section on every surface |
| Spacing, scroll, dark mode, small windows | Met except P1 | Card and panel at 320, 360, 1000 px, light and dark; long answers scroll inside the card |
| Direction, Unicode, labels, keyboard | Met | Arabic and Hebrew selection and answers (`dir="auto"`, mixed text), Latin with combining mark, Japanese, emoji sequence, Greek, Devanagari round trip; keyboard-only path (journey 1d) |
| Grammar and Translate (Should) | Correctly left off | Flags false in every bundle, forced-flags marker absent, no tab in any scope, none in the panel, the service worker refuses both modes, no word in Settings |
| Help: why the native viewer cannot host the overlay, how to open the reader | Met | Popup notice (real popup), reader empty state link, Settings help; the steps work (journey 3) |
| Help for users who declined site access | Met except P4 | Journey 2 |
| Remove placeholder controls that do nothing | Met except P3 | 0 dead controls on 21 screens; one placeholder link (P3) |

**Gate** ("End-to-end tasks completed without developer-only instructions; optional features are finished or removed"): met for every task. Release blockers for Phase 9 are P3 (a link that leads nowhere until the policy is published, already tracked as open item D-15) and, by user impact, P1.

## Requirement coverage (selected)

FR-001 (welcome page once; setup persists across a browser restart; a relaunch with `--load-extension` always counts as a fresh install, so "no second welcome page" cannot be tested this way, see gaps), FR-002 and D-16 (approved wording, nothing sent while it is open), FR-009 (real prompt, real grant, no reload), FR-010 (keyboard selection), FR-011, FR-013, FR-014, FR-016, FR-017 (no chat request before the click, in every journey), FR-018 (right-click, icon, shortcut on the current tab only), FR-019, FR-030 to FR-035, FR-038, FR-039, FR-042, FR-043 (absent), FR-056, FR-072 (401 keeps settings; 429 honoured), error catalog section 7, NFR accessibility and i18n.

## Defects

| ID | Severity | Summary | Repro | Test |
| --- | --- | --- | --- | --- |
| P1 | Medium | After Listen shows its "Voice isn't available on this device" note, Explain stacks the card under it and its footer (Copy, Open in side panel) lands outside the visible window. On the practice page the article frame is only about 313 px tall and clips the card, so the buttons cannot be pressed. Hits every Linux user without a voice, in the very first practice run (select, Listen, Explain) | No on-device voice. (a) Any web page in a 1000x450 window: double-click a word, Listen, Explain: footer at y 510 to 539 of 450. (b) Practice page: double-click "ice", Listen, Explain: footer at y 386 to 415 of 313 | `p8-accept-defects.spec.ts` P1a, P1b (`test.fail`; skipped on a machine with voices) |
| P2 | Low | The practice page always says "No Groq key yet? Listen works without one. Explain will show you how to connect Groq." even with a key connected (the same sentence in the wizard is hidden once a key exists) | Connect a key, open the practice page | P2 |
| P3 | Medium for release, known | Settings > Privacy > "Clavis privacy policy" points at `https://omakidx.github.io/clavis/privacy/`, which is not published (`lib/ui-client/links.ts`: "PLACEHOLDER (D-15)"). It is the only link in the ZIP to a host that is not Groq. FR-074 asks for a public policy and the task asks for no placeholder in the ZIP | Open Settings, press the link | `p8-accept-placeholders.spec.ts`, last test (`test.fail`) |
| P4 | Low (copy) | The help says "click the Clavis icon" but Chrome hides a new extension's icon in the Extensions (puzzle piece) menu until it is pinned, and the help never says so. The setup's last screen says "one click away from the Clavis icon", which is two clicks when it is not pinned | Fresh Chrome, read Settings > Website access or the end of setup | P4 |

All four fail without `test.fail` for the stated reason (assertion output kept in the run log: P1a "Copy at y=510..539 of 450"; P1b "y=386..415 of 313"; P2 "No Groq key yet?" found; P3 host "omakidx.github.io" not in the verified hosts; P4 the sentence has no mention of the Extensions menu).

**Dispositions (2026-10-23, before the Phase 8 commit):** P1 fixed (the card's height is fitted to the host window or frame so its footer stays visible; Explain clears a Listen problem note; the practice frame is taller), P2 fixed (shown only without a key), P4 fixed (the help says to pin Clavis from the Extensions menu); their `test.fail` lines were removed and the tests pass. P3 stays open until the privacy policy is published (Phase 10, D-15). O-1: the context-menu item and the popup's Explain on this page now start Explain directly (FR-018); Alt+Shift+E keeps opening the toolbar with focus. O-2: FR-035 now lists phrases. O-4: the error catalogue now has both titles. O-6: the spec comment was corrected.

## Observations (not defects)

- **O-1 (spec drift).** Right-click, popup button and shortcut show the toolbar for the selection; the person then presses Explain. `requirements.md` FR-018 and UJ-02b, and `architecture.md` section 3 step 6, say the card opens for the current selection. The help text promises only "choose Explain with Clavis". Needs a decision: change the text or open the card.
- **O-2 (docs).** `execution-phases.md` gives Simplify to phrases; FR-035 says sentences and passages. The product follows the phase document (tested).
- **O-3.** Settings > Model with no key is a select with one option; the text beside it explains. Disabling it would be clearer.
- **O-4.** Offline wording is "You're offline" (title) where the error catalog says "Can't connect". "Can't connect" is used when the browser thinks it is online. A deliberate Phase 8 addition; both are tested.
- **O-5.** In the real popup (about 600 px tall) the site-access help is folded under the buttons and needs scrolling when no key is connected.
- **O-6.** Opening the real side panel by keyboard moves keyboard focus into the panel; the page keeps showing the card's focus ring. Escape inside the card dismisses the card and toolbar together (UJ-02); the comment in `p8-explain-ux.spec.ts` ("gives focus back to the toolbar button") is wrong for Escape (it is true for the card's Close button, asserted in journey 1d).
- **O-7.** The real popup and side panel are not exposed to Playwright as pages; real-UI checks use `chrome.runtime.getContexts`, keyboard focus order counted on the same page opened in a tab, and screenshots.

## Gaps

- Real voices (D-14): this machine has none; the no-voice path is what is tested. With voices P1a and P1b skip.
- Windows, macOS, Chrome 147 minimum: not run.
- FR-001 "welcome page does not reopen on reload or update": `--load-extension` makes every launch an install, and `chrome.runtime.reload()` disables a flag-loaded extension; covered by the background unit tests only. Persistence of stored setup across a restart is tested.
- Single-page navigation (`pushState`) and fragment changes do not start a page load, so the worker keeps the hand-off (by design: `tabs.onUpdated` loading). Not tested; worth a decision.
- The Chrome "Site access" switch on `chrome://extensions` was not shown to grant the optional origins from a not-granted state; the wizard's behaviour if access arrives while the access step is open (status granted, choice still unset: no buttons, no Next) was not reproduced and is a risk to check by hand.
- Screen reader behaviour is covered by axe and live-region assertions only.
- The side panel's real DOM cannot be read by Playwright; its DOM is tested as an ordinary tab (same page, same code).

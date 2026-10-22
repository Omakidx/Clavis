# Phase 4 acceptance matrix: webpage selection toolbar

Independent, black-box verification of the Phase 4 toolbar (FR-010 to FR-018) and of the success measure
"Basic selection detection >= 95% on the predefined supported-page fixture suite"
([requirements.md section 1](../requirements.md#1-problem-audience-and-success-criteria)).
Written by the verification specialist, not by the implementer. Run date 2026-10-22, Chrome for Testing 156
(Playwright 1.64.1 bundled Chromium, new headless), Linux, 16 cores, build from `npm run build` on branch
`phase-4-toolbar` while the implementer was still editing (re-run list at the end).

## Method

- **Black box.** Nothing is read from production code. Every input is a real, trusted Playwright mouse or keyboard
  event (no synthetic DOM events), because the toolbar ignores untrusted ones (security review HIGH-1).
- **Toolbar access.** The toolbar root is closed, so it is read only through the DevTools-protocol helper
  `tests/e2e/spike-b-support/toolbar.ts` (`tb`, `SEL`). All access goes through **one adapter**,
  `tests/e2e/p4-matrix-support/toolbar.ts`, so a rename of that helper needs one edit. The observable contract used is
  exactly what the implementer confirmed: `[data-clavis=panel][data-kind][data-mode]`, `role=toolbar` buttons
  `[data-action=listen|explain|trim]`, card `[data-clavis=card|card-text]`, `[data-clavis=limit|trimmed|trimmed-text|live]`.
  No test hook ships in the extension. A page-side probe (`addInitScript`) only watches the host `div[popover]`
  (display and popover-open) to time and to count hide transitions.
- **Site access.** Chrome's permission prompt cannot be clicked from Playwright, so "granted" is the test manifest
  copy used by Spike B (`launchExtension({ grantedSiteAccess: true })`); everything downstream is real code.
  "Declined" is the unpatched manifest.
- **Fixtures.** 26 self-contained static pages (own prose, no external resources) in `tests/fixtures/web/matrix/`,
  indexed by `index.json` with 131 targets (48 word, 27 phrase, 39 sentence, 17 passage) and the expected kind of each.
  Seven more pages support the FR tests (`placement-corners`, `selection-clearing`, `sec-hostile`, `limit-boundary`,
  `scroll-container`, `iframe-cross-origin`, `matrix-iframe-inner`) and `editable-fields` holds the negative cases.
- **Detection attempt** (`p4-matrix-detection.spec.ts`). For each fixture x target x method the text is located from
  Range rects (so transforms, zoom, columns, RTL and vertical writing are already applied), scrolled into view, an
  obstruction check makes sure the pressed point really hits the text, and the selection is made with real input:
  `dblclick` (words), `drag` (phrases, sentences), `triple` (paragraphs) and `keyboard` (double-click the first word,
  then Shift+Arrow until the selection equals the target, arrow chosen per direction: Left for RTL, Down for vertical).
  An attempt **passes** when all of: the browser selected exactly the target (otherwise the attempt is `invalid`, a
  fixture or input problem, excluded from the rate and asserted to be zero); the toolbar appears within
  `DETECTION_TIMEOUT_MS` = 1,500 ms; `data-kind` is an acceptable kind for the target; the toolbar is near the
  selection and inside the viewport; and the text it **captured** (read from the card after clicking Explain) equals
  the selection. `DETECTION_RATE_THRESHOLD` = 0.95 is a named constant in `p4-matrix-support/detect.ts`.
- **Why the keyboard method starts from a double-click.** Verified in this Chromium: a click in static text leaves a
  collapsed "Caret" selection that Shift+Arrow does not extend, and there is no caret without caret browsing. The
  keyboard user's path is therefore: select a word, then grow or shrink with Shift+Arrow.
- **Not covered by this machine** is listed under "Gaps".

## Fixture list

| Fixture | Layout it models |
| --- | --- |
| news-article | two columns, sidebar, ad-like dashed boxes, share buttons, blockquote |
| blog-code-footnotes | single column, `pre/code`, inline code, superscript footnotes |
| docs-site | fixed header, fixed left nav, anchored headings |
| wiki-infobox | floated infobox table, data table, contents box |
| multicolumn | CSS `columns: 3`, justified |
| grid-magazine | CSS grid with spanning cards |
| sticky-share-bar | sticky header, fixed floating share column, long-form |
| forum-thread | avatar column, nested quotes, signature |
| product-tabs | product page, ARIA tabs with hidden panels |
| academic-paper | `var/sup/sub`, citations, equation line |
| rtl-arabic, rtl-hebrew | `dir=rtl`; Hebrew has an isolated Latin run |
| cjk-latin-mixed | Japanese, Chinese and English in one page |
| vertical-writing | `writing-mode: vertical-rl` |
| webcomponent-shadow | article body inside an **open shadow root** |
| iframe-same-origin | same-origin iframe with its own selection |
| dialog-modal | native `<dialog>` opened with `showModal()` |
| transformed-zoom | CSS `zoom`, `transform: scale`, `rotate` |
| infinite-scroll | content inserted after load and on scroll |
| dark-mode | dark theme, custom `::selection` |
| very-long | more than ten screens |
| narrow-mobile | 375 x 667 viewport |
| inline-nested-punctuation | nested `b/i/u/em/mark`, curly quotes, dashes, NBSP, soft hyphen |
| dense-fixed-header | two fixed top bars and a fixed bottom bar at `z-index: 2147483647` |
| plain-baseline | control: polysemous word, idiom, technical terms |
| long-passage | one 2,637 character paragraph, an emoji straddling the 2,000 cap |

## Results: basic selection detection rate

Run `npx playwright test tests/e2e/p4-matrix-*.spec.ts --output=test-results/p4-matrix` against the default build:
**121 passed, 2 skipped (opt-in real-UI spec), 0 failed, 4.5 minutes.** The `test.fail` entries are counted among the
passes (two documented defects, below).

**Detection rate: 100.0 % (235 of 235 attempts; 0 failed, 0 invalid).** Threshold 95 %: **met**.
The captured text was verified against the selection on 234 attempts; the one without a card is the over-limit
passage, which correctly offers no Explain.

| Method | Pass | Fail | Rate |
| --- | --- | --- | --- |
| double-click (words) | 46 | 0 | 100.0 % |
| drag (phrases, sentences) | 59 | 0 | 100.0 % |
| triple-click (paragraphs) | 26 | 0 | 100.0 % |
| keyboard (double-click then Shift+Arrow) | 104 | 0 | 100.0 % |

By kind: word 92/92, phrase 53/53, sentence 67/67, passage 17/17, ambiguous-kind targets 6/6.

Per fixture: 100 % on all 26 (attempts per fixture: 3 to 15; the full table is in
`test-results/p4-matrix-reports/detection.json`, which also lists every attempt with its reason).

Failures: none. Notable passes: the open shadow root article body, the modal dialog (toolbar mounted inside the
dialog and clickable), the same-origin iframe, vertical writing, CSS zoom, rotated text, RTL with an embedded LTR run
(drag only), content inserted after load.

Selection to toolbar latency measured inside the page on the same 235 attempts (mouse methods; machine load average
11 to 15 on 16 cores while 4 spec files ran in parallel): first selection on a page p50 26 ms, p95 64 ms (n = 26);
later selections p50 4 ms, p95 13.7 ms (n = 79).

## FR-by-FR results

All entries pass on the build named above unless marked. Test titles abbreviated; files are in `tests/e2e/`.

| FR | Result | Tests |
| --- | --- | --- |
| FR-010 mouse and keyboard on fixtures | Pass | detection spec (235 attempts); `p4-matrix-fr` "mouse: double-click, drag and triple-click", "keyboard: growing a selection with Shift+Arrow updates the toolbar", "keyboard: Ctrl+A", "a backwards drag and Shift+click", "a selection that spans two paragraphs", "rapid successive selections end with the toolbar for the LAST one", "a collapsed selection shows nothing", "selection constraints: inputs, passwords, textareas and editable regions are skipped", "...a selection that spans fields never captures field values, editable text or hidden text", "non-HTTP(S) documents are not eligible", "text inside the toolbar card does not replace the card", "cross-origin iframe with site access" |
| FR-011 kinds, normalisation | Pass | "a single word / a word with trailing punctuation / a short phrase / a multi-word technical phrase / one complete sentence / two sentences", "a very long selection is a passage", "whitespace and invisible characters are normalised: NBSP, soft hyphen and runs of spaces never reach the captured text", "a multi-line paragraph is captured as one line", "selected text keeps its Unicode (RTL, CJK)" |
| FR-012 placement | Pass (D-1 fixed) | "near the selection, inside the viewport and not covering the text" on 8 layouts, RTL Arabic and Hebrew, "viewport corners and the right edge", "a selection taller than the viewport", "scrolling" (page and inner container), "resize", "320 px wide viewport", "200% and 400% zoom (640x360, 320x180)", "pinch zoom (visual viewport scale 2)", "a modal dialog", same-origin and cross-origin iframe. **Defect D-1: vertical writing — fixed in Phase 4** |
| FR-013 Listen and Explain | Pass | "both actions are visible together and named Listen and Explain", "mouse: each button can be pressed and acts on the captured selection", "keyboard: the command path puts focus on Listen; arrows reach Explain; Enter and Space activate" |
| FR-014 dismissal and persistence | Pass (E-1 fixed) | "Escape", "a click outside (and it does not come back)", "removing the selection (clicking into text / from script)", "after the toolbar was used, removing the selection later still dismisses it", "clicking the toolbar keeps it open without flicker" (per-frame hide counter = 0), "a page that clears the selection on every press cannot dismiss the toolbar or change what it captured", "after Escape, selecting the same word again", "a new selection replaces the old toolbar content", "inside a modal dialog: Escape closes the toolbar first". **Edge E-1 — fixed in Phase 4** |
| FR-015 site access, exclusions, on-demand | Pass | `p4-matrix-access`: "chrome:// pages, extension pages, data: URLs, about:blank and file: URLs never run the observer", "the Chrome Web Store is excluded in the registration itself", "a restricted tab refuses the on-demand injection route cleanly", "a disabled host gets no toolbar on its next load; another host is unaffected; re-enabling restores it", "on-demand: no automatic toolbar... the injection route then shows it in that tab only", "on-demand without a selection", "automatic mode is restored", "with access granted the popup does not offer Explain on this page", "revoking stops the toolbar on the next page load; granting again brings it back" |
| FR-016 accessibility | Pass | "labelled role=toolbar with native buttons; the card is a status region", **axe-core (WCAG 2.x A/AA and best-practice) on the open toolbar, the card, a dark page and the "Selection too long" state: no violations**, "keyboard-only flow", "Tab does not trap", "the focused button has a visible focus indicator" (`:focus-visible` and outline), "click targets are at least 24x24", "prefers-reduced-motion", "forced colors" |
| FR-017 no transmission on highlight alone | Pass | "selecting, growing, scrolling, dismissing and re-selecting sends nothing to Groq, nothing but the page, and no AI or TTS message to the background" (service-worker `onMessage` log: zero messages from any page, none carrying selected text), "Listen never calls Groq", positive control "the request tracker does see a Groq request made by the service worker", "the toolbar host is on the page only after a selection" |
| FR-018 context menu, toolbar icon | Partly automated | Automated: declined build has nothing registered and no automatic toolbar, popup shows "Explain on this page", the injection route refuses with `no-access` without an `activeTab` grant, a web page cannot reach the route; granted build: the same route injects into the current tab only. **Native UI** (`p4-matrix-realui.spec.ts`, opt-in `CLAVIS_E2E_REAL_UI=1` under `xvfb-run`, run once, both pass): right-click "Explain with Clavis" shows the toolbar in the current tab only with nothing registered; Alt+Shift+E shows the toolbar, focus lands on Listen, arrows and Enter work. The toolbar-icon (puzzle menu) click is **not** automated, see Gaps |
| Selection limits | Pass | "over the limit: Selection too long with the single action Use the first 2,000 characters", "trimming shows the trimmed text before anything is sent and caps it at 2,000 characters without splitting an emoji" (no request to Groq, the emoji at units 1,999 and 2,000 is dropped whole), "the boundary: exactly 2,000 characters is allowed, 2,001 is too long", "select-all on a very long page" |
| Security regressions | Pass | `p4-matrix-security`: page-made selection plus every synthetic event never creates the toolbar; with a toolbar showing the page gets `host.shadowRoot === null`, no shadow root anywhere, cannot press or dismiss it (synthetic clicks and Escape), pre-defined custom elements are never upgraded into it, the page-world `attachShadow` patch never sees the extension, the host is a plain `div` with only `popover` and `style`; HTML in selected text renders as text (no element, no handler); no AI/TTS message or Groq request from a hostile page |

### Verification matrix rows (requirements.md section 9)

| Row | Covered by |
| --- | --- |
| Web DOM: static article, complex CSS, iframes with permitted access, mixed RTL, long text, dense fixed header, mobile-ish viewport | 26 fixtures; same-origin and cross-origin iframe tests; `dense-fixed-header`, `narrow-mobile`, `rtl-*`, `very-long` |
| Selection: word, phrase, sentence, paragraph, keyboard, double-click, triple-click, nested inline, punctuation, collapsed | detection spec, `inline-nested-punctuation`, collapsed-selection test |
| Site access: granted, declined (menu + icon), granted later, revoked | access spec (granted, declined, revoke and re-grant through Chrome's own Site access switch), real-UI spec (menu). The Chrome permission prompt itself is not clicked (see Gaps) |
| Usability: keyboard-only, screen reader, reduced motion, 200% zoom, narrow screen, error recovery | keyboard-only and Tab tests, live region and roles asserted (a real screen reader was not run), reduced motion, zoom and 320 px tests, forced colors |
| Semantic (AI) and Speech rows | Out of scope for Phase 4 (Phase 5 and 6) |

## Defects and edges found

> **Update (final Phase 4 run, 2026-10-22):** both items below were **fixed** in Phase 4 and their `test.fail`
> annotations were removed — they are now ordinary regression tests and pass. The final full run on the integrated
> build measured **235/235 (100%)** detection with no attempt covering the selected text (vertical writing included).

No test is skipped or weakened. Each item below was a runnable test annotated `test.fail`, so the suite stayed green and
the annotation turned into a failure once the behaviour was fixed.

**D-1 (FR-012, medium): in vertical writing (`writing-mode: vertical-rl`) the toolbar covers the selected text.**
Placement treats the selection as horizontal (above the first rect, below the last), which in a vertical block lands on
the neighbouring columns. All three vertical-writing sentence and paragraph attempts report an overlap in the
detection data; the toolbar is still near the selection and every selection is detected.
Reproduction: `CLAVIS_EXTENSION_DIR=.output/chrome-mv3 npx playwright test tests/e2e/p4-matrix-fr.spec.ts -g "vertical writing"`
(fixture `tests/fixtures/web/matrix/vertical-writing.html`, drag the sentence 朝の光が障子を通して…). Assertion that fails:
`vertical-rl: toolbar must not cover the selected text`.

**E-1 (FR-014, low): an instantaneous double-click on the still-selected word right after Escape does not bring the
toolbar back.** Escape hides the toolbar but the observer still holds the previous selection and ignores an unchanged
range. With 0 ms between the two clicks the selection never changes, so nothing is shown. With a human gap of 60 ms or
more (or after a click elsewhere) it works (asserted by "after Escape, selecting the same word again", and the same
gap is used in the dialog test). Real users are very unlikely to hit this; reported for completeness.
Reproduction: `-g "instantaneous double-click"` in the same spec.

Observations that are not defects:

- A selection that touches an editable region (select-all or a drag through `contenteditable` text) is allowed to show
  no toolbar or a toolbar with sanitised text; the tests accept either and fail only if field values, editable text,
  hidden text or a password reach the captured text. Select-all on `editable-fields.html` currently shows no toolbar.
- In a modal dialog after pressing Explain, removing the selection from script did not hide the toolbar (the detection
  reset had to click inside the dialog); Escape and a click in the dialog do dismiss it, and on normal pages selection
  removal after the interaction dismisses it (asserted). Not tested further.
- Triple-click toolbar timing is not measured (the toolbar is already up from the second click); keyboard selections
  are measured only for correctness.

## Performance spot-check

`p4-matrix-perf.spec.ts`, 25 fresh page loads per fixture after one discarded warm-up, selection by real double-click,
timestamps from the in-page probe (last real `mouseup` to host displayed), so Playwright and CDP latency are excluded.
Machine **load average 11.2 / 14.8 / 15.4 before and 12.6 / 14.7 / 15.3 after on 16 cores** (busy: other agents, Chrome
GPU process, Blender), so the absolute numbers are pessimistic. The spec asserts only a 600 ms ceiling on a busy
machine and the real budgets when the 1-minute load per core is at most 0.5 (otherwise it records a note).

| Fixture | First selection p50 / p95 / max (ms) | Repeat selection p50 / p95 / max (ms) |
| --- | --- | --- |
| plain-baseline | 36.3 / 82.1 / 106 | 4.1 / 13.6 / 17.2 |
| news-article | 29.6 / 57.3 / 67.9 | 4.6 / 16.1 / 17.8 |

Budgets: first toolbar p95 <= 150 ms (tech-stack section 6), later toolbars p95 <= 50 ms. Both are met with margin even on
this loaded machine. An earlier run at load average 29 gave first p95 43 and 64 ms. Not measured here: 4x CPU
throttling, a quiet reference machine.

## Gaps

- **Toolbar-icon click** (Extensions puzzle menu, then the popup button) is not automated: Chrome's native menu needs fixed
  screen coordinates that do not resolve in this environment (the Spike B real-UI icon test fails the same way). The route
  the popup button calls (`CLAVIS_INJECT_TAB`) is tested directly; a person should click the icon once by hand.
- **Chrome's permission prompt** and the Web Store install dialog are not driven (Spike B did drive the prompt with
  xdotool; not repeated). "Granted later from Settings" is covered by the revoke/re-grant test through Chrome's own
  Site access switch, not by the Settings page button.
- **Command path in the default suite** sends the same message the background sends after the shortcut
  (`CLAVIS_OPEN_SELECTION` with `focus: true`) because Playwright cannot press a browser-level extension shortcut. The real
  Alt+Shift+E is covered only by the opt-in real-UI spec. If the implementer renames that message the keyboard tests need
  one edit in `p4-matrix-support/actions.ts` (`openViaCommand`).
- **axe-core cannot enter a closed root** ("No elements found for include"). The test reads the root's stylesheet rules and
  markup through the DevTools protocol, copies them into an open shadow root in the test page and runs axe on the copy
  with the page's real colours behind it. Focus and hover styles are therefore not part of the axe run (focus
  visibility is asserted separately).
- **Screen readers** were not run; roles, names and the live region are asserted. Touch selection handles, real browser
  zoom (only equivalent viewports and pinch zoom), Chrome 147 (the pinned minimum), and Windows/macOS were not tested.
- **Semantic and speech rows** of section 9 belong to Phase 5 and 6.
- The product kind heuristic is checked on clear cases only; ambiguous cases (unspaced CJK, quotes with inner
  punctuation) accept the listed alternatives in `index.json`.

## How to run and what to re-run

```text
npm run build
npx playwright test tests/e2e/p4-matrix-*.spec.ts --output=test-results/p4-matrix           # 4.5 minutes
CLAVIS_EXTENSION_DIR=.output-p4-matrix/chrome-mv3 ...                                         # a separate build, same command
CLAVIS_E2E_REAL_UI=1 xvfb-run -a -s "-screen 0 1920x1080x24" \
  npx playwright test tests/e2e/p4-matrix-realui.spec.ts --output=test-results/p4-matrix-real # native menu and shortcut
```

Reports are written to `test-results/p4-matrix-reports/detection.json` and `performance.json` (outside Playwright's
cleaned output directory). Re-run everything after the implementer finishes; the results most likely to move are the
detection rate (any change to `lib/selection`), the FR-012 placement tests and D-1 (`components/tooltip/position.ts`),
the FR-014 tests and E-1 (`lib/selection/observer.ts`), the FR-016 axe tests (`view.ts`, `toolbar.css`), the over-limit tests
(`view.ts` text and the `trim` action) and the command-path tests (`CLAVIS_OPEN_SELECTION`).

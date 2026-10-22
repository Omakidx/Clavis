# Product requirements — Clavis

**Status:** Implementation-ready specification (v1 baseline)  
**Version:** 1.1-draft · **Last reviewed:** 2026-10-22  
**Platform:** Google Chrome, Manifest V3, desktop first  
**Product owner decisions:** Groq only for v1; user provides key; no mandatory accounts or first-party backend; custom PDF.js reader; native pronunciation for words **and** sentences. Further resolved decisions D-01 … D-18 are in [§11](#11-product-decisions).

## 1. Problem, audience and success criteria

### Problem

Reading across the web and PDFs is interrupted by dictionary tabs, copying sentences into chatbots and switching back and forth to reconstruct context. Generic word definitions often do not match the meaning in the specific sentence. Readers should be able to **select, listen, understand and continue reading** in the same flow.

### Target users

- **Students and researchers:** analyze academic vocabulary, technical terms, source documents and PDFs.
- **Language learners:** hear spoken words and sentences, compare meanings, study usage scenarios, and simplify passages.
- **General readers:** understand unfamiliar wording and idioms without leaving an article.
- **Professionals:** quickly clarify complex terms and written explanations, with clear confidentiality boundaries.

### North-star outcome

A user with a valid Groq key can highlight selectable text in a supported webpage or in the custom PDF reader, **hear it in one click** and receive an actionable contextual explanation through an unobtrusive UI **without leaving the current reading surface**.

### Example success measures (targets, not guarantees)

| Metric | Target / evaluation |
| --- | --- |
| First-run setup | New user completes install/key validation/first explanation without external help in usability testing |
| Basic selection detection | ≥ 95% success on the project's predefined supported-page fixture suite |
| Tooltip responsiveness | Initial selection toolbar appears in ≤ 150 ms at p95 on test hardware, **including the first selection on a page** (lazy UI load counted); never wait for network |
| Page weight | Always-loaded content script within the budget in [tech-stack.md §6](tech-stack.md#6-frontend-design-and-component-boundaries); no measurable effect on page load for pages where nothing is selected |
| AI cost | Explain makes **one** Groq request; each extra tab makes at most one more, only when opened |
| TTS start | Begin playback promptly when a compatible voice exists; no Groq call for Listen |
| AI experience | Clear loading/error/result states; measure p50/p95 using realistic free-tier accounts rather than promising a fixed Groq response SLA |
| Privacy | Zero AI requests on mere selection; zero exposure of API keys to page DOM or content scripts |
| PDF reader | Correct text selection/zoom/search for all text-layer fixture PDFs; sensible errors for scans and encrypted/invalid files |
| A11y | Keyboard-operable controls, visible focus, screen-reader labels, no essential mouse-only paths |
| Store readiness | No critical security, privacy or accessibility blockers; accurate listing and privacy policy |

## 2. Scope boundaries and prioritization

**Must = v1 launch-blocking. Should = add if on schedule, otherwise follow-up update. Could = later. Won't = deliberately excluded from v1.**

| Priority | Included behavior |
| --- | --- |
| **Must** | Onboarding, Groq BYOK, key validation, permissions disclosures, optional all-sites access with on-demand fallback, model availability handling, webpage selection, reliable popup, Listen for words/sentences where a voice exists, core explanation (context + definition + examples), roots / related words / simplify tabs, local PDF.js reader with virtualized pages, privacy controls, error handling, keyboard support, Chrome packaging |
| **Should** | Grammar and translation tabs, quick copy, PDF find-in-document, voice/locale selection, accessible side panel for long answers |
| **Could** | PDF thumbnails, offline lexical cache, dictionary recorded pronunciation and IPA, theme customization, smarter tone/reading-level control, explain-in-chunks for long selections |
| **Later (post-v1, planned)** | Remote PDF URLs and "Open in Clavis" on PDF links (D-03), saved vocabulary/history with export (D-04), additional UI languages |
| **Won't (v1)** | Automatic overlay in Chrome's native PDF viewer, globally intercept all PDFs, OCR/scanned-document recognition, authenticated/DRM PDF bypass, first-party accounts, billing, cloud sync, automatic whole-page or whole-PDF analysis, background surveillance, other AI providers |

## 3. User journeys

### UJ-01 — First setup

Install -> welcome -> explanation of data transfer -> **Enable Clavis on websites** (Chrome permission prompt; may decline) -> Get Groq key -> enter key in **extension-origin options** -> Test connection -> choose working model -> set voice/language/tooltip preferences -> run interactive demo on a bundled practice page -> ready. Setup state must survive reloading the extension, but session-only secrets intentionally disappear on restart.

### UJ-02 — Word on a webpage

Highlight `bank` in `They sat on the bank of the river` -> toolbar near selection -> **Listen** speaks `bank` -> **Explain** sends selected word + bounded local sentence context to Groq in one core request -> result identifies riverbank, not a financial institution, with a definition and examples -> user opens **Roots** or **Related words** (one extra request each) -> dismisses with Escape.

### UJ-03 — Sentence on a webpage

Highlight `She finally broke the ice.` -> **Listen** speaks the entire sentence -> **Explain** returns the in-context meaning (idiomatic vs literal) -> user opens **Simplify** for a natural rewrite -> copies result. No irrelevant word-only tabs shown.

### UJ-02b — Site access declined

User declined the all-sites permission during onboarding -> selects text on an article -> no toolbar appears automatically -> right-clicks **Explain with Clavis** (or clicks the toolbar icon) -> Clavis is injected into that tab only and the explanation card opens for the current selection. Settings offer to enable site access later.

### UJ-04 — Local PDF

Open extension -> Open PDF -> file picker or drag-and-drop -> PDF.js renders locally -> select text from text layer -> toolbar and explanation behaves like webpage -> zoom/search/page navigation -> closing tab releases PDF bytes and page canvases.

### UJ-05 — Missing key / quota exhausted

User may still open and read PDF and use available TTS. On Explain, UI prompts to connect or fix key, with `Test Connection` / `Open Settings` action. For `429` show provider quota/rate-limit feedback; honor retry delay and never loop indefinitely.

### UJ-06 — Unsupported content

On `chrome://`, Chrome Web Store, built-in Chrome PDF viewer, scanned-only PDF, non-selectable canvas, or inaccessible embedded text, show clear supported-workflow guidance rather than claiming invisible analysis worked.

## 4. Functional requirements and acceptance criteria

### 4.1 Installation, onboarding and settings

| ID | Priority | Requirement | Acceptance test |
| --- | --- | --- | --- |
| FR-001 | Must | Open welcome page once per fresh install; later visits via Settings | Fresh profile triggers onboarding; reload/update does not reset completion |
| FR-002 | Must | Show data-sharing disclosure before first AI use | User can read what text/context goes to Groq; AI is not silently triggered |
| FR-003 | Must | Link to GroqCloud key creation; show instructions for pasting key | Link opens `https://console.groq.com/keys`; no key requested by developer site |
| FR-004 | Must | Test user key from privileged extension context | Valid key accepted; invalid 401/403 shows actionable error; no key appears in UI logs |
| FR-005 | Must | Choose model only from compatible/available options where discoverable | Unavailable ID triggers selection fallback UI; never silently changes to paid-only model |
| FR-006 | Must | Set explanation language, reading level, tooltip behavior, TTS rate/locale | Values persist, with immediate confirmation and reset-to-default option |
| FR-007 | Must | Change/revoke saved key and select persistent/session storage | Remove clears chosen storage area and in-memory references; missing key produces setup prompt |
| FR-008 | Should | Rerun selection and PDF tutorial from Settings | Demonstration works without requiring a live external page |
| FR-009 | Must | Request optional all-sites access during onboarding; allow grant/revoke later in Settings | Granting registers the content script without reinstall; declining leaves the extension fully usable via FR-018; revoking stops automatic injection on the next page load |

#### Approved disclosure copy (FR-002, FR-009, FR-071)

This is the approved user-facing wording. Implementation may adjust layout and fix grammar, but must not weaken what is disclosed. Each string becomes a `chrome.i18n` message (D-11); the bracketed names are suggested message keys.

**Onboarding — data disclosure** (shown before any Groq setup; must be acknowledged before the first Explain)

> **Your reading stays on your device until you ask** `[disclosureTitle]`
>
> - Selecting text does nothing by itself. Clavis notices the selection on your device and shows its toolbar. `[disclosureSelect]`
> - **Listen** uses the voices on your computer. Nothing is sent to Groq. `[disclosureListen]`
> - **Explain** sends the text you selected, up to 1,000 characters of the text around it, and your chosen language to **Groq**, using your own API key. Groq handles it under its own terms and privacy policy. `[disclosureExplain]` *(link: Groq privacy policy)*
> - PDFs you open are read inside your browser and never uploaded. Only text you select and explain is sent. `[disclosurePdf]`
> - Clavis has no server of its own and collects no data about you. `[disclosureNoServer]`
>
> Button: **I understand** `[disclosureAccept]`

**First Explain, if the disclosure was never acknowledged** (for example, onboarding was skipped). Shown once, inside the card:

> **Send this to Groq?** Clavis will send the selected text and a little of the text around it to Groq to explain it. You'll only be asked once. `[firstSendBody]`
>
> Buttons: **Explain** `[firstSendConfirm]` · **Cancel** `[firstSendCancel]`

**Onboarding — site access** (FR-009)

> **Show Clavis when you select text** `[siteAccessTitle]`
>
> To show the toolbar automatically, Chrome will ask you to let Clavis read and change data on websites. Clavis uses this only to notice when you select text and to show its toolbar. It does not read pages in the background, and nothing leaves your device until you click Explain. `[siteAccessBody]`
>
> Buttons: **Enable on websites** `[siteAccessGrant]` · **Not now — I'll use right-click instead** `[siteAccessSkip]`

**Key storage choice** (FR-071)

> **Remember on this device** — Saved in Chrome's extension storage on this computer until you remove it. It is not encrypted: anyone with access to your Chrome profile could find it. `[keyStoreLocal]`
>
> **Only for this session** — Kept in memory and cleared when you close Chrome. You'll paste it again next time. `[keyStoreSession]`
>
> Never paste your key into a website or share it in a chat. `[keyWarning]`

### 4.2 Selection, toolbar and accessibility

| ID | Priority | Requirement | Acceptance test |
| --- | --- | --- | --- |
| FR-010 | Must | Detect non-empty selections in regular HTTP(S) DOM text on sites with granted access | Mouse and keyboard selection both recognized on fixture sites |
| FR-011 | Must | Differentiate word/phrase/sentence/short passage | Contextual action choices are appropriate; punctuation/whitespace normalized safely |
| FR-012 | Must | Show compact toolbar near selection without blocking content | Edge placement, scroll/zoom, RTL and narrow window scenarios handled |
| FR-013 | Must | Offer **Listen** and **Explain** as primary actions | Both visible or keyboard-reachable without opening a full side panel |
| FR-014 | Must | Dismiss on Escape/click-outside/selection removal; preserve when clicking toolbar | No flicker or instant dismissal due to selection loss after pointer interaction |
| FR-015 | Must | Respect allowed site/page permissions and exclusions | No injection on unsupported/restricted pages; controls correctly reflect user site access |
| FR-016 | Must | Accessible roles/labels, focus management and reduced-motion support | Keyboard-only smoke test and automated accessibility checks pass |
| FR-017 | Must | Never transmit text on highlight alone | Instrumented network test shows no Groq request until an explicit AI action |
| FR-018 | Must | Right-click **Explain with Clavis** and toolbar-icon click work on the current tab without all-sites access | With site access declined, both paths inject into the current tab only (via `activeTab`) and open the card for the current selection |
| FR-019 | Should | Copy answer | Clipboard contains the visible result text |

**Selection constraints (normative):** default maximum selected text is **2,000 characters**; bounded context **≤ 1,000 characters** total. These are adjustable engineering defaults, not Groq maxima. For a selection over the limit, show **"Selection too long"** with one action, **Use the first 2,000 characters**, which shows the trimmed text before sending; never silently send the entire article. (Explain-in-chunks is a Could.) Do not collect password inputs, hidden text, editable form content or sensitive page metadata in v1; skip text in input/textarea/contenteditable by default.

### 4.3 Pronunciation: words, sentences and passages

| ID | Priority | Requirement | Acceptance test |
| --- | --- | --- | --- |
| FR-020 | Must | Read aloud a selected **word** with browser/native TTS | Single word plays without an AI API request on a machine with working voice |
| FR-021 | Must | Read aloud a selected **sentence** (including punctuation) | Sentence starts/stops/replays correctly; no sentence truncation for supported lengths |
| FR-022 | Must | Normal and slow rate; Stop and Replay | Controls work from tooltip; reselecting and playing stops previous utterance |
| FR-023 | Must | Detect no-voice/error and show feedback | Unsupported Linux/browser configuration shows an actionable message, not a fake playing state |
| FR-024 | Must | Speak only user-selected text and respect chosen locale if supported | Inspection demonstrates no surrounding unselected text gets spoken |
| FR-025 | Should | Voice chooser lists actually available voices | Empty/missing voice gracefully disables unavailable choices |
| FR-026 | Could | Show IPA / authentic dictionary audio for supported words | Source/locale clearly labeled; never invent audio or phonetics |

**TTS routing (D-07):** prefer `chrome.tts` where a suitable voice exists. If it has no suitable voice, fall back to Web Speech `speechSynthesis` running in an extension **offscreen document** (or directly in the reader page), but only once Spike D shows it produces audio on that OS. Neither mechanism guarantees voices on every operating system; Linux commonly has none for `chrome.tts`. Playback never depends on Groq.

### 4.4 AI explanation and provider behavior

| ID | Priority | Requirement | Acceptance test |
| --- | --- | --- | --- |
| FR-030 | Must | **Core explanation:** one request returns contextual meaning, plain definition and 2 examples for a word, phrase or sentence | `bank` examples disambiguate as expected on regression fixture set; exactly one Groq request per Explain click |
| FR-031 | Must | Plain definition and simple explanation (part of core) | Answer concise and tied to selection, with uncertainty for ambiguous terms |
| FR-032 | Must | Realistic usage examples (part of core) | 2 contextual examples by default; examples are clearly model-generated |
| FR-033 | Must | **Roots tab:** etymology, origin and morphological roots, requested when the tab is opened | Output distinguishes reliable roots from conjecture; display uncertainty if unknown |
| FR-034 | Must | **Related words tab:** synonyms and antonyms where semantically meaningful, requested when opened | Terms match intended sense; display `Not applicable` when relevant |
| FR-035 | Must | **Simplify tab:** plain-language rewrite for sentences and passages, requested when opened | Rewrite preserves meaning; no hallucinated facts |
| FR-036 | Should | **Grammar tab:** grammatical function and expression/idiom breakdown | Models return usable breakdown for fixture idioms and simple sentences |
| FR-037 | Should | **Translate tab:** translation into the user's selected language | Translation separates literal form from contextual sense where appropriate |
| FR-038 | Must | On-demand Groq calls with bounded context and requested mode | Request created only after an explicit action; opening an already-loaded tab for the same selection makes no new request; inputs validated; model output runtime validated |
| FR-039 | Must | Loading, success, empty, timeout, permission, key, model and rate-limit states | Explicit labeled states and retry options; no infinite spinner |
| FR-040 | Must | Model ID/API capabilities checked or fail safely | Unsupported models/schema settings fall back to supported request mode or show error |
| FR-041 | Must | Output as structured plain-text UI (never model HTML or rendered Markdown) | HTML/script/Markdown payloads appear only as literal text; XSS regression passes |
| FR-042 | Should | Compact card plus longer side-panel view | Long responses don't exceed viewport; side panel preserves selection snapshot |
| FR-043 | Should | Cache repeated same text/context/action locally for short TTL, opt-in | Cache is local; key isn't part of plain cache entry; private pages not cached by default |

**AI quality conditions:** generated outputs are educational guidance, not official dictionary entries. Never guarantee historical etymology or scientific accuracy. Do not make web claims without web retrieval; this release uses Groq text inference, **not** verified live search.

### 4.5 PDF reader

| ID | Priority | Requirement | Acceptance test |
| --- | --- | --- | --- |
| FR-050 | Must | Open local `.pdf` through file chooser and drag-and-drop | Two fixtures load offline; no file bytes leave browser except user-selected AI snippet |
| FR-051 | Must | Render PDFs using the bundled PDF.js viewer components (D-06) | Text, images and fonts render at normal and 150% zoom |
| FR-052 | Must | Produce selectable text layer aligned with page canvas | Selection text matches visual text for multiple zoom settings |
| FR-053 | Must | Use same Listen/Explain interaction as webpages | Identical action contracts and result presentation for PDFs |
| FR-054 | Must | Page navigation, zoom, page count, fit-width controls | Page controls work on 1-page and 50-page fixtures |
| FR-055 | Must | Loading, encrypted, corrupt, malformed and missing-text states | User receives specific actionable message; app does not crash |
| FR-056 | Must | Work without intercepting native Chrome PDF viewer | Reader only launches when user explicitly chooses it |
| FR-057 | Should | Find-in-document within selectable PDF text (thumbnails are a Could) | Search navigates to and highlights results |
| FR-058 | Later | Open a remote public PDF URL in the reader (D-03) | Deferred; not shown in v1 UI |
| FR-059 | Must | Virtualized page rendering for larger documents (provided by PDF.js viewer components) | Reader scroll remains responsive on test 100-page PDF; only pages near the viewport hold canvases |
| FR-060 | Won't | OCR, annotation authoring and full document translation | Not presented as supported features in v1 |

**PDF constraints:** browser's built-in viewer is outside scope; passwords may require a user prompt; text may have imperfect order or no text layer. v1 opens local files only; when remote URLs are added later, they must be treated as untrusted input and **never** fetched from local/private-network destinations without explicit user intent and origin validation.

### 4.6 Data, reliability and publishing

| ID | Priority | Requirement | Acceptance test |
| --- | --- | --- | --- |
| FR-070 | Must | Store API key only in trusted extension context | Content script cannot read saved key; no key in the DOM or message payload |
| FR-071 | Must | Explain key storage caveats; offer session-only mode | Settings distinguish local persistence from memory-only session; no claim of OS-level secret vault |
| FR-072 | Must | Handle revoked/invalid key and transient errors | 401 clears verified status but not silently all user settings; 429 respects retry-after |
| FR-073 | Must | Never log selected document content/key by default | Production logging test shows metadata-only diagnostic events if any |
| FR-074 | Must | Public and accurate privacy policy + Chrome Store disclosures | Policy lists Groq as processor/recipient, requested permissions, storage and deletion flows |
| FR-075 | Must | Package executable code locally for MV3 | Static ZIP inspection finds no CDN-hosted scripts / dynamic remote eval |
| FR-076 | Must | Minimum necessary permissions with justification | Permission matrix matches actual manifest/behavior; removal test for unnecessary grants |
| FR-077 | Must | All v1 features work in production ZIP, not dev server only | Fresh profile install and end-to-end smoke test successful |
| FR-078 | Should | Reset preferences, clear all local data, open privacy settings | Data-deletion and reset results can be verified locally |
| FR-079 | Later | Downloadable local vocabulary export (D-04) | Deferred with saved vocabulary |

## 5. Nonfunctional requirements

### Privacy and security

- User intent gates each AI request. No background crawling, no full-page indexing, no hidden PDF upload.
- Key never appears in codebase or build artifacts; no requests from the content script to Groq with key; privileged extension context mediates calls. Storage mechanics are defined in [architecture.md §9](architecture.md#9-persistence-privacy-and-telemetry); local storage is **not** an encrypted vault and the UI must say so.
- Avoid `eval`, remote JavaScript, unsafe HTML, unnecessary analytics SDKs and broad dynamic host permissions.
- Inspect/sanitize content originating on webpages and Groq before display; treat page text as untrusted model context and never execute embedded instructions.
- Use request IDs, payload size limits, message schema validation, and sender/origin checks where appropriate.
- No persisted raw page/PDF excerpts without a separate, explicit user choice to save an item.

### Performance, resilience and maintainability

- Tooltip first paint from local interaction; API latency must not stall the page selection flow.
- Keep the always-loaded content script small (budget in [tech-stack.md §6](tech-stack.md#6-frontend-design-and-component-boundaries)); load UI code only on the first qualifying selection; avoid polling the DOM or executing on every keystroke in editable inputs.
- Support cancellation and stale-response prevention when user changes selection or navigates.
- Retry only transient network/5xx/429 failures within bounded attempts; honor `Retry-After`. Do not automatically retry authentication failures or run uncontrolled backoff loops.
- Account for MV3 service worker suspension; don't rely on durable in-memory state.
- Avoid excessive PDF memory: lazy page rendering, explicit cleanup of canvases and object URLs, bounded caches.
- Validate via real-browser E2E tests and realistic PDFs, including inaccessible/large/multi-column fixtures.
- Use dependency lockfile; security updates and license checks before release.

### Accessibility and localization

- Toolbar and dialogs with accessible labels; logical focus order; Escape close; live announcements for loading/error states; controls work at 200% zoom.
- Honor prefers-reduced-motion and high-contrast themes. Provide click target sizes suitable for mouse/touch input.
- Context and translation language should be configurable; preserve Unicode and right-to-left text direction; test with non-Latin characters.
- The extension UI ships in English for v1, but every user-visible string is loaded through `chrome.i18n` so other UI languages can be added without code changes.
- Voice selection is based on installed capability, not guessed availability.

## 6. Permission and data inventory

| Data / permission | Why needed | Where handled | Sent off-device? |
| --- | --- | --- | --- |
| Selected visible text | Explanation/pronunciation | Content script/reader -> privileged request for AI | **Only for Explain** to Groq |
| Small adjacent context | Disambiguation | Content script/reader -> privileged AI request | **Only for Explain** to Groq |
| User Groq API key | Authorize user's Groq calls | Trusted extension contexts only | To Groq over HTTPS only |
| Voice locale/rate | Playback preference | Local extension settings | No |
| Local PDF bytes | PDF rendering | Reader tab + PDF.js worker | No |
| Webpage access (optional, user-granted) | Show toolbar at selection | Runtime-registered content script on granted http/https sites | Page data goes to Groq only on action |
| Current-tab access (`activeTab`) | Explain via context menu / toolbar icon when site access is declined | One-time injection into the current tab after a user gesture | Page data goes to Groq only on action |
| `tts` permission | Native speech output | Trusted extension speech adapter | No AI request |
| `storage` permission | Settings, key | Trusted extension storage | No by itself |
| `sidePanel` permission | Optional detailed display | Extension-owned side panel | No by itself |

The exact permission list, and why each permission is needed, is maintained in [architecture.md §3](architecture.md#3-extension-entry-points-and-message-routes).

## 7. Error catalog

| Condition | User experience | Technical requirement |
| --- | --- | --- |
| Missing/invalid key | **Connect Groq** / **Update key** button | Fail fast; no anonymous use of developer key |
| Invalid/unavailable model | **Choose another model** | List available or use safe known fallback with user confirmation |
| Groq `429` | **Rate limit reached** and human-readable retry guidance | Honor header; bounded retries |
| Network offline/timeout | **Can't connect** / Retry | `AbortController` timeout; no infinite loading |
| Bad/unsafe model JSON | **Couldn't format explanation** / Retry | Strict runtime schema checking; safe text fallback only if valid |
| TTS no voice | **Voice not available on this device** | Detect before promising playback |
| TTS ended/error | Stop spinner, enable Replay | TTS event/error handling |
| PDF scanned only | **This PDF appears image-only** | Don't present phantom selectable text |
| PDF password/encryption | Password flow if supported or explain limitation | Avoid leaking password in logs |
| Selection over 2,000 characters | **Selection too long** / Use the first 2,000 characters | Show trimmed text before sending |
| Site access not granted | No automatic toolbar; context menu and toolbar icon still work; Settings shows **Enable on websites** | Never re-prompt for permission without a user gesture |
| Unsupported page | **This page doesn't allow the extension** | No continuous injection attempts |

## 8. Security abuse cases / misuse controls

1. **Malicious webpage tries to capture key:** impossible through intended boundaries because key lives only in trusted extension contexts; validate all inbound messages and never return the key.
2. **Prompt injection in selected text:** pass it as untrusted quoted context; fixed system instruction prohibits obeying instructions embedded in source material; never request powerful browser actions from model output.
3. **Selected private data:** default to no collection from editable fields; show explicit external-send disclosure; avoid raw-content persistence/logging.
4. **PDF with malicious links or scripts:** disable PDF scripting (`isEvalSupported: false`, no JavaScript actions) and confirm before opening external links; keep PDF.js patched.
5. **Service worker restarted mid-request:** result discarded with clear retry; no duplicate unexpected AI requests.
6. **Model output appears to be HTML/script/Markdown injection:** render as plain text only; never `dangerouslySetInnerHTML` with untrusted output.
7. **Excessive token use:** selected/context character and token ceilings, sensible `max_completion_tokens`, one request per Explain plus at most one per opened tab, no automatic tab prefetching.
8. **Lazy-loaded UI used to fingerprint the extension:** any extension file exposed to pages via `web_accessible_resources` uses `use_dynamic_url: true` and is limited to what the content script loads.

## 9. Verification test matrix

| Dimension | Required fixtures |
| --- | --- |
| Web DOM | Static article; complex CSS; iframes with permitted access; mixed RTL; long text; dense fixed header; mobile-ish viewport |
| Selection | Word, phrase, sentence, paragraph, keyboard, double-click, triple-click, nested inline elements, punctuation, collapsed selection |
| Semantic | Polysemous words (`bank`), idioms (`break the ice`), technical term, no etymology known, uncommon name, ambiguous sentence |
| Site access | Granted at onboarding, declined (context menu + toolbar icon), granted later from Settings, revoked |
| Speech | Word, long sentence, Stop/Replay, rapid repeat, `en-US`, `en-GB`, no `chrome.tts` voice (Linux), offscreen fallback, no unsupported accent promise |
| PDF | Local text, multi-page, multi-column, rotated page, zoom, password protected, corrupted, scan-only, large file (100+ pages) |
| API | Good key, bad key, missing model, 400, 401, 403, 404, 429, 500, offline, malformed output, timeout, service worker stop |
| Security | Key storage boundary, HTML injection, prompt injection, oversized messages, corrupt PDF, unexpected runtime sender |
| Usability | Keyboard-only, screen reader, reduced motion, 200% zoom, narrow screen, error recovery |

### Platform matrix (D-14)

The team can test **Linux only** by hand. Other platforms get automated coverage where possible, and voice claims are limited to what was actually verified.

| Platform | Coverage | What it proves |
| --- | --- | --- |
| Linux, latest Chrome Stable, with `speech-dispatcher` + a voice engine (e.g. `espeak-ng`) installed | Manual + automated E2E (primary dev machine) | Full feature set; `chrome.tts` playback path |
| Linux, latest Chrome Stable, **without** `speech-dispatcher` | Manual | No-voice message and the offscreen `speechSynthesis` fallback (D-07) |
| Windows, latest Chrome Stable | Automated E2E on CI runners (non-voice flows) | Install, site access, selection, Explain with mocked Groq, PDF reader |
| macOS, latest Chrome Stable | Automated E2E on CI runners (non-voice flows) | Same as Windows |
| Minimum supported Chrome (147, D-18) | Automated smoke test with a pinned [Chrome for Testing](https://googlechromelabs.github.io/chrome-for-testing/) build | APIs used exist at the declared `minimum_chrome_version` |
| ChromeOS | Not tested | No claims made |

**Voice on Windows/macOS** is unverified until a person checks it. Before the listing is made **public** (trusted-tester distribution is fine earlier), at least one manual pass of the release smoke test must run on Windows or macOS, for example by a trusted tester. Until then, the listing and UI must not claim specific voices or accents on those systems.

## 10. Release gates and change process

### Launch blockers

- All **Must** requirements implemented and reviewed with recorded evidence.
- Unpacked and release ZIP tested in a clean Chrome profile per the [platform matrix](#platform-matrix-d-14), including the manual Windows/macOS pass required before public visibility.
- Groq model used in settings is actually available; failures render accurately.
- Security/privacy review and public privacy policy completed.
- The extension does not falsely claim to work inside Chrome's built-in PDF viewer.
- Any absent TTS voice is handled without a dead button.
- Store permission rationale, screenshots, description, data-handling disclosures, and demo instructions for reviewers are accurate.

### Post-launch change control

- Add/change requirement ID; record priority and acceptance condition.
- Update associated diagram/contract in `architecture.md`.
- Record dependency/SDK and permission changes in `tech-stack.md`.
- Insert implementation/testing/release work in `execution-phases.md`.
- Reassess Web Store privacy disclosures whenever a new provider, telemetry function, sync service or site permission is introduced.

## 11. Product decisions

### Resolved (2026-10-22)

| ID | Decision | Rationale | Affects |
| --- | --- | --- | --- |
| D-01 | Product name is **Clavis** | Replaces the working name "Context Reader" | All docs, manifest, listing |
| D-02 | **Site access:** declare `http://*/*` and `https://*/*` as `optional_host_permissions`; request them in one onboarding step; on grant, register the content script at runtime with `chrome.scripting.registerContentScripts`. If declined, use `activeTab` + context menu / toolbar icon to inject into the current tab on demand | Automatic toolbar for users who want it, a clear prompt rather than an install-time warning, lighter store-review profile than mandatory broad access, and a working fallback for privacy-conscious users | FR-009, FR-010, FR-015, FR-018; architecture §3 |
| D-03 | **Remote PDF URLs deferred** to post-v1 | Host permissions, CORS, redirects and SSRF controls add cost; local files cover the core need | FR-058; Phase 7 |
| D-04 | **Saved vocabulary/history deferred** to post-v1 | Not needed to prove the core value; avoids storage, export and deletion UI in v1 | FR-019, FR-079 |
| D-05 | **Core + lazy tabs:** Explain makes one request returning contextual meaning, definition and 2 examples. Roots, Related words and Simplify (Must) and Grammar, Translate (Should) each make one request only when their tab is opened, cached in memory for that selection | Fewer requests on free-tier rate limits, faster first answer, fewer prompts to regression-test at launch | FR-030 … FR-038; architecture §4, §6 |
| D-06 | **PDF reader uses PDF.js viewer components** (`pdfjs-dist/web/pdf_viewer`: `PDFViewer`, `EventBus`, `PDFLinkService`, `PDFFindController`) inside a React shell | Provides virtualization, aligned text layer, zoom and find out of the box; cuts Phase 7 effort substantially | FR-051 … FR-059; architecture §8 |
| D-07 | **Voice:** `chrome.tts` first; Web Speech fallback in an **offscreen document** (and directly in the reader page), adopted only if Spike D proves it works per OS | Offscreen documents are the MV3 way to use DOM audio APIs from the background; Linux often lacks `chrome.tts` voices | FR-020 … FR-025; architecture §7 |
| D-08 | **Content-script budget:** a framework-free selection observer is the only always-loaded code. **Outcome of Spike B: option (c)** — a Preact toolbar bundled in the observer (11.8 KB gzip); the explanation card loads on the first Explain | React's parse/evaluate cost, not the loading mechanism, dominated: lazy React (a/b) measured ~230 ms first-toolbar p95 and 69 KB gzip, over both budgets; (c) measured 60 ms p95 at normal CPU ([spike-b-toolbar.md](decisions/spike-b-toolbar.md)) | Tech stack §6; architecture §5 |
| D-09 | **Model defaults set from Spike A measurements.** Candidates: `openai/gpt-oss-20b` (quick), `openai/gpt-oss-120b` (deep); these are reasoning models, so test `reasoning_effort` and the completion-token budget, and compare at least one fast non-reasoning model available to the account | Reasoning tokens add latency and consume `max_completion_tokens` | Architecture §6; tech stack §7 |
| D-10 | **Model output is plain text only**; no Markdown rendering in v1 | Removes a sanitizer dependency and an XSS surface | FR-041 |
| D-11 | **UI strings go through `chrome.i18n`** from day one; v1 ships English | Avoids a later string-extraction refactor | NFR localization |
| D-12 | **Documentation conventions:** kebab-case filenames; each rule written once in its normative home (see [README](README.md#documentation-map)) | Prevents drift between documents | All docs |
| D-13 | **License: MIT** | Simple and permissive; compatible with PDF.js (Apache-2.0), whose license and notices must still ship with the bundled files | `LICENSE`; third-party notices in Phase 10 |
| D-14 | **Platform matrix:** Linux tested by hand; Windows/macOS covered by automated E2E only; voice claims limited to verified systems; one manual Windows/macOS pass required before public listing | Only Linux hardware is available | [§9 Platform matrix](#platform-matrix-d-14); release gates |
| D-15 | **Privacy policy hosted on GitHub Pages**; text drafted in `docs/privacy-policy.md` | Free, versioned with the repo | Needs a GitHub repo with Pages enabled (public repo, or a plan that allows Pages on private repos) before Phase 10 |
| D-17 | **CSP allows WebAssembly on extension pages:** `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` | PDF.js needs wasm for ICC/CMYK colour, JPEG 2000 and JBIG2; the default MV3 CSP blocks it ([spike-c-pdf.md](decisions/spike-c-pdf.md)). `eval` stays blocked; no remote code | Manifest; ZIP audit requires this exact CSP |
| D-18 | **Minimum Chrome version 147** | pdfjs-dist 6 uses `Math.sumPrecise` (Chrome 147) without a fallback; other floors: `Uint8Array` base64 140, `Promise.try` 128, `URL.parse` 126, `matchOriginAsFallback` 119 (MDN browser-compat-data 8.1.7). The alternative, PDF.js's polyfilled legacy build, is larger | Manifest; platform matrix; ZIP audit |
| D-16 | **Disclosure copy approved** as written in [§4.1](#approved-disclosure-copy-fr-002-fr-009-fr-071) | Defines exactly what users see before anything is sent to Groq | Onboarding, first Explain, settings |

### Still open

| Item | When needed | Notes |
| --- | --- | --- |
| Publisher display name and support email | Phase 10 (store submission) | Placeholders until then; the privacy policy draft uses `[PUBLISHER]` / `[SUPPORT_EMAIL]` |
| Logo and store artwork | Phase 10 | Placeholder icons are fine through Phase 9 |
| GitHub repository + Pages URL for the privacy policy | Before Phase 10 | No remote exists yet (D-15) |
| Voice fallback adoption per OS | Needs the user's manual check | Spike D found 0 voices in both engines on this Linux machine; keep the offscreen fallback and `offscreen` permission only if it finds voices `chrome.tts` misses ([spike-d-voices.md](decisions/spike-d-voices.md)) |
| Default models | Needs the user's run of the comparison script | Spike A (D-09); command in [spike-a-groq.md](decisions/spike-a-groq.md) |
| Explanation card technology and budget | Phase 5 | A React card cannot fit the 60 KB lazy-UI budget: author it in Preact or load React only on the first Explain via background injection, and set its own budget |
| Windows/macOS manual tester | Before public listing | D-14 |

## References

- Chrome permissions: <https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions>
- Chrome privacy/policies: <https://developer.chrome.com/docs/webstore/program-policies/policies>
- Chrome TTS: <https://developer.chrome.com/docs/extensions/reference/api/tts>
- Groq models / rates: <https://console.groq.com/docs/models> · <https://console.groq.com/docs/rate-limits>
- PDF.js: <https://github.com/mozilla/pdf.js>

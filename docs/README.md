# Clavis — AI-powered reading companion

> **Product name:** Clavis (decided — D-01). Logo, publisher name and support channel are still TBD.  
> **Platform:** Google Chrome, Manifest V3.  
> **Release target:** v1.0 — bring-your-own-Groq-API-key, no proprietary backend.  
> **Documentation baseline:** 22 October 2026. Recheck vendor APIs and store policies at release time.

Clavis is a Chrome extension that helps readers understand **highlighted words, phrases, sentences, and short passages** on ordinary webpages and in a **custom PDF reader**. When the reader selects text, a compact floating toolbar appears. The user can **listen immediately** (without an AI call), or choose an explanation action such as **meaning, contextual meaning, usage scenarios, etymology, synonyms/antonyms, translation, grammar breakdown, or simplification**.

The product's single purpose is **helping users understand what they read, in context**. It is **not** an autonomous page scraper, a universal PDF replacement, or a paid hosted chatbot.

## Documentation map

| File | Read it for |
| --- | --- |
| **[README.md](README.md)** | Product overview, developer quick-start, everyday workflows, release overview |
| **[requirements.md](requirements.md)** | Scope, user stories, numbered functional requirements, acceptance criteria, privacy and quality gates |
| **[architecture.md](architecture.md)** | Component boundaries, message contracts, data flows, security model, PDF/TTS/AI design |
| **[tech-stack.md](tech-stack.md)** | Approved libraries and APIs, installation commands, dependencies, trade-offs, pinning strategy |
| **[execution-phases.md](execution-phases.md)** | Ordered implementation milestones, task lists, tests, deliverables, dependencies and launch checklist |
| **[backlog.md](backlog.md)** | Progress tracker: delivery order, requirement checklist with status, risk register |
| **[privacy-policy.md](privacy-policy.md)** | Draft public privacy policy (to be published on GitHub Pages) |

**Authority order if documents conflict:** `requirements.md` defines behavior and launch scope; `architecture.md` defines interfaces and boundaries; `tech-stack.md` defines implementation choices; `execution-phases.md` defines delivery order. Update all affected files whenever a decision changes.

**Single source of truth.** Each rule is written in full in exactly one place; other files link to it instead of restating it, so the documents cannot drift apart.

| Topic | Normative home |
| --- | --- |
| Product decisions (D-01 … D-19) | [requirements.md §11](requirements.md#11-product-decisions) |
| Scope, priorities, acceptance tests, selection limits | [requirements.md](requirements.md) §2–§4 |
| Manifest permissions and site-access model | [architecture.md §3](architecture.md#3-extension-entry-points-and-message-routes) |
| Message and data contracts | [architecture.md §4](architecture.md#4-shared-domain-objects-and-boundaries) |
| API-key storage and secret boundary | [architecture.md §9](architecture.md#9-persistence-privacy-and-telemetry) |
| Libraries, versions, budgets | [tech-stack.md](tech-stack.md) |
| Delivery order, gates, launch checklist | [execution-phases.md](execution-phases.md) |
| Progress status and risks | [backlog.md](backlog.md) |
| User-facing disclosure wording | [requirements.md §4.1](requirements.md#approved-disclosure-copy-fr-002-fr-009-fr-071) |
| Supported platforms and test coverage | [requirements.md §9](requirements.md#platform-matrix-d-14) |

## Product promise

- **Highlight and understand:** selection-aware tooltip explains words, expressions, sentences and short paragraphs.
- **Meaning in context:** capture only a small amount of surrounding text needed to disambiguate the selection (e.g., *bank* beside a river vs. a financial institution).
- **Hear it aloud:** one-tap playback for a selected word **or full sentence**; normal/slow speed; voices and language preferences where installed voices permit them.
- **Go deeper:** definitions, lexical usage, synonyms/antonyms, etymology and roots, examples, grammar, translation and plain-language rewrites.
- **Read PDFs privately:** open a local PDF file in an extension-owned PDF.js reader. Files are rendered in the browser and never uploaded. Opening remote PDF URLs is planned for after v1 (D-03).
- **User-controlled AI cost:** each user supplies a GroqCloud API key; Groq's own usage limits and terms apply. There is no guarantee of unlimited free usage.
- **Explicit AI requests:** selection alone never sends page or document contents to Groq.

## Product experience

### First-run onboarding

1. Install the extension from the Chrome Web Store or load a local development build.
2. Open the welcome screen; explain what the extension reads and when content is sent to a third party.
3. **Site access (D-02):** one clear step asks the user to *Enable Clavis on websites*, which triggers Chrome's permission prompt for all http/https sites. If the user declines, Clavis still works on demand: right-click **Explain with Clavis**, or click the toolbar icon on the current tab.
4. Select **GroqCloud** (only provider in v1) and follow a **Get an API key** link to <https://console.groq.com/keys>.
5. Paste the key into the **extension-owned** setup page, choose persistent-on-this-device or session-only storage, and click **Test connection**. Never paste an actual key into a webpage or a public chat.
6. Select an available Groq model. Defaults are chosen from Phase 2 measurements (D-09); candidates are `openai/gpt-oss-20b` (quick) and `openai/gpt-oss-120b` (deep), **only if returned as available to this account**.
7. Pick preferred explanation language, voice/accent where available, playback speed, and tooltip behavior.
8. Complete a guided demonstration on a bundled practice page: select a word, click **Listen**, click **Explain**, and review the answer.
9. Open a PDF using **Open PDF** in the extension (file picker or drag-and-drop).

**Setup does not require an account with the extension developer.** A user may postpone Groq setup and still use offline features such as PDF reading and text-to-speech where a voice is available.

### Webpage workflow

1. User selects text with mouse or keyboard in a supported webpage.
2. A nonintrusive toolbar appears close to the selection; its placement adjusts around the viewport and never covers the text where practical.
3. **Listen** plays selected text immediately via native TTS; **Explain** opens the explanation card or side panel.
4. On **Explain**, the extension extracts a short context snippet and asks the background service worker to make **one core request** to Groq (D-05). The core answer contains the meaning in context, a plain definition and two examples.
5. The core answer appears immediately. Extra tabs — **Roots**, **Related words**, **Simplify** and, if enabled, **Grammar** and **Translate** — each make their own request **only when the user opens them**. Only tabs relevant to the selection kind are shown. A selected sentence can also be read aloud.
6. User may copy an answer or retry on errors. Clicking outside, pressing Escape, or clearing the selection dismisses the tooltip.

### PDF workflow

1. User opens **Open PDF** and selects a local file or drags a PDF into the reader.
2. The extension launches its own **extension-origin reader tab**, built on the bundled PDF.js viewer components (D-06), with page rendering, navigation, zoom, find-in-document and a selectable text layer.
3. Highlighting works on the rendered text layer and invokes **the same analysis and pronunciation actions** as webpages.
4. Only the selected text and bounded context are sent to Groq after an AI action; the PDF itself is never uploaded.
5. PDF.js errors, encrypted PDFs, scanned pages without text and malformed documents are communicated clearly.

**Why a custom PDF reader?** Chrome's built-in PDF viewer is not a normal HTML page that content scripts can reliably decorate. v1 **does not promise** a tooltip inside Chrome's native PDF viewer; the document must be opened in Clavis's reader. No browser-wide PDF hijacking in v1.

## Feature scope and status

| Capability | v1 | Later |
| --- | :---: | :---: |
| Chrome MV3 extension, onboarding and settings | Yes | |
| User-supplied Groq API key, validation, model selection | Yes | |
| Highlight + tooltip on HTTP(S) webpages the user has granted access to | Yes | |
| On-demand Explain via context menu / toolbar icon when site access is declined | Yes | |
| Explain selected word/phrase/sentence/short paragraph | Yes | |
| Core explanation (meaning in context + definition + examples) | Yes | |
| Roots, related words, simplification (loaded per tab) | Yes | |
| Grammar analysis and translation | Should | |
| Word and sentence pronunciation using available voices | Yes | |
| Local PDF.js reader, selection, zoom, virtualized pages | Yes | |
| PDF find-in-document | Should | |
| Remote PDF URLs / "Open in Clavis" on PDF links | | Yes (D-03) |
| Local saved vocabulary/history with delete/export | | Yes (D-04) |
| Saved IPA / recorded dictionary audio | Optional | Rich phonetics |
| OCR for image-only scans | | Yes |
| OpenRouter, Gemini, Cerebras, etc. | | Yes |
| Automatic interception of every browser PDF | | Evaluate later |
| User accounts, billing, backend sync, team features | | Only if justified |

v1 must not advertise features that are unsupported on particular sites or voice configurations. See the precise **Must/Should/Could** classification in `requirements.md`.

## Proposed repository layout

```text
Clavis/
├── LICENSE                            # MIT (D-13)
├── package.json
├── package-lock.json                  # or other committed single lockfile
├── wxt.config.ts
├── tsconfig.json
├── public/
│   ├── _locales/en/messages.json      # all UI strings (chrome.i18n), English in v1
│   ├── icon/
│   └── pdf-assets/                    # if required by pinned PDF.js version
├── entrypoints/
│   ├── background.ts                  # MV3 service worker; secrets and Groq
│   ├── content.ts                     # tiny selection observer (no framework)
│   ├── offscreen/                     # speechSynthesis fallback, if Spike D adopts it
│   ├── popup/                         # browser-action launcher
│   ├── options/                       # provider, privacy, voice settings
│   ├── onboarding/                    # first-run tutorial
│   ├── sidepanel/                     # long-form explanation
│   └── reader/                        # extension-owned PDF viewer page
├── components/
│   ├── tooltip/
│   ├── explanation/
│   ├── reader/
│   └── common/
├── lib/
│   ├── ai/                            # Groq adapter; provider interface
│   ├── context/                       # selection, bounded context, cleanup
│   ├── contracts/                     # typed messages and Zod schemas
│   ├── pdf/                           # PDF.js adapter, text-layer integration
│   ├── speech/                        # chrome.tts driver / fallback detection
│   ├── security/                      # storage, redaction, validation
│   └── storage/                       # settings and optional saved items
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/                      # safe public/test HTML and PDF files
└── docs/
    ├── README.md                      # this file
    ├── requirements.md
    ├── architecture.md
    ├── tech-stack.md
    ├── execution-phases.md
    ├── backlog.md                     # status tracker and risk register
    ├── privacy-policy.md              # draft; published on GitHub Pages
    ├── release-checklist.md
    └── decisions/                     # spike findings and later ADRs
```

> This is the **target layout**, not a claim that code already exists. WXT generates the manifest during build; do not maintain a conflicting handcrafted `manifest.json` in source. The selection toolbar and explanation card live under `components/tooltip/` and `components/explanation/` and are loaded lazily by the content script (see [tech-stack.md §6](tech-stack.md#6-frontend-design-and-component-boundaries)).

## Developer quick-start (once implementation begins)

### Prerequisites

- Latest stable Chrome; pin a supported minimum Chrome version after implementation tests.
- Recent supported Node.js LTS and npm (or one consistently chosen package manager).
- Git and an editor with TypeScript support.
- A **personal test-only Groq key**; never commit credentials or place a real key in test fixtures.

### Bootstrap

```bash
npx wxt@latest init
# Choose: a project name, React, TypeScript, npm (or your preferred manager)
cd <project-directory>
npm install
npm run dev
```

WXT opens a development browser in supported configurations; alternatively use Chrome's `chrome://extensions` -> **Developer mode** -> **Load unpacked** and select the generated Chrome MV3 output. See the exact build output shown by WXT for the installed version.

After features are implemented:

```bash
npm run build          # production build in .output/chrome-mv3
npm run zip            # store ZIP in .output/
npm run check          # typecheck, lint, format check, unit tests
npm run e2e:install    # once: download Playwright's Chromium
npm run test:e2e       # load the built extension in Chromium and smoke-test it
npm run ci             # everything CI runs: check, build, size, zip, audit, secret scan
```

The ZIP is the Chrome Web Store artifact; the release pipeline should verify that the ZIP contains bundled PDF.js workers/assets and **no** API keys, source maps with private material, `.env` files, or remotely loaded executable scripts.

### Environment and configuration policy

- **Do not** put Groq keys in `.env`, frontend compile-time variables, or git for the user-facing product.
- The user's key is entered at runtime in the extension options; storage rules are in [architecture.md §9](architecture.md#9-persistence-privacy-and-telemetry).
- Model IDs and provider endpoints are centrally configured, **not** duplicated across UI components.
- Bundle JavaScript and PDF.js workers with the extension; API calls over HTTPS are allowed, downloaded executable code is not.

## Baseline engineering conventions

- TypeScript `strict` on; input/output contracts runtime-validated.
- Internal extension messages are versioned, typed, checked for sender trust where relevant, and minimal.
- Keep keys and authorization headers out of content scripts, rendered HTML, logs and analytics.
- Model output is plain text only — no HTML, no Markdown rendering in v1. Display it through normal React text nodes.
- Keep prompts short and bound context size; webpage content can contain prompt-injection text, so treat it as **untrusted source data**.
- One request per intentional AI action; debounce selection-only UI updates but do not submit automatically.
- The content script stays tiny: a framework-free selection observer always runs, and the toolbar UI is loaded only on the first qualifying selection, inside a Shadow DOM root.
- PDF page virtualization comes from the PDF.js viewer components; do not hand-roll page lifecycle code.
- All user-visible strings go through `chrome.i18n` from day one, even though v1 ships English only.
- Accessible by keyboard; honor reduced motion; cleanly remove injected UI on navigation.

## Known limitations to communicate to users

1. **Restricted pages:** Chrome Web Store, `chrome://` pages, some embedded/closed-shadow/complex editors, and Chrome's built-in PDF viewer may not allow standard injection.
2. **Site access:** if the user declines the all-sites permission, the toolbar does not appear automatically; Explain is available from the right-click menu or the toolbar icon instead.
3. **Voice availability:** Native voices vary by OS and installed speech engines; Linux often has no working `chrome.tts` voice. Detect and report the absence, and use the Web Speech fallback only where verified (D-07).
4. **PDF text layer:** A scanned image has no selectable text until OCR is implemented; malformed or encrypted PDFs need specific handling.
5. **PDFs opened elsewhere:** a PDF opened in Chrome's own viewer (from a link or `file://`) cannot show the toolbar; download it and open it in the Clavis reader. Opening remote URLs directly is planned after v1.
6. **Groq quotas:** Free-tier models and account limits change. Handle 401/403/404/429/5xx and invalid key, unavailable model, connection failure or exhausted quota gracefully.
7. **AI reliability:** Definitions and etymologies can be wrong or overly certain. Label generated explanations clearly and avoid presenting them as authoritative references.

## Testing and release overview

- **Unit:** selection normalization, positioning calculations, request shaping, JSON validation, storage behavior.
- **Integration:** messaging, permission flow, background fetch, failures, TTS detection/cancel, PDF.js text mapping.
- **Browser E2E:** multiple real DOM layouts, keyboard selection, viewport edges, navigation, long selection, granted vs. declined site access, local PDFs, Windows/macOS/Linux voices where practical.
- **Security:** no automatic content exfiltration, key never in content scope, no HTML injection, permission minimums, zero remote executable scripts.
- **Compliance:** prominent privacy disclosure, public privacy policy, publisher identity/contact information, permission justifications and truthful Web Store listing.
- **Publication:** register Chrome Web Store developer account, pay current one-time registration fee if applicable, enable 2-Step Verification, upload ZIP, submit for review, answer reviewer requests, then publish. Reviews often take days but can run weeks; allow contingency.

**Definition of done:** every v1 Must requirement passes its acceptance test; privacy and permission declarations match actual behavior; the unpacked extension and the packaged ZIP both work; PDF and voice failure fallbacks are honest; a reviewer can understand how the extension operates without developer-only credentials.

## Source of truth / vendor documentation

- WXT: <https://wxt.dev/guide/installation> · <https://wxt.dev/guide/essentials/config/manifest>
- Chrome extension architecture/permissions: <https://developer.chrome.com/docs/extensions/develop> · <https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions>
- Chrome TTS: <https://developer.chrome.com/docs/extensions/reference/api/tts>
- PDF.js: <https://github.com/mozilla/pdf.js> · <https://mozilla.github.io/pdf.js/api/>
- Groq API: <https://console.groq.com/docs/api-reference> · <https://console.groq.com/docs/rate-limits>
- Store policies/review: <https://developer.chrome.com/docs/webstore/program-policies/policies> · <https://developer.chrome.com/docs/webstore/review-process>

## License / branding

Clavis is licensed under the **MIT License** (see [`LICENSE`](../LICENSE), D-13). The product name is **Clavis**; artwork, publisher name, developer email and support channel are placeholders until Phase 10. The privacy policy will be published on GitHub Pages (D-15). Third-party libraries and any bundled PDF.js assets remain subject to their respective open-source licenses and attribution obligations.

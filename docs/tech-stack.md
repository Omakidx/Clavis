# Technology stack and implementation standards — Clavis

**Document status:** v1 baseline (rev. 1.1 — decisions D-01 … D-12; Phase 0 adds D-13 … D-16 in requirements.md), 2026-10-22  
**Goal:** stable, low-cost, Chrome-native extension with local PDF rendering, Groq BYOK, accessible UI and no mandatory server.  
**Related:** [README.md](README.md) · [requirements.md](requirements.md) · [architecture.md](architecture.md) · [execution-phases.md](execution-phases.md)

## 1. Stack overview

| Layer | Selected technology | Purpose | Why selected |
| --- | --- | --- | --- |
| Extension platform | Chrome Manifest V3 | Browser permissions, lifecycle, packaging | Chrome Web Store standard |
| Extension framework | **WXT** | Multiple entrypoints, MV3 manifest generation, build/zip workflow | Removes manifest/build boilerplate; supports React and TS |
| Language | **TypeScript, strict mode** | Compile-time correctness | Shared request contracts for content, PDF and background |
| UI | **React** | Onboarding, settings, reader, side panel, explanation card | Reusable compositional UI |
| On-page toolbar | React chunk loaded lazily, or **Preact** if Spike B measurements require it (D-08) | Selection toolbar on websites | Keeps always-loaded page weight minimal |
| Selection observer | **Plain TypeScript**, no framework | Always-loaded content script on granted sites | Smallest possible footprint |
| CSS | **Tailwind CSS** + CSS variables | Styling and responsive design | Efficient and themeable; scope on-page styles via Shadow DOM |
| UI primitives | **Radix UI or shadcn/ui (selectively)** | Dialogs, tabs, popovers and a11y patterns | Avoid custom keyboard/focus logic for every control |
| Icons | **Lucide React** | Lightweight consistent iconography | Tree-shakeable components |
| Validation | **Zod** | Runtime schemas for messages and AI output | Defensive extension boundaries |
| PDF parser/renderer | **Mozilla PDF.js (`pdfjs-dist`)** core + **viewer components** (`pdfjs-dist/web/pdf_viewer`) | Rendering, virtualization, text layer, zoom, find (D-06) | Mature standard; do not build parser or page lifecycle from scratch |
| TTS | **Chrome `chrome.tts`** | Native word and sentence speech | No Groq cost; extension-specific control |
| Voice fallback | **Web Speech `speechSynthesis`** in a **`chrome.offscreen`** document (webpages) or directly in the reader page, only where Spike D confirms audio (D-07) | Fallback when `chrome.tts` has no voice | The service worker has no DOM |
| AI provider | **GroqCloud Chat Completions API** | Context explanation and language operations | User-supplied key; OpenAI-compatible interface |
| Storage: key/settings | **Chrome Storage API** | Local/session key and preferences | Built-in extension persistence |
| UI strings | **`chrome.i18n`** with `public/_locales/en/messages.json` | All user-visible text (D-11) | Built in; enables later UI translation |
| Unit/component tests | **Vitest** + React Testing Library | Logic and UI state | Fast tests |
| Browser E2E | **Playwright** with Chromium extension profile | Chrome-specific end-to-end flow | Test real content scripts, messaging, PDF and popup |
| Formatting/lint | **ESLint, Prettier, TypeScript check** | Code quality | CI gate |
| Package management | npm with committed `package-lock.json` (suggested) | Reproducible builds | Simple developer onboarding |
| CI | GitHub Actions (optional but recommended) | Lint, test, build, ZIP artifact checks | Automatable release gate |
| Observability | Local redacted diagnostics; no third-party telemetry initially | Debug errors without user data collection | Privacy-first |
| Deployment | Chrome Web Store | Distribution/review | Browser-native extension updates |

**Server architecture:** **none for v1**. There is no custom database, hosting API, auth provider, secrets server, or paid inference proxy. Every user obtains their own Groq key. The **extension's privileged service worker** performs authorized requests directly to Groq over HTTPS. This is a product design choice, not a security claim that storing a user key locally is perfectly secure.

## 2. Version and compatibility policy

- Use current **Node.js LTS**, current stable Chrome and a pinned supported WXT release. Avoid inventing fixed version numbers that go stale.
- Set `engines.node` after installation and test it in CI; include `.nvmrc` if helpful.
- Use one package manager throughout; don't mix npm/pnpm/yarn lockfiles.
- Commit lockfile. Pin/lock major-sensitive dependencies such as PDF.js, WXT, React, Zod and browser-testing tools.
- Define `minimum_chrome_version` based on **actual APIs used**. Known floors: `chrome.sidePanel` 114+, `chrome.offscreen` 109+, `chrome.storage.session` and `setAccessLevel` 102+, `scripting.registerContentScripts` 96+. Newer methods may have higher minimums. Test and document a final minimum.
- Review dependencies/licenses each release, particularly PDF.js bundled worker and `cmaps` assets.
- Do not dynamically fetch JS/worker modules from CDN at runtime; bundle all executable extension code.

## 3. WXT bootstrap and scripts

Create React/TypeScript WXT extension:

```bash
npx wxt@latest init
# Choose React + TypeScript and npm during prompts
cd <generated-project>
npm install
npm run dev
```

At the time the project is implemented, WXT's default generated scripts should be verified. The following example is an **intended script convention**, not a guarantee of scaffold output:

```json
{
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "zip": "wxt zip",
    "typecheck": "tsc --noEmit",
    "lint": "eslint .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "postinstall": "wxt prepare"
  }
}
```

Reference: <https://wxt.dev/guide/installation>

## 4. Initial package recommendations

Install **after scaffold**; first review what the generated WXT project already includes:

```bash
# Core app libraries. Only add packages not already installed by the WXT template.
npm install pdfjs-dist zod lucide-react

# Optional UI primitives; install individual Radix packages only when needed.
# shadcn/ui is typically a component-generation workflow, not one monolithic runtime dependency.

# Tests (check compatible versions with scaffold React/TS/Vite)
npm install --save-dev vitest @testing-library/react @testing-library/user-event \
  @testing-library/jest-dom jsdom @playwright/test eslint prettier
```

**Do not add a third-party PDF UI framework.** `pdfjs-dist` already ships the viewer components (`pdfjs-dist/web/pdf_viewer.mjs` and `pdf_viewer.css`) that provide virtualization, text layer, zoom and find; build only the React shell around them (D-06).

Add `preact` only if Spike B selects it for the on-page toolbar (D-08).

### Libraries deliberately not required in v1

- **Next.js / server-rendered app frameworks:** not required inside an extension UI.
- **Firebase/Supabase/PostgreSQL:** no account/server syncing in v1.
- **Electron/Tauri:** browser extension, not desktop application.
- **Cloud TTS SDK:** native voice first; external audio would add cost and data processors.
- **Tesseract.js:** defer scanned-PDF OCR to a planned post-v1 milestone.
- **Markdown renderer / HTML sanitizer (DOMPurify, marked, etc.):** model output is plain text in v1 (D-10).
- **IndexedDB wrapper:** saved vocabulary is deferred (D-04).
- **Heavy state management library:** React state + feature-focused stores are sufficient for initial scope.
- **General AI agent orchestration library:** explanations are simple bounded inference calls, not a multi-tool autonomous agent.

## 5. WXT manifest outline

WXT generates a manifest from `wxt.config.ts` plus entrypoint definitions; don't duplicate `manifest.json` by hand. The following is **conceptual configuration** whose exact generated output must be reviewed:

```ts
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDescription__',
    default_locale: 'en',
    permissions: ['storage', 'tts', 'scripting', 'activeTab', 'contextMenus', 'sidePanel'],
    // 'offscreen' is added only if Spike D adopts the speechSynthesis fallback (D-07).
    host_permissions: ['https://api.groq.com/*'],
    optional_host_permissions: ['http://*/*', 'https://*/*'],
    action: { default_title: '__MSG_extName__' }
    // No static website content_scripts: the observer is registered at runtime
    // after the user grants site access (D-02).
  }
});
```

This is **illustrative**. Validate module availability and WXT config shape for the actual installed version; the normative permission list and site-access flow are in [architecture.md §3](architecture.md#3-extension-entry-points-and-message-routes). `sidePanel` is included only if the side panel ships.

## 6. Frontend design and component boundaries

| Component | Framework / location | Behavior |
| --- | --- | --- |
| `SelectionObserver` | Plain TS content script, always loaded on granted sites | Selection detection, snapshot, context extraction; loads the UI on first qualifying selection |
| `SelectionToolbar` | Lazily loaded UI under Shadow DOM (WXT shadow-root UI helper) | Anchored Explain/Listen, dismissal, a11y |
| `ExplanationCard` | Shared React component | Core answer, lazy tabs with per-selection cache, loading/error, copying |
| `ExplanationSidePanel` | Chrome Side Panel API page | Detailed responses, keyboard navigation |
| `OnboardingWizard` | Extension-owned onboarding page | Consent, site-access request, BYOK test, model choice, voice preferences |
| `OptionsPage` | Extension-owned options page | Key management, local/session setting, site access grant/revoke, per-site disable |
| `PDFReader` | Extension-owned tab | Local file opening; React shell around PDF.js `PDFViewer` |

### Content-script budget (D-08)

| Item | Target (revisit after Spike B) |
| --- | --- |
| Always-loaded observer | ≤ 15 KB gzipped; no framework; no work until a `selectionchange` |
| UI loaded on first qualifying selection | ≤ 60 KB gzipped including styles |
| First toolbar on a page | ≤ 150 ms p95 from selection end, including UI load |
| Later toolbars on the same page | ≤ 50 ms p95 |

Spike B picks the UI loading option (background injection, dynamic import, or bundled Preact toolbar) described in [architecture.md §5](architecture.md#5-end-to-end-selection-flow) by measuring against these targets.
| `PronunciationControl` | Shared React control | Listen, stop, replay, speed; read actual capability state |
| `ProviderStatus` | Options/popup | Valid-key status, current model, error resolution |

### CSS isolation

- Use Shadow DOM for webpage-injected interactive UI when practical; its styles should not cascade into publisher websites.
- Carefully scope portals and focus layers inside the shadow root. Avoid putting popovers outside the shadow root where website CSS can affect them.
- Avoid z-index extremes and pointer-blocking overlays over entire sites.
- Use `position: fixed`/viewport-aware calculations and `getClientRects()` for selection; handle viewport collision, transforms and zoom.
- Keep full reader/options/side panel styling in extension-owned pages, which don't need Shadow DOM isolation from websites.

## 7. AI inference integration

### Base URL and models

- Endpoint: `https://api.groq.com/openai/v1/chat/completions`.
- Model candidates **if currently available to the key**: `openai/gpt-oss-20b` quick; `openai/gpt-oss-120b` deep; plus at least one fast non-reasoning model for comparison. Defaults are fixed after Spike A (D-09).
- The gpt-oss models are reasoning models: test `reasoning_effort` support, keep reasoning text out of the UI, and size `max_completion_tokens` so reasoning cannot truncate the JSON answer.
- Discover models via documented model-list endpoint where feasible; reflect permission/rate-limit errors distinctly.
- **Free quota is account/model-specific and may change**. Provider status should link to <https://console.groq.com/docs/rate-limits>.

### Request shape and parsing

```ts
async function postGroq(input: unknown, apiKey: string, signal: AbortSignal) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok) throw new Error(`Groq HTTP ${res.status}`); // Replace with typed mapping.
  return res.json(); // Validate Zod schema before returning to UI.
}
```

**This function belongs only in a trusted extension context.** Never export `apiKey` to UI/content scripts. Use no `console.log(input)` if it contains selected text. Production version must implement timeouts, `Retry-After`, model capability detection and safe structured-output parsing.

### Structured output approach

- Define a compact JSON schema per explanation mode: one for `core` (contextual meaning + definition + 2 examples) and one per lazy tab (D-05).
- Prefer Groq's `response_format: { type: 'json_schema', ... }` when selected model supports it; only enable strict mode when supported.
- Otherwise use a supported JSON mode or text with explicit validation and errors. Do not assume schemas are universally supported by every model.
- Runtime-validate `title`, `summary`, `examples` length and optional mode fields. Limit answer display length. All fields are plain text; render them as text nodes, never as HTML or Markdown (D-10).
- Prompt must tell model not to follow instructions appearing in selected webpage/PDF text.
- Prefer explanation grounded in the supplied snippet; if context is insufficient, say so rather than inventing certainty.

Groq reference: <https://console.groq.com/docs/openai> · <https://console.groq.com/docs/structured-outputs>.

## 8. Text-to-speech and pronunciation

Use `chrome.tts` first:

```ts
async function speak(text: string, lang = 'en-US', rate = 1) {
  const voices = await chrome.tts.getVoices();
  if (voices.length === 0) {
    throw new Error('No native voice available on this device');
  }
  chrome.tts.stop();
  chrome.tts.speak(text, {
    lang,
    rate,
    enqueue: false,
    onEvent: event => {
      // Map start, end, cancelled and error events to UI states.
    },
  });
}
```

Actual language selection must match a compatible installed voice and may require voice-name selection to avoid misleading accent controls. Verify Chrome TTS `getVoices` behavior and ensure language fallbacks do not mispronounce text silently. **Chrome does not provide guaranteed native voices on every Linux distribution.** Test with actual installations.

**Fallback (D-07):** the service worker has no DOM, so `speechSynthesis` cannot run there. For webpage selections, create an offscreen document and speak from it:

```ts
// background — only if Spike D adopts the fallback for this OS
await chrome.offscreen.createDocument({
  url: 'offscreen.html',
  reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
  justification: 'Speak user-selected text when no chrome.tts voice is available',
});
// then message the offscreen page: { type: 'OFFSCREEN_SPEAK', text, lang, rate }
```

Only one offscreen document can exist at a time; reuse it and close it after a period of inactivity. The reader page can call `speechSynthesis` directly. `speechSynthesis.getVoices()` may also be empty on Linux, so the no-voice message must still exist. Native/system voices might rely on external components; avoid universal claims of fully offline speech.

Future improved word pronunciations could combine documented dictionary phonetics and licensed recordings. A sentence must still be spoken by TTS even when no recorded audio exists.

Chrome TTS: <https://developer.chrome.com/docs/extensions/reference/api/tts>

## 9. PDF.js implementation notes

**Choose PDF.js over writing your own PDF renderer.** PDF parsing, font layout, text mapping and page rendering are a large mature technical domain; custom-build only the reader **interface** and the selection/AI overlay.

### Core pipeline (D-06)

1. User provides a `File` via picker or drag-drop.
2. Read it as an `ArrayBuffer`; enforce file size and error limits.
3. Call `getDocument({ data, isEvalSupported: false })` with the **locally bundled** worker.
4. Create an `EventBus`, a `PDFLinkService` and a `PDFFindController`, then a `PDFViewer` bound to the reader's container element; call `pdfViewer.setDocument(doc)` and `linkService.setDocument(doc)`.
5. Drive page navigation, zoom/fit-width (`currentScaleValue = 'page-width'`), page count and find from the React shell through the viewer API and `EventBus` events (`pagechanging`, `scalechanging`, `pagesloaded`).
6. Observe selections in the viewer's text layer and build a `SelectionSnapshot` with the page number; use the shared Listen/Explain contract.
7. On close or file change: `pdfViewer.setDocument(null)`, `doc.destroy()`, release object URLs.

**Do not implement** raw PDF parsing, font encodings, page virtualization or OCR in v1. Import `pdf_viewer.css`, bundle fonts/cmaps assets when required, and keep the worker, core and viewer components on the exact same PDF.js version.

References: <https://github.com/mozilla/pdf.js/blob/master/docs/contents/getting_started/index.md> · <https://mozilla.github.io/pdf.js/api/> · viewer component examples: <https://github.com/mozilla/pdf.js/tree/master/examples/components>

### Remote PDFs (deferred, D-03)

v1 opens local files only. Remote URLs need site permission, CORS handling, redirects, size/time caps and private-network blocking; they move to the post-v1 backlog along with an "Open in Clavis" context-menu item for PDF links. Chrome's built-in PDF viewer stays out of scope.

## 10. State, persistence and request lifecycle

### Recommended state ownership

| Data | Owner |
| --- | --- |
| Current selection text and rect | Local webpage tooltip or PDF reader UI |
| TTS current playback state | `SpeechService` + status updates in UI |
| Current explanation response + loaded tab results | Tooltip/reader/side panel component, keyed by `selectionId` + mode; no cross-origin history |
| API request, rate-limit, model validation | Background service worker |
| Key, default model, voice preferences, site-disable list | Chrome trusted storage |

Do not use React Context as a cross-extension-process global store; content scripts, side panels and service workers are different execution contexts. Communicate with typed `chrome.runtime.sendMessage` (or long-lived port when justified), and be robust to service worker restart. Keep secrets out of any returned settings object.

### Concurrency rules

- Give every request a `requestId` and `selectionId`.
- New selection invalidates older results; only latest valid selection can show the response.
- Use `AbortController` for cancellable fetches where possible. Old service worker task may end unexpectedly; timeout UI requests.
- Bound retries, honor `Retry-After`, avoid duplicate billing or request loops.
- Opening an already-loaded tab for the same selection reuses the cached result; never prefetch tabs automatically.
- Decoding PDF pages must not block the reader's selection handler.

## 11. Quality gates and tooling

| Check | Tool | Gate |
| --- | --- | --- |
| Type safety | TypeScript strict | No TypeScript errors |
| Lint / code style | ESLint + Prettier | Required in PR/CI |
| Unit | Vitest | Key schema/selection/error modules tested |
| Component | Testing Library | Loading/error/keyboard actions tested |
| E2E | Playwright Chromium with unpacked MV3 extension | Core webpage and PDF journey passes |
| A11y | `axe-core` integration / manual keyboard and screen-reader pass | No major accessibility violations |
| Security | Package audit, manual key-boundary test, secret scanning | No critical leaks or unreviewed unsafe dependencies |
| Bundle size | Build-size report in CI | Content-script budget in §6 not exceeded |
| Build | `wxt build` / `wxt zip` | Correct packaged extension and bundled PDF.js assets |
| Store readiness | Chrome Web Store policy checklist | Accurate data, permission and code declarations |

**Automation caution:** Browser automation of MV3 extensions needs a persistent Chromium context and an extension-compatible profile/launch method. Test the actual Chrome/Playwright versions chosen; headless behavior and extension ID retrieval have version-specific limitations.

## 12. API key security implementation guidance

The rules are defined once in [architecture.md §9 — Secret boundary](architecture.md#secret-boundary-normative). Implementation notes:

- Put `setAccessLevel` in the first lines of `background.ts`, before any `runtime.onMessage` listener is registered.
- Keep all key reads in one module under `lib/security/` so code review can confirm nothing else touches the key.
- Add an integration test that runs `chrome.storage.local.get()` and `chrome.storage.session.get()` from a content script and asserts both fail or return nothing.

## 13. Permissions and Web Store compliance

Only declare capabilities that are implemented. The permission list and its rationale are in [architecture.md §3](architecture.md#3-extension-entry-points-and-message-routes). Because website access is an optional permission requested at onboarding (D-02), the install prompt shows no all-sites warning; the store listing and privacy policy must still explain what the optional access does.

**Policy rules:**

- A product with access to webpage text must provide a public privacy policy describing use, sharing, deletion and third-party AI processing.
- Only request text that is needed for the selected explanation feature; no silent collection or sale of browsing data.
- User must control when selected data is sent to Groq; show this in onboarding and the listing.
- Executable scripts/AI workflow code and PDF.js worker are shipped locally; remote API inference is permitted, remote executable code is not.
- Publisher should test installer and ZIP and provide reviewers access to critical functionality with a **review strategy that does not publish a real secret** (e.g., clear BYOK instructions and reviewer-safe documentation).

Store docs: <https://developer.chrome.com/docs/webstore/publish> · <https://developer.chrome.com/docs/webstore/program-policies/policies>.

## 14. Alternatives considered

| Alternative | Verdict | Reason |
| --- | --- | --- |
| Build PDF engine from scratch | Reject | Too much standards, font, decoding and security work |
| Depend entirely on Chrome native PDF viewer | Reject | Cannot reliably integrate floating selection overlay |
| External TTS service for every word | Defer | Introduces cost, additional data processors and latency |
| Put Groq key in popup/content script | Reject | Unnecessary exposure and easier leaks |
| Custom backend to proxy user's key | Defer | Adds cost and security responsibilities without solving v1 need |
| All-model router from launch | Defer | Increased QA and permissions burden; single provider requested |
| Manual copy/paste text only | Fallback | Worse UX than native selection but helpful on unsupported pages |
| Full-page text collection for context | Reject | Privacy risk and unnecessary token use |
| Chrome content scripts on all pages without disclosure | Reject | Misleading permissions and store risk |
| Mandatory broad `content_scripts` matches at install | Reject (D-02) | Install-time all-sites warning and heavier review; optional permission gives the same UX to users who grant it |
| Opt-in per site only | Reject (D-02) | Repeated prompts; poor UX for a reading tool used on many sites |
| Hand-built PDF page renderer on `pdfjs-dist` core | Reject (D-06) | Re-implements virtualization, text-layer alignment and find that the viewer components already provide |
| One Groq request per tab, all fetched on Explain | Reject (D-05) | Multiplies requests against free-tier rate limits |
| React in the always-loaded content script | Reject (D-08) | Adds page weight to every site, even when nothing is selected |

## 15. Engineering documentation conventions

- ADR changes require rationale and impact in `architecture.md`.
- Dependency changes must include security, licensing, bundle-size and compatibility checks.
- New endpoint, third-party processor or host permission triggers privacy-policy review.
- Every feature PR includes acceptance-test ID from `requirements.md` and milestone ID from `execution-phases.md`.
- Use feature flags for unfinished features; do not ship visible dead controls.

## Official references

- WXT: <https://wxt.dev/guide/installation> · <https://wxt.dev/guide/essentials/project-structure>
- Chrome extension APIs: <https://developer.chrome.com/docs/extensions/reference/api>
- Chrome side panel: <https://developer.chrome.com/docs/extensions/reference/api/sidePanel>
- Chrome storage: <https://developer.chrome.com/docs/extensions/reference/api/storage>
- Chrome permissions / scripting / offscreen / i18n: <https://developer.chrome.com/docs/extensions/reference/api/permissions> · <https://developer.chrome.com/docs/extensions/reference/api/scripting> · <https://developer.chrome.com/docs/extensions/reference/api/offscreen> · <https://developer.chrome.com/docs/extensions/reference/api/i18n>
- Chrome TTS: <https://developer.chrome.com/docs/extensions/reference/api/tts>
- PDF.js: <https://github.com/mozilla/pdf.js>
- Groq: <https://console.groq.com/docs/openai> · <https://console.groq.com/docs/rate-limits>
- Web Store review: <https://developer.chrome.com/docs/webstore/review-process>

# Phase 2 security review — findings and dispositions

**Date:** 2026-10-22 · **Scope:** all Phase 2 code on `phase-2-spikes` (site access, selection observer and toolbar, speech, Groq client, PDF reader, manifest, release audit) · **Method:** independent read-only review with local browser probes against scratch builds.

No Critical findings. Every finding below was either fixed in Phase 2 or turned into a Phase 3+ rule in [execution-phases.md](../execution-phases.md) ("Phase 2 follow-ups").

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| HIGH-1 | High (latent) | A web page could create a selection, find the toolbar through its open shadow root, `.click()` Explain, and read the card. Switching to a closed root alone is not enough: a page that pre-defines the custom host tag can reach the root through `ElementInternals`. Would allow silent AI requests on the user's key once Phase 5 wires Explain. | **Fixed in Phase 2:** plain (non-custom) host element, closed shadow root kept private, actions require trusted events, toolbar shown only after trusted user interaction; regression E2E. Phase 3 adds one in-flight AI request and a rate limit per tab. |
| MEDIUM-2 | Medium | Storage lockdown failed open: a rejected `setAccessLevel` resolved like success, so key routes "awaiting" it would proceed. | **Fixed in Phase 2:** `lib/security/storage-lockdown.ts` restricts local and session storage and resolves `true` only if both succeed; key routes must refuse on `false` (Phase 3 rule). Content-script storage denial to be E2E-tested on Chrome 147 (Phase 9). |
| MEDIUM-3 | Medium | Release audit didn't check most manifest keys (web-accessible resources, externally_connectable, sandbox…), didn't fail on the PDF.js scripting sandbox, missed protocol-relative and remote-wasm loading, and unknown file types only warned. | **Fixed in Phase 2:** manifest key allowlist, sandbox/quickjs file ban, extra remote-code patterns, strict mode in CI; build hook copies only known PDF.js asset types. |
| LOW-4 | Low | Prompt delimiter escaping could be bypassed with variants like `</selected_text x>`; context capture included some invisible text (opacity 0, zero size, clipped). | **Fixed in Phase 2** in `lib/ai/prompts.ts` and `lib/selection/context.ts`. Phase 5: never linkify model output. |
| LOW-5 | Low | The planned "any extension page" sender rule for key routes would include the reader (untrusted PDFs) and the offscreen page. | **Phase 3 rule:** key routes accept only `/options.html` and `/onboarding.html`. Longer term: consider sandboxing the PDF viewer. |
| LOW-6 | Low | `runtime.sendMessage` broadcasts reach every extension page. | **Phase 3 rule:** every listener validates type and sender and ignores unowned messages; the key never goes in a broadcast. |
| LOW-7 | Low | Groq fetch lacked `redirect: 'error'`, `credentials: 'omit'`, no-referrer, no-store; body read before the size cap. | **Fixed in Phase 2** in `lib/ai/groq.ts`. |
| LOW-8 | Low | No PDF page-count cap, `maxImageSize` or explicit `maxCanvasPixels`; PDF selection normalised before capping. | **Fixed in Phase 2** in `lib/pdf/`. |
| INFO | Info | PDF.js 6 needs newer Chrome than the declared minimum (`Math.sumPrecise` → 147). | **Fixed:** minimum raised to 147 (D-18). |
| INFO | Info | Id-less `TTS_STOP` from any tab stops all speech. | **Phase 6:** scope to the sender's tab. |
| INFO | Info | `'wasm-unsafe-eval'` applies to all extension pages and the service worker. | Accepted trade-off (D-17); the audit pins the exact CSP and bans remote wasm loading. |

**Verified sound by the review:** no static content scripts; optional host access requested only from the onboarding click; registration tracks the grant; message routers ignore unowned types and check senders; no HTML sinks; PDF.js loads from bytes with XFA, scripting and downloads off, confirmed external links only; Groq client never echoes provider bodies or the key; no network or background traffic on selection (FR-017); built ZIP has no eval, sandbox or remote code.

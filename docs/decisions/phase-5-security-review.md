# Phase 5 security review — findings and dispositions

**Date:** 2026-10-23 · **Scope:** explanation modes and prompts (prompt injection), `AI_EXPLAIN` incl. the first-send disclosure acknowledgement, `LOAD_EXPLAIN_CARD`, `OPEN_SETTINGS`, the capability cache, the separately loaded explanation card and its mount into the toolbar's closed shadow root (`phase-5-explain`) · **Method:** independent read-only review with Playwright probes against scratch builds (fake `gsk_TEST` keys, Groq intercepted).

No Critical, High or Medium findings. Model output is only ever rendered as text, every card action requires a trusted user event, the Phase 3 sender rules are intact, the disclosure acknowledgement is sender-gated and recorded once, and card injection is frame-precise.

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| L1 | Low (confirmed) | WXT's content-script context broadcasts a "content script started" `postMessage` containing the extension ID to the page (fingerprinting, contrary to architecture §10), and invalidates a script on a forged document event — a page could stop the observer and the card on itself; the card route then refused to re-inject. Observer part dates from Phase 4. | **Fixed in Phase 5:** started-message disabled; teardown only when the extension runtime is really gone; card route no longer remembers loaded documents (in-flight coalescing only); injection targets the sender's `documentId`. Regression E2E. |
| L2 | Low (confirmed) | The Copy fallback (hidden textarea + `execCommand`) let the page read the copied explanation and replace the clipboard while the card said "Copied"; a page could force the fallback. | **Fixed:** in-page fallback removed; Copy uses the async Clipboard API only and says when copying isn't available. |
| L3 | Low (hypothesis) | The first-send Confirm could be triggered by a held Enter key auto-repeating after focus moved to it, or by a disguised overlay. | **Fixed:** Confirm ignores activations for ~500 ms after the prompt appears (trusted events only, as before). |
| L4 | Low (hypothesis) | The look-alike bracket list in prompt escaping was incomplete. ASCII `<`/`>` were always escaped, so no literal breakout. | **Fixed:** per-request random 64-bit nonce in the delimiter tag names, named in the system prompt (the nonce is the boundary; escaping is defence in depth); list extended (U+02C2/3, U+1438/1433, U+2329/232A, U+276C–2771, U+29FC/D); eval fixture added. Guillemets « » are intentionally not escaped: they are ordinary quotation marks in several languages and the nonce already neutralises them. |
| INFO-1 | Info | Model output can carry page-steered persuasion or URL text, shown as plain text (never a link). | Accepted; output is plain text and labelled as AI-generated. |
| INFO-2 | Info | Any 400 matching the format pattern triggered the `json_object` fallback (cached 12 h), including `json_validate_failed`. | **Fixed:** `json_validate_failed` excluded. |
| INFO-3 | Info | Injection targeted `frameIds`, so a navigating frame could get the card in its next document. | **Fixed:** `documentIds` used when known. |
| INFO-4 | Info | The reader was allowed to send the acknowledgement before it has a card. | **Fixed:** removed until the reader card lands; **restored in Phase 7** when the reader started hosting the card. |
| INFO-5 | Info | Contract drift: comment and card accepted non-contract disclosure shapes. | **Fixed:** only `SETUP_REQUIRED` + `reason: 'disclosure'`. |
| INFO-6 | Info | Pressing Explain again on the same selection while loading cancelled and re-sent (Groq may bill the aborted call). | **Fixed:** an in-flight request for the same selection is kept. |
| INFO-7 | Info | A response arriving between clear-all and abort could re-persist one capability boolean. | Accepted (negligible). |
| Gap | — | No live Groq run of the injection fixtures (needs the user's key; `scripts/eval/explain-eval.ts`). | **Pending the user's eval run.** |

# Phase 3 security review — findings and dispositions

**Date:** 2026-10-22 · **Scope:** key lifecycle, storage, the single background router and its sender checks, settings/onboarding routes, onboarding/options/popup/practice UI, site-access lifecycle (`phase-3-onboarding`) · **Method:** independent read-only review with Playwright probes against scratch builds (fake `gsk_TEST` keys, Groq intercepted).

No Critical, High or Medium findings. All Phase 2 follow-ups that were due in Phase 3 were verified in place (key routes limited to `/options.html` and `/onboarding.html`, per-tab rate limit and one in-flight request, fail-closed lockdown, hardened Groq fetch, `TTS_STOP` scoped to the sender's tab), with no regressions.

| ID | Severity | Finding | Disposition |
| --- | --- | --- | --- |
| LOW-1 | Low | Injecting into already-open tabs (after a grant or on-demand → automatic) used `allFrames`, which ignores `excludeMatches`, and checked only the top frame's host without stripping a trailing dot — the observer could run in a disabled site's iframe or on `host.` until reload. Passive (nothing sent), but it breaks the FR-009 promise. | **Fixed in Phase 3:** open-tab injection targets the top frame only; hostnames normalised; regression E2E. |
| LOW-2 | Low | The UI client retried once on a missing reply, including for `AI_EXPLAIN` — a worker restart could cause a second paid call (abuse case 5). | **Fixed in Phase 3:** `retry: false` for `AI_EXPLAIN`; manual Retry instead. |
| LOW-3 | Low | A few-millisecond window between reading the key and registering the request as in flight, during which removing the key didn't cancel it. | **Fixed in Phase 3:** request registered before the key is read / key generation checked before calling Groq. |
| LOW-4 | Low | The controlled key input mirrored the typed key into the DOM `value` attribute. | **Fixed in Phase 3:** uncontrolled input, cleared after hand-over, `autoComplete="new-password"`. |
| INFO-1 | Info | Extension-page senders were classified by frame URL; an extension page framing `/options.html` reached key routes. | **Fixed:** extension senders must be the top frame. **Regression found in Phase 4:** the real toolbar popup has no tab and Chrome reports no `frameId` for it, so the first fix (`frameId === 0` always) rejected the popup's messages ("Status unavailable"); unit tests had modelled the popup with `frameId: 0`. Corrected: tab-less senders may omit `frameId`; the test helper now matches Chrome; the real-UI suite runs in CI. |
| INFO-2 | Info | `about:blank`/`about:srcdoc` senders classified as content without checking origin. | **Fixed:** origin checked. |
| INFO-3 | Info | `SET_API_KEY` goes out via `runtime.sendMessage`, which reaches every extension-page listener. | **Accepted:** every receiver is an equally privileged extension page; extension-page listeners must stay strictly allowlisted (only the offscreen listener exists and drops it). |
| INFO-4 | Info | `CLEAR_ALL_DATA` not serialised with key writes. | **Fixed:** routed through the key store's queue. |
| INFO-5/6/10 | Info | Copy: disabling applies on next page load; exact-host matching; IPv4 hosts couldn't be disabled; removing a key in Clavis doesn't revoke it at Groq. | **Fixed:** copy updated; IPv4 literals allowed. |
| INFO-7 | Info | Privacy policy URL is a placeholder. | **Phase 10.** |
| INFO-8/9 | Info | Spike-only `SPEECH_DIAGNOSE` route still live; offscreen listener accepts any tab-less extension sender. | **Fixed in Phase 6:** `SPEECH_DIAGNOSE` removed (replaced by `GET_VOICES` for Settings); the offscreen page accepts commands only from the service worker's URL. |
| Gap | — | A compromised reader page can read the key (it is a trusted extension context). | **Later:** consider running the PDF viewer as a sandboxed page. |
| Gap | — | Not verified: storage access level persisting across browser restart; whether Chrome's password manager offers to save the key on extension pages. | **Phase 9** (profile-restart E2E; manual headed check). |

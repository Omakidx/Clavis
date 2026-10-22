# Spike D: voices and the offscreen fallback (D-07)

Status: **provisional**. The no-voice path is proven honest on the Linux dev machine. The positive audio path is implemented and unit-tested but has **not been heard** by anyone yet: it needs the manual checks below on the maintainer's branded Chrome. Decision date: 2026-10-22.

## Question

Is `chrome.tts` enough, or must Clavis also speak through Web Speech `speechSynthesis` in an offscreen document (D-07), and on which OS is that fallback adopted? (docs/execution-phases.md, Phase 2, Spike D.)

## What was built (all behind one interface)

| Piece | File |
| --- | --- |
| Engine-agnostic `SpeechService` (routing, one utterance at a time, state events, start timeout) | `lib/speech/service.ts` |
| Voice choice that never substitutes another language (FR-024) | `lib/speech/voice-selection.ts` |
| `chrome.tts` engine | `lib/speech/engines/chrome-tts.ts` |
| Offscreen Web Speech engine (document lifecycle, idle close) | `lib/speech/engines/offscreen.ts`, `lib/speech/offscreen-host.ts` |
| Offscreen page logic and the unlisted page (`offscreen.html`) | `lib/speech/offscreen-page.ts`, `entrypoints/offscreen/` |
| `TTS_SPEAK` / `TTS_STOP` handling, reply envelope, event push | `lib/speech/background.ts` (`registerSpeech`, `createSpeechRouter`) |
| Internal message schemas (not public) | `lib/speech/messages.ts` |

### Design

```
 content script / reader / popup
        | TTS_SPEAK {v, requestId, text, lang?, rate}          reply: {ok:true, data:{engine, voiceName, state:'started'}}
        v                                                            or {ok:false, error:{code:'NO_VOICE', message}}
 background  registerSpeech -> SpeechService.speak()
        |   1. validate text (<= 2000) and clamp rate to 0.5..2.0; cancel previous utterance
        |   2. chrome.tts engine: getVoices -> selectVoice(lang) -> tts.stop(); tts.speak(enqueue:false)
        |        no suitable voice / error before start / no `start` within 5 s  --> next engine
        |   3. offscreen engine: ensure ONE offscreen document (AUDIO_PLAYBACK) -> SPEECH_OFFSCREEN_SPEAK
        |        offscreen page: speechSynthesis.speak(); relays start/end/error as SPEECH_OFFSCREEN_EVENT
        |   4. nothing started anywhere -> NO_VOICE (speechNoVoice / speechNoVoiceForLanguage / speechStartFailed)
        v
 terminal states (ended / cancelled / error) are pushed as TTS_EVENT to the asking tab+frame
 (tabs.sendMessage) or to tab-less extension pages (runtime.sendMessage). `started` IS the reply.
```

Rules that make it honest (FR-023, architecture §7):

- `speak()` resolves **only after an engine reported `start`**. There is no "queued" or "playing" success before that.
- `error`, `cancelled` or `ended` before `start`, a rejected `speak`, or no `start` within `startTimeoutMs` (5 s) is a failure. The engine is stopped and the next engine is tried. A `start` that arrives after the timeout is ignored.
- A voice for another language is never used as a stand-in. Exact locale beats same-language region; local beats remote. A chrome.tts voice that lists its event types but omits `start` is excluded, because it could never prove audio began.
- A new `speak()` cancels the previous utterance (`cancelled` event for the old request id), including one still starting. A stale `TTS_STOP {requestId}` does not cut off a newer utterance; `TTS_STOP` without an id stops every engine, which also covers speech the worker lost track of after being restarted.
- Probing stops at the first engine with voices, so the offscreen document is not created while `chrome.tts` works.
- The offscreen page obeys only the service worker (`sender.id` is this extension and `sender.tab` is undefined), so a content script cannot drive it. Relayed events are accepted only from the offscreen page URL.
- Spoken text is never logged (the metadata-only logger is used; engine detail strings are bounded and contain no text).

## Method

1. Built the extension to `.output-spike-d` and loaded it in Playwright's bundled Chromium (`channel: 'chromium'`, persistent profile, the existing fixture).
2. Queried `chrome.tts.getVoices()` in the service worker, the `SPEECH_DIAGNOSE` probe (both engines, spike-only, extension pages only) and the offscreen document's `speechSynthesis.getVoices()` (sent from the service worker, the only trusted sender).
3. Sent `TTS_SPEAK` for a word and a full sentence from `popup.html` opened as a tab, and `TTS_STOP` with and without a request id.
4. Called `chrome.tts.speak` and `speechSynthesis.speak` raw, with no voices, to record how each fails on its own.
5. Exercised the offscreen lifecycle: create on demand, reuse, close, recreate, and the real idle-timer close.

Spec: `tests/e2e/spike-d-speech.spec.ts`. The matrix is printed on every run (`SPIKE-D VOICE MATRIX`) and attached to the report as `voice-matrix.json`.

## Observed voice matrix

Machine: Linux 5.15, only `libspeechd2` installed (no speech-dispatcher daemon, no espeak/espeak-ng). Browser: Playwright bundled **Chromium (HeadlessChrome 156)**, not the maintainer's branded Chrome 154.

| Check | Result |
| --- | --- |
| `chrome.tts.getVoices()` | **0 voices** |
| Offscreen document created from the worker | yes, 0 documents before, 1 after; url `chrome-extension://<id>/offscreen.html` |
| `speechSynthesis` present in the offscreen document | yes (`supported: true`) |
| `speechSynthesis.getVoices()` in the offscreen document | **0 voices** (after waiting the full 1.5 s for `voiceschanged`) |
| `speechSynthesis.getVoices()` in an extension page (reader-style) | 0 voices |
| Raw `chrome.tts.speak('bank')` with no voice | fires `error` immediately (no message, no `start`); promise resolves, no rejection |
| Raw `speechSynthesis.speak()` with no voice | fires `error: synthesis-failed` immediately (no `start`) |
| `TTS_SPEAK` word | `{ok:false, error:{code:'NO_VOICE', message}}`, routed engine `none` |
| `TTS_SPEAK` full sentence | same, `NO_VOICE` |
| `TTS_STOP` with nothing playing (with and without request id) | `{ok:true, data:{stopped:false}}` |
| Invalid rate (9) / text over 2000 chars | error envelope (`INVALID_RESPONSE` as a stand-in / `SELECTION_TOO_LONG`), never a speak attempt |
| Message type that is not speech (`GET_AI_STATUS`) | not answered by this module (other listeners keep working) |
| Offscreen idle close | closed by the 20 s timer in the real extension (observed) |

Conclusions from the matrix:

- On this machine **neither mechanism produces a voice**, so the fallback adds nothing: the reply is `NO_VOICE`, never a fake success. This satisfies the acceptance criterion and FR-023.
- Both engines fail **fast and loudly** when there is no voice, so the start timeout is a safety net for engines that claim support and then stay silent, not the normal no-voice path.
- Caveat: bundled Chromium can differ from branded Chrome (voice sources, headless audio, built-in network voices). Nothing here proves what branded Chrome 154 reports. Audio itself cannot be asserted in automation at all.
- Cost note: the first request on a machine with no voices waits up to about 3 s (1.5 s for `chrome.tts` `onVoicesChanged`, 1.5 s for the offscreen `voiceschanged`) because both engines load voices asynchronously on Linux. Later requests in the same worker lifetime skip the wait.

## Offscreen API findings (minimum Chrome 116)

| API | Since | Available here | Used as |
| --- | --- | --- | --- |
| `chrome.offscreen.createDocument/closeDocument` | 109 | yes | create and close |
| `chrome.runtime.getContexts({contextTypes:['OFFSCREEN_DOCUMENT']})` | **116** (MV3) | yes | primary existence check, filtered by the offscreen page URL |
| `chrome.offscreen.hasDocument()` | **150** | yes (Chromium 156) | second choice only, never relied on |
| `clients.matchAll()` in the service worker | n/a | yes | pre-116 documented fallback |

- The existence check tries those three in order; if none is available, `createDocument` throwing "Only a single offscreen document may be created" is treated as "already exists". Concurrent callers share one creation (`ensureDocument` memoises the in-flight promise). All of this is unit-tested; only the 116+ and 150+ branches ran for real, and the pre-116 branches are verified by unit tests with faked APIs only.
- Because `getContexts` arrived in 116, the declared minimum of 116 is consistent with this design. Raising the minimum to 150 just for `hasDocument` is not worthwhile.
- The offscreen document cannot close itself through `chrome.offscreen`. The worker closes it 20 s after the last utterance (under the ~30 s worker idle limit). Safety net: the page sends `SPEECH_OFFSCREEN_IDLE` after 45 s of its own idleness, which re-wakes the worker if it died before its timer fired.
- Messages from the worker reach every extension page; the offscreen page and the router both ignore messages that are not theirs, and only the first listener that replies wins, so the router returns `undefined` for everything it does not own.
- After `createDocument` resolves the page may not have registered its listener yet, so sends retry briefly on "Receiving end does not exist".

## Manual verification for the maintainer (real audio, branded Chrome)

Nobody has heard audio from this code yet. Steps:

1. `WXT_OUT_DIR=.output-spike-d npx wxt build`, then open `chrome://extensions`, enable Developer mode, **Load unpacked**, choose `.output-spike-d/chrome-mv3`.
2. Open the extension popup (click the toolbar icon), right-click it, **Inspect**, and use that console. (A tab-hosted copy at `chrome-extension://<id>/popup.html` works too.)
3. Record what exists:

   ```js
   chrome.runtime.sendMessage({ v: 1, type: 'SPEECH_DIAGNOSE' }).then((r) => console.log(JSON.stringify(r, null, 2)));
   ```

   Note `capability.engine`, `probes` (voice count per engine) and `offscreenApi`. **The key comparison: does the offscreen engine list voices that `chrome.tts` does not?**
4. Listen for state pushes, then speak a word and a sentence, normal and slow:

   ```js
   chrome.runtime.onMessage.addListener((m) => m?.type === 'TTS_EVENT' && console.log('event', m));
   const say = (text, rate = 1, lang) =>
     chrome.runtime.sendMessage({ v: 1, type: 'TTS_SPEAK', requestId: crypto.randomUUID(), text, rate, ...(lang ? { lang } : {}) }).then(console.log);
   say('bank');
   say('The river bank was steep, so we walked along the water slowly; it was a quiet afternoon.');
   say('bank', 0.75);
   say('bank', 1, 'en-GB');
   ```

   Expect: a reply `{ok:true, data:{engine, voiceName, state:'started'}}` **and you hear the speech**, then a `TTS_EVENT` with `state:'ended'`. Call `say(...)` twice quickly: the first must stop and report `cancelled`, only the second is heard. Stop with `chrome.runtime.sendMessage({v:1,type:'TTS_STOP'}).then(console.log)`.
5. Compare with the service worker console (`chrome://extensions` -> Inspect service worker): `await chrome.tts.getVoices()`.
6. Optional, to test the positive `chrome.tts` path on Linux (**you run this; the agent did not**): `sudo apt install speech-dispatcher espeak-ng`, **fully quit and restart Chrome**, reload the extension and repeat steps 3 to 5. Then also remove them (`sudo apt remove speech-dispatcher espeak-ng`, restart Chrome) and repeat once more to confirm the no-voice message appears instead of a playing state (D-14: with and without speech-dispatcher).
7. Report back: per OS you can reach, the `SPEECH_DIAGNOSE` voice counts per engine and whether audio was audible.

Reader page option (not implemented, no edits to `entrypoints/reader`): extension pages have `speechSynthesis` directly, so the reader can reuse `registerOffscreenSpeech`'s voice logic as a "direct Web Speech" engine inside its own `SpeechService([ChromeTtsEngine, DirectWebSpeechEngine])` and skip the offscreen document entirely. Measured here: a reader-style extension page reports 0 voices and `synthesis-failed` on this machine, exactly like the offscreen document.

## Provisional recommendation for D-07

1. **Linux without speech-dispatcher (this machine): do not adopt the fallback.** Proven: 0 voices on both engines, and both fail instantly when forced. Ship the actionable no-voice message (`speechNoVoice`), not a fallback.
2. **Linux with speech-dispatcher + espeak-ng, Windows, macOS: no evidence yet that the fallback helps.** In Chromium both `chrome.tts` and Web Speech sit on the same platform speech controller, so the expectation (**unverified hypothesis**) is that the voice lists match and `chrome.tts` alone suffices. The fallback is justified on an OS only if step 3 of the manual check shows the offscreen engine listing a usable voice that `chrome.tts` lacks.
3. **Recommended default for Phase 6: keep `SpeechService` and its engine interface; keep `chrome.tts` as the only enabled engine; leave the offscreen engine implemented but off unless the manual matrix shows a gain.** If the manual matrix shows no gain on any tested OS, remove the offscreen engine, `entrypoints/offscreen`, the `offscreen` permission (`wxt.config.ts`, `scripts/expected-permissions.json`, architecture §3) and revisit D-07 as "chrome.tts only plus reader-direct Web Speech". If it shows a gain on an OS, adopt the offscreen engine for that OS and keep the permission.
4. Until the maintainer's manual confirmation, **keep the provisional `offscreen` permission** so the built artifact can still be tested. It is the only manifest change this decision can force.
5. The decision itself needs: your branded Chrome 154 matrix on Linux (with and without speech-dispatcher) and the one-time Windows/macOS manual pass already required by D-14 before public listing.

## Proposed contract changes (for the manager; nothing in `lib/contracts` or `lib/config` was edited)

- `lib/contracts/errors.ts`: add an `INVALID_REQUEST` error code. Validation failures currently use `INVALID_RESPONSE` as a stand-in (`INVALID_REQUEST_CODE` in `lib/speech/background.ts`).
- `lib/contracts/messages.ts`: promote `TTS_EVENT` (`{v, type, requestId, state: 'ended'|'cancelled'|'error'}`) into the public union as an outbound-only message, and decide the reply `data` shapes for `TTS_SPEAK` (`{engine, voiceName?, lang?, remote, state:'started'}`) and `TTS_STOP` (`{stopped}`).
- `lib/speech/messages.ts` holds the internal offscreen messages (`SPEECH_OFFSCREEN_*`) and the spike-only `SPEECH_DIAGNOSE`. Keep them out of the public union. Phase 3's router should call `createSpeechRouter` instead of adding a second listener, and `SPEECH_DIAGNOSE` should be removed or put behind a dev flag before release.
- `lib/config/constants.ts`: promote `SPEECH_TIMING` (start timeout 5 s, idle close 20 s, voices wait 1.5 s) once confirmed on real machines.
- `public/_locales/en/messages.json`: keys `speechNoVoice`, `speechNoVoiceForLanguage`, `speechStartFailed`, `speechInvalidRequest`, `speechCancelled` were added (draft copy; Phase 6 should make `speechNoVoice` OS-specific, e.g. the `speech-dispatcher` hint on Linux).

## Risks and follow-ups

- Positive audio path is untested in automation (no voices here). It is covered by unit tests with mocked engines and by the manual steps above.
- Worker restarts lose utterance tracking (`chrome.tts` keeps speaking). `TTS_STOP` without an id covers it; state events for an utterance that outlived its worker are dropped.
- `chrome.tts` remote voices (network) may start slower than 5 s on bad connections and would then be reported as failed; revisit with real remote-voice data. Remote voices also send text off the device, which the "Listen is local" disclosure copy does not currently allow for.
- The bundle now pulls the shared contracts chunk (about 90 kB, mostly zod) into the offscreen page and the background; fine for the spike, but count it against Phase 4/6 size budgets.
- The first no-voice answer on a machine takes up to about 3 s (see the matrix cost note); a toolbar needs a spinner with a timeout for this case.

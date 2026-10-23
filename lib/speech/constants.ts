/**
 * Tuning constants for the speech stack (D-07). Speech-local on purpose; the values were measured
 * in Spike D and re-checked in Phase 6.
 *
 * First no-voice answer on a machine (Linux without speech-dispatcher), per worker lifetime:
 * chrome.tts is peeked at once; when it is empty, chrome.tts waits for `onVoicesChanged` and the
 * offscreen engine loads its page IN PARALLEL, so the answer takes about `voicesLoadTimeoutMs`
 * (1.5 s) plus the document start, and never more than `offscreenProbeTimeoutMs` (4 s) even if
 * the offscreen document hangs. Every later request answers in milliseconds (the empty list is
 * remembered) until `tts.onVoicesChanged` fires or Settings asks for the voice report.
 */

/** Path of the unlisted offscreen page that WXT builds from entrypoints/offscreen/index.html. */
export const OFFSCREEN_PAGE_PATH = '/offscreen.html' as const;

/** Path of the service worker script that WXT builds from entrypoints/background.ts. */
export const BACKGROUND_SCRIPT_PATH = '/background.js' as const;

/** Shown by the browser to explain why the offscreen document exists (architecture §7). */
export const OFFSCREEN_JUSTIFICATION =
  'Speak the text the user selected aloud when the browser has no native text-to-speech voice for it.';

export const SPEECH_TIMING = {
  /**
   * How long an engine may take to report `start` before the attempt counts as
   * failed ("reported support but no audio", architecture §7). Generous enough
   * for a cold offscreen document or a remote voice.
   */
  startTimeoutMs: 5_000,
  /**
   * ONE overall budget for a `speak()` from the request reaching the service to audio started:
   * voice lookup (bounded by `offscreenProbeTimeoutMs`) and every start attempt share it, so a
   * slow lookup leaves less time for the attempt and a second attempt only gets what is left.
   * Must stay below the toolbar's own backstop (about 7 s).
   */
  speakDeadlineMs: 5_000,
  /**
   * Close the offscreen document this long after the last utterance finished.
   * Kept under the ~30 s MV3 service-worker idle limit so the timer normally
   * fires before the worker is torn down.
   */
  offscreenIdleCloseMs: 20_000,
  /**
   * Safety net inside the offscreen page: if the worker died before its timer
   * fired, the page tells the (re-woken) worker it is idle so it can be closed.
   */
  offscreenSelfIdleNotifyMs: 45_000,
  /** How long the offscreen page waits for `voiceschanged` before reporting what it has. */
  voicesLoadTimeoutMs: 1_500,
  /**
   * Upper bound for anything that needs the offscreen document to answer a voice query
   * (creating the document, its listener coming up, the page's own voice wait).
   */
  offscreenProbeTimeoutMs: 4_000,
  /**
   * Retries when the offscreen page has not registered its listener yet (its module script is
   * still loading, which a busy machine can stretch to a second). 15 x 100 ms = 1.5 s at most,
   * inside the 4 s probe bound.
   */
  offscreenSendRetries: 15,
  offscreenSendRetryDelayMs: 100,
} as const;

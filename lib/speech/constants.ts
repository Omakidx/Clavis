/**
 * Spike D (D-07) tuning constants for the speech stack. Speech-local on purpose:
 * lib/config is owned elsewhere. Promote to lib/config/constants.ts in Phase 6
 * once the values are confirmed on real machines.
 */

/** Path of the unlisted offscreen page that WXT builds from entrypoints/offscreen/index.html. */
export const OFFSCREEN_PAGE_PATH = '/offscreen.html' as const;

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
  /** Retries when the offscreen page has not registered its listener yet. */
  offscreenSendRetries: 3,
  offscreenSendRetryDelayMs: 60,
} as const;

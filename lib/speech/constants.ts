/**
 * Tuning constants for the speech stack. Speech-local on purpose; the values were measured in
 * Spike D and re-checked in Phase 6.
 *
 * First no-voice answer on a machine (Linux without speech-dispatcher), per worker lifetime:
 * chrome.tts is asked once; when it is empty it waits up to `voicesLoadTimeoutMs` (1.5 s) for
 * `onVoicesChanged`, because Linux loads voices asynchronously. The empty list is then remembered,
 * so every later request answers in milliseconds until `tts.onVoicesChanged` fires or Settings
 * asks for the voice report.
 */

export const SPEECH_TIMING = {
  /**
   * How long the engine may take to report `start` for one attempt before it counts as failed
   * ("reported support but no audio", architecture §7). Also capped by `speakDeadlineMs`.
   */
  startTimeoutMs: 5_000,
  /**
   * ONE overall budget for a `speak()` from the request reaching the service to audio started:
   * the voice lookup and every start attempt share it. Must stay below the toolbar's own
   * backstop (about 7 s).
   */
  speakDeadlineMs: 5_000,
  /** How long chrome.tts is waited for when its first voice list is empty (voices load late). */
  voicesLoadTimeoutMs: 1_500,
} as const;

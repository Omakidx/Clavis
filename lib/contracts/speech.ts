import { z } from 'zod';
import { LIMITS, MESSAGE_VERSION } from '../config/constants';
import { idSchema, languageTagSchema } from './primitives';

// Phase 6 contracts for Listen (pronunciation). Shared by the background speech module, the
// toolbar/content script, the practice page and Settings.

const v = z.literal(MESSAGE_VERSION);

/** Speech engines (D-07): Chrome's TTS first, the offscreen Web Speech fallback second. */
export const speechEngineSchema = z.enum(['chrome-tts', 'offscreen-web-speech']);
export type SpeechEngine = z.infer<typeof speechEngineSchema>;

/** Voice name as reported by the engine; bounded, opaque. */
export const voiceNameSchema = z.string().min(1).max(128);

/** Reply `data` for TTS_SPEAK once audio has actually started. */
export const speakResultSchema = z.strictObject({
  state: z.literal('started'),
  engine: speechEngineSchema,
  voiceName: voiceNameSchema.optional(),
  lang: languageTagSchema.optional(),
  /** The voice synthesises remotely (text leaves the device; see requirements §4.3). */
  remote: z.boolean(),
});
export type SpeakResult = z.infer<typeof speakResultSchema>;

/** Reply `data` for TTS_STOP. */
export const stopResultSchema = z.strictObject({ stopped: z.boolean() });
export type StopResult = z.infer<typeof stopResultSchema>;

/**
 * Background → the page that asked (tab/frame via tabs.sendMessage, or tab-less extension
 * pages via runtime.sendMessage): the utterance reached a terminal state.
 */
export const ttsEventMessageSchema = z.strictObject({
  v,
  type: z.literal('TTS_EVENT'),
  requestId: idSchema,
  state: z.enum(['ended', 'cancelled', 'error']),
});
export type TtsEventMessage = z.infer<typeof ttsEventMessageSchema>;

/** Background → requesting page: a word boundary supplied by the speech engine. */
export const ttsBoundaryMessageSchema = z.strictObject({
  v,
  type: z.literal('TTS_BOUNDARY'),
  requestId: idSchema,
  charIndex: z.number().int().min(0).max(LIMITS.maxSelectionChars),
  length: z.number().int().min(0).max(LIMITS.maxSelectionChars).optional(),
});
export type TtsBoundaryMessage = z.infer<typeof ttsBoundaryMessageSchema>;

/** One voice an engine reports. */
export const voiceInfoSchema = z.strictObject({
  name: voiceNameSchema,
  lang: languageTagSchema.optional(),
  engine: speechEngineSchema,
  remote: z.boolean(),
});
export type VoiceInfo = z.infer<typeof voiceInfoSchema>;

/** Reply `data` for GET_VOICES: what this device can actually speak with (FR-025, D-07). */
export const voicesReportSchema = z.strictObject({
  platform: z.enum(['linux', 'mac', 'win', 'cros', 'android', 'other']),
  /** Engine Listen will use by default, or 'none' when no voice exists anywhere. */
  defaultEngine: z.union([speechEngineSchema, z.literal('none')]),
  engines: z.strictObject({
    chromeTts: z.strictObject({ voices: z.array(voiceInfoSchema).max(500) }),
    offscreen: z.strictObject({
      /** False when the fallback is not adopted (D-07) or could not run. */
      available: z.boolean(),
      voices: z.array(voiceInfoSchema).max(500),
    }),
  }),
});
export type VoicesReport = z.infer<typeof voicesReportSchema>;

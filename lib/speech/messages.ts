import { z } from 'zod';
import { LIMITS, MESSAGE_VERSION } from '../config/constants';
import { idSchema, languageTagSchema, ttsRateSchema, voiceNameSchema } from '../contracts';

/**
 * INTERNAL message schemas: background <-> offscreen document only. They are deliberately NOT part
 * of lib/contracts (content scripts must never be able to address the offscreen document). The
 * public speech shapes (TTS_EVENT, reply data, voices report) live in lib/contracts/speech.ts.
 */

const v = z.literal(MESSAGE_VERSION);
const target = z.literal('offscreen');

const text = z.string().min(1).max(LIMITS.maxSelectionChars);
const voiceName = voiceNameSchema;

// ---- background -> offscreen (commands) ------------------------------------

export const offscreenGetVoicesSchema = z.strictObject({
  v,
  target,
  type: z.literal('SPEECH_OFFSCREEN_GET_VOICES'),
});

export const offscreenSpeakSchema = z.strictObject({
  v,
  target,
  type: z.literal('SPEECH_OFFSCREEN_SPEAK'),
  requestId: idSchema,
  text,
  lang: languageTagSchema.optional(),
  voiceName: voiceName.optional(),
  rate: ttsRateSchema,
});

export const offscreenStopSchema = z.strictObject({
  v,
  target,
  type: z.literal('SPEECH_OFFSCREEN_STOP'),
});

export const offscreenCommandSchema = z.discriminatedUnion('type', [
  offscreenGetVoicesSchema,
  offscreenSpeakSchema,
  offscreenStopSchema,
]);
export type OffscreenCommand = z.infer<typeof offscreenCommandSchema>;

// ---- offscreen -> background ------------------------------------------------

export const offscreenEventSchema = z.strictObject({
  v,
  type: z.literal('SPEECH_OFFSCREEN_EVENT'),
  requestId: idSchema,
  state: z.enum(['started', 'ended', 'cancelled', 'error']),
  detail: z.string().max(200).optional(),
});
export type OffscreenEventMessage = z.infer<typeof offscreenEventSchema>;

export const offscreenIdleSchema = z.strictObject({
  v,
  type: z.literal('SPEECH_OFFSCREEN_IDLE'),
});

// ---- offscreen replies -------------------------------------------------------

export const offscreenVoiceSchema = z.strictObject({
  name: z.string().max(256),
  lang: z.string().max(64),
  remote: z.boolean(),
});

export const offscreenVoicesReplySchema = z.strictObject({
  ok: z.literal(true),
  /** False when the page has no `speechSynthesis` at all. */
  supported: z.boolean(),
  voices: z.array(offscreenVoiceSchema).max(2_000),
});
export type OffscreenVoicesReply = z.infer<typeof offscreenVoicesReplySchema>;

export const offscreenAckSchema = z.strictObject({
  ok: z.boolean(),
  detail: z.string().max(200).optional(),
});
export type OffscreenAck = z.infer<typeof offscreenAckSchema>;

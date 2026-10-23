import { z } from 'zod';
import { LIMITS } from '../config/constants';

/** Stable machine-readable error codes (architecture §4, requirements §7). */
export const ERROR_CODES = [
  'SETUP_REQUIRED',
  'INVALID_API_KEY',
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'UNSUPPORTED_SITE',
  'NO_VOICE',
  'PERMISSION_DENIED',
  'PDF_LOAD_ERROR',
  'REQUEST_CANCELLED',
  'SELECTION_TOO_LONG',
  /** Message failed schema or sender validation. */
  'INVALID_REQUEST',
  /** Storage lockdown failed (secret boundary rule 1); key routes refuse to run. */
  'STORAGE_UNAVAILABLE',
  /** Unexpected failure inside the extension; carries no error text. */
  'INTERNAL_ERROR',
] as const;

export const errorCodeSchema = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof errorCodeSchema>;

/**
 * Why an error happened, when the code alone is ambiguous. Additive and optional: a caller that
 * ignores it sees the plain code.
 * - `disclosure`: SETUP_REQUIRED because the one-time "Send this to Groq?" confirmation
 *   (requirements §4.1 firstSendBody) was never given, NOT because the key is missing. The
 *   caller resends the same AI_EXPLAIN with `acknowledgeDisclosure: true` after a trusted click.
 */
/**
 * Optional machine-readable detail for an error code:
 * - `disclosure` (with SETUP_REQUIRED): the one-time first-send prompt must be shown.
 * - `no-voice-linux` (with NO_VOICE): no speech engine on Linux; the UI suggests installing
 *   speech-dispatcher and a voice (e.g. espeak-ng) and restarting Chrome.
 * - `no-voice-language` / `start-failed` (with NO_VOICE): see below; no install hint.
 */
export const errorReasonSchema = z.enum([
  'disclosure',
  'no-voice-linux',
  // With NO_VOICE: voices exist, but none for this language (never substituted, FR-024).
  'no-voice-language',
  // With NO_VOICE: a voice was found but did not start (engine glitch, online voice offline).
  'start-failed',
  // With NO_VOICE: only online voices exist for this language; by default Listen uses
  // on-device voices only (D-22), so the user must choose an online voice in Settings.
  'online-only',
  // With RATE_LIMITED: Clavis's own request throttle (per tab), not Groq's rate limit.
  'local-limit',
]);
export type ErrorReason = z.infer<typeof errorReasonSchema>;

/** Error envelope returned to callers. Never carries keys, headers or raw provider bodies. */
export const errorEnvelopeSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().max(LIMITS.maxErrorMessageChars),
  retryAfterMs: z.number().int().nonnegative().max(3_600_000).optional(),
  reason: errorReasonSchema.optional(),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

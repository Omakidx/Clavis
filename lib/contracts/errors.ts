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

/** Error envelope returned to callers. Never carries keys, headers or raw provider bodies. */
export const errorEnvelopeSchema = z.strictObject({
  code: errorCodeSchema,
  message: z.string().max(LIMITS.maxErrorMessageChars),
  retryAfterMs: z.number().int().nonnegative().max(3_600_000).optional(),
});
export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

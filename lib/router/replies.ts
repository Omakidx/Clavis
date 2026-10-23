import { GroqError } from '../ai/errors';
import { idSchema, type ErrorCode, type ErrorReason, type MessageReply } from '../contracts';

/** Fixed message for an envelope that carries a `reason` (the plain code message would mislead). */
const REASON_MESSAGES: Record<ErrorReason, string> = {
  disclosure: 'Confirm that Clavis may send the selected text to Groq.',
  'no-voice-linux': 'No speech engine is installed on this Linux system.',
  'no-voice-language': 'No voice is available for this language.',
  'start-failed': 'The voice did not start.',
  'online-only': 'Only online voices are available for this language.',
  'local-limit': 'Too many requests from Clavis. Try again shortly.',
};

/**
 * Reply envelopes. Messages are the fixed per-code strings from `GroqError` (named for
 * its first user, but its messages are provider- and input-independent), so no reply can
 * carry the key, selected text, headers or provider output.
 */
export function failure(
  code: ErrorCode,
  options: {
    requestId?: string | undefined;
    retryAfterMs?: number | undefined;
    reason?: ErrorReason | undefined;
  } = {},
): MessageReply<never> {
  const base = new GroqError(code, {
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
  }).toEnvelope();
  const envelope =
    options.reason === undefined
      ? base
      : { ...base, message: REASON_MESSAGES[options.reason], reason: options.reason };
  return {
    ok: false,
    ...(options.requestId === undefined ? {} : { requestId: options.requestId }),
    error: envelope,
  };
}

export function success<T>(data: T, requestId?: string): MessageReply<T> {
  return { ok: true, ...(requestId === undefined ? {} : { requestId }), data };
}

/**
 * A correlation id to echo on failures: only if it is a well-formed UUID, so no other
 * caller-supplied value (and no key or text) is ever reflected back.
 */
export function echoableRequestId(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const candidate = (raw as { requestId?: unknown }).requestId;
  return typeof candidate === 'string' && idSchema.safeParse(candidate).success
    ? candidate
    : undefined;
}

/** The reply for a known route called by a sender it does not allow, or with an invalid shape. */
export function invalidRequest(raw: unknown): MessageReply<never> {
  return failure('INVALID_REQUEST', { requestId: echoableRequestId(raw) });
}

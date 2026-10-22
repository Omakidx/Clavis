import { GroqError } from '../ai/errors';
import { idSchema, type ErrorCode, type MessageReply } from '../contracts';

/**
 * Reply envelopes. Messages are the fixed per-code strings from `GroqError` (named for
 * its first user, but its messages are provider- and input-independent), so no reply can
 * carry the key, selected text, headers or provider output.
 */
export function failure(
  code: ErrorCode,
  options: { requestId?: string | undefined; retryAfterMs?: number | undefined } = {},
): MessageReply<never> {
  const envelope = new GroqError(code, {
    ...(options.retryAfterMs === undefined ? {} : { retryAfterMs: options.retryAfterMs }),
  }).toEnvelope();
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

import { browser } from 'wxt/browser';
import type { z } from 'zod';
import { MESSAGE_VERSION } from '../config/constants';
import { messageReplySchema, type MessageReply } from '../contracts/messages';
import { describeError, type ClientError } from './errors';

export type ClientResult<T> = { ok: true; data: T } | { ok: false; error: ClientError };

/** Wait this long before the single retry; a restarting service worker needs a moment. */
const RETRY_DELAY_MS = 400;

export interface RequestDeps {
  send(message: unknown): Promise<unknown>;
  wait(ms: number): Promise<void>;
  retryDelayMs: number;
}

const defaultDeps: RequestDeps = {
  send: (message) => browser.runtime.sendMessage(message),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryDelayMs: RETRY_DELAY_MS,
};

/** Every message needs `v`; callers pass the rest so they cannot forget or mistype it. */
export type OutgoingMessage = { type: string } & Record<string, unknown>;

/**
 * One attempt. `undefined` means "nobody answered": the service worker is starting or was
 * torn down between the message and its reply, or the listener never called back.
 */
async function attempt(deps: RequestDeps, message: unknown): Promise<unknown> {
  try {
    return await deps.send(message);
  } catch {
    // "Receiving end does not exist" / "message port closed": same situation as no reply.
    return undefined;
  }
}

/**
 * Send a message to the extension's background and validate the reply.
 *
 * - The reply is parsed with `messageReplySchema(dataSchema)`; anything that does not match is
 *   a `BAD_REPLY`, never trusted data.
 * - A missing reply (service worker restarting) is retried ONCE after a short delay, then
 *   becomes `NO_RESPONSE`. Retrying is safe for reads and idempotent writes only. A route that
 *   costs money or is not idempotent (AI_EXPLAIN: a second send could mean a second paid Groq
 *   call, requirements section 8 abuse case 5) must pass `{ retry: false }`: it then fails with
 *   `NO_RESPONSE` and the user decides whether to press Try again.
 * - Failures carry localized, actionable text from `describeError`. The provider-facing
 *   `message` of an error envelope is never shown, and nothing is logged: messages may carry
 *   an API key (docs/architecture.md §9).
 */
export async function request<S extends z.ZodType>(
  message: OutgoingMessage,
  dataSchema: S,
  deps: Partial<RequestDeps> = {},
  options: { retry?: boolean } = {},
): Promise<ClientResult<z.infer<S>>> {
  const resolved: RequestDeps = { ...defaultDeps, ...deps };
  const wire = { v: MESSAGE_VERSION, ...message };

  let reply = await attempt(resolved, wire);
  if (reply === undefined || reply === null) {
    if (options.retry === false) return { ok: false, error: describeError('NO_RESPONSE') };
    await resolved.wait(resolved.retryDelayMs);
    reply = await attempt(resolved, wire);
    if (reply === undefined || reply === null) {
      return { ok: false, error: describeError('NO_RESPONSE') };
    }
  }

  const parsed = messageReplySchema(dataSchema).safeParse(reply);
  if (!parsed.success) return { ok: false, error: describeError('BAD_REPLY') };
  const envelope = parsed.data as MessageReply<z.infer<S>>;
  if (envelope.ok) return { ok: true, data: envelope.data };
  return { ok: false, error: describeError(envelope.error.code, envelope.error.retryAfterMs) };
}

/** For callers that need a `ClientError` without a request (client-side validation, tests). */
export function failure(error: ClientError): ClientResult<never> {
  return { ok: false, error };
}

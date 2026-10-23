import { LIMITS } from '../config/constants';
import { logger } from '../security/logger';
import { StorageUnavailableError } from '../storage/errors';
import { failure, invalidRequest } from './replies';
import {
  classifySender,
  type ClassifiedSender,
  type ExtensionPagePath,
  type SenderIdentity,
  type SenderLike,
} from './sender';

/**
 * The ONE `runtime.onMessage` listener (Phase 3). Every route is a table entry with its
 * own parser, allowed senders and handler; nothing else in the background listens for
 * runtime messages, so a message type that is not in the table is never answered here.
 */

/** Which senders may call a route. A route with no matching sender is rejected. */
export interface SenderRule {
  /** Content scripts running in web pages. */
  content?: boolean;
  /** Extension pages, by exact path. */
  pages?: readonly ExtensionPagePath[];
}

export type ParseResult<T> = { ok: true; message: T } | { ok: false };

export interface RouteContext {
  sender: ClassifiedSender;
}

export interface RouteDefinition<T> {
  type: string;
  allow: SenderRule;
  parse: (raw: unknown) => ParseResult<T>;
  /** Returns the reply (an object) or `undefined` for none. May be async. */
  handle: (message: T, context: RouteContext) => unknown;
  /**
   * `false` for fire-and-forget routes: the handler runs but the
   * channel is closed without a reply. Default `true`.
   */
  replies?: boolean;
  /**
   * Reply for a rejected sender (`why: 'sender'`) or an invalid shape (`why: 'shape'`).
   * Default: an INVALID_REQUEST envelope. It must not echo caller-supplied values.
   */
  reject?(raw: unknown, why: 'sender' | 'shape'): unknown;
}

/** A route with its message type erased, so a table can hold routes of different types. */
export interface Route {
  readonly type: string;
  readonly allow: SenderRule;
  readonly replies: boolean;
  reject(raw: unknown, why: 'sender' | 'shape'): unknown;
  /** Parse and handle. `undefined` = the message does not match this route's schema. */
  run(raw: unknown, context: RouteContext): unknown;
}

const INVALID = Symbol('invalid');

export function defineRoute<T>(definition: RouteDefinition<T>): Route {
  return {
    type: definition.type,
    allow: definition.allow,
    replies: definition.replies ?? true,
    reject: definition.reject ?? ((raw) => invalidRequest(raw)),
    run(raw, context) {
      const parsed = definition.parse(raw);
      return parsed.ok ? definition.handle(parsed.message, context) : INVALID;
    },
  };
}

export const isInvalidResult = (value: unknown): boolean => value === INVALID;

export function senderAllowed(rule: SenderRule, sender: ClassifiedSender): boolean {
  switch (sender.kind) {
    case 'content':
      return rule.content === true;
    case 'extension':
      return (
        sender.path !== undefined &&
        (rule.pages as readonly string[] | undefined)?.includes(sender.path) === true
      );
    default:
      return false;
  }
}

function messageType(raw: unknown): string | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const type = (raw as { type?: unknown }).type;
  return typeof type === 'string' ? type : undefined;
}

/** Wrap a typed zod-style parser. Size-capped so an oversized body is never parsed. */
export function parseWith<T>(
  parse: (raw: unknown) => { success: true; data: T } | { success: false },
): (raw: unknown) => ParseResult<T> {
  return (raw) => {
    let size: number;
    try {
      const json = JSON.stringify(raw);
      if (json === undefined) return { ok: false };
      size = new TextEncoder().encode(json).length;
    } catch {
      return { ok: false };
    }
    if (size > LIMITS.maxMessageBytes) return { ok: false };
    const result = parse(raw);
    return result.success ? { ok: true, message: result.data } : { ok: false };
  };
}

/** What an unexpected handler failure becomes. Never carries the error's own text. */
export function replyForThrown(error: unknown): unknown {
  if (error instanceof StorageUnavailableError) return failure('STORAGE_UNAVAILABLE');
  logger.error('router_handler_failed', {
    errorCode: error instanceof Error ? error.name.slice(0, 40) : 'unknown',
  });
  return failure('INTERNAL_ERROR');
}

type SendResponse = (response?: unknown) => void;

export interface MessageListenerDeps {
  identity: SenderIdentity;
  routes: readonly Route[];
}

/**
 * Build the `runtime.onMessage` listener. Registered once, synchronously (MV3).
 *
 * - Unknown type: returns `undefined`, no reply, so unrelated messages are never claimed.
 * - Known type from a sender the route does not allow, or with an invalid shape: replies
 *   INVALID_REQUEST (or the route's own rejection) without echoing any input.
 * - Allowed and valid: runs the handler and replies asynchronously; the listener returns
 *   `true` to keep the channel open (the explicit sendResponse form works on every Chrome
 *   version, unlike returning a Promise).
 */
export function createMessageListener(deps: MessageListenerDeps) {
  const table = new Map<string, Route>();
  for (const route of deps.routes) {
    if (table.has(route.type)) throw new Error(`Duplicate route: ${route.type}`);
    table.set(route.type, route);
  }

  return (raw: unknown, sender: SenderLike, sendResponse: SendResponse): true | undefined => {
    const type = messageType(raw);
    const route = type === undefined ? undefined : table.get(type);
    if (route === undefined) return undefined;

    const classified = classifySender(sender, deps.identity);
    const respond = (reply: unknown): void => {
      if (!route.replies) return;
      try {
        sendResponse(reply);
      } catch {
        // The caller went away (navigated or closed); nothing is waiting for the reply.
      }
    };

    if (!senderAllowed(route.allow, classified)) {
      respond(route.reject(raw, 'sender'));
      return undefined;
    }

    let outcome: unknown;
    try {
      outcome = route.run(raw, { sender: classified });
    } catch (error) {
      respond(replyForThrown(error));
      return undefined;
    }
    if (isInvalidResult(outcome)) {
      respond(route.reject(raw, 'shape'));
      return undefined;
    }
    if (!route.replies) {
      // Fire and forget: surface nothing, but never leave a rejection unhandled.
      Promise.resolve(outcome).catch(() => undefined);
      return undefined;
    }
    Promise.resolve(outcome).then(
      (reply) => respond(reply),
      (error: unknown) => respond(replyForThrown(error)),
    );
    return true;
  };
}

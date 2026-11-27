import type { z } from 'zod';
import { ApiError, type ErrorCode } from '@shared/api-contract/errors';

/** Why a request failed, reduced to what the UI needs to decide how to react. */
export type FailureKind =
  | 'network'
  | 'unauthenticated'
  | 'not-found'
  | 'rate-limited'
  | 'csrf'
  | 'gone'
  | 'unavailable'
  | 'server'
  | 'invalid-response'
  | 'other';

export class ApiFailure extends Error {
  readonly kind: FailureKind;
  readonly status: number;
  readonly code: ErrorCode | undefined;
  readonly retryAfterMs: number | undefined;
  constructor(
    kind: FailureKind,
    status: number,
    code?: ErrorCode,
    retryAfterMs?: number,
    message?: string,
  ) {
    super(message ?? `${kind} (${status})`);
    this.name = 'ApiFailure';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export const isAbort = (e: unknown): boolean =>
  e instanceof DOMException && e.name === 'AbortError';

/** Plain-English message for a failure. The server's diagnostic text is never shown (UIs map by code). */
export function describeFailure(e: unknown): string {
  if (!(e instanceof ApiFailure)) return 'Something went wrong. Try again.';
  switch (e.kind) {
    case 'network':
      return 'Clavis cannot be reached. Check your connection and try again.';
    case 'unauthenticated':
      return 'Your session has ended. Sign in again.';
    case 'not-found':
      return 'That item no longer exists. It may have been deleted on another device.';
    case 'rate-limited': {
      const s = e.retryAfterMs ? Math.max(1, Math.ceil(e.retryAfterMs / 1000)) : undefined;
      return s
        ? `Too many requests. Try again in ${s} second${s === 1 ? '' : 's'}.`
        : 'Too many requests. Wait a moment and try again.';
    }
    case 'csrf':
      return 'Your session needs a refresh. Reload the page and try again.';
    case 'gone':
      return 'This list changed while you were reading it. Reload it to continue.';
    case 'unavailable':
      return 'Clavis is temporarily unavailable. Try again in a moment.';
    case 'invalid-response':
      return 'Clavis sent a response this page could not read. Reload and try again.';
    case 'server':
      return 'Something went wrong on our side. Try again in a moment.';
    default:
      return 'The request could not be completed. Try again.';
  }
}

function classify(status: number, code: ErrorCode | undefined): FailureKind {
  if (status === 401) return 'unauthenticated';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status === 410) return 'gone';
  if (status === 403 && code === 'CSRF_FAILED') return 'csrf';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'server';
  return 'other';
}

type Method = 'GET' | 'POST' | 'DELETE';
interface Options<S extends z.ZodType | undefined> {
  method?: Method;
  /** Zod schema of the 2xx JSON body. Omit for 204 responses. */
  schema?: S;
  query?: Record<string, string | undefined>;
  /** JSON request body (sent with Content-Type: application/json). */
  body?: unknown;
  signal?: AbortSignal;
  /** Do not treat 401 as "session gone" (used for the session probe itself). */
  quiet401?: boolean;
}

let csrfToken: string | null = null;
let onSessionLost: (() => void) | null = null;
let refreshCsrf: (() => Promise<string | null>) | null = null;

/** Wired by the session provider: the CSRF token (design §2.5) and what to do when a request returns 401. */
export function configureApi(opts: {
  onSessionLost: () => void;
  refreshCsrf: () => Promise<string | null>;
}): void {
  onSessionLost = opts.onSessionLost;
  refreshCsrf = opts.refreshCsrf;
}
export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

async function send(
  method: Method,
  url: string,
  signal: AbortSignal | undefined,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;
  try {
    return await fetch(url, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new ApiFailure('network', 0);
  }
}

/**
 * Same-origin JSON request. Parses 2xx bodies with the shared zod schema and turns every other outcome
 * into an `ApiFailure`. Non-GET requests carry the CSRF token; a 403 CSRF_FAILED re-reads the session once.
 * A Content-Type is set only when a JSON `body` is given (the server only requires JSON when there is one).
 */
export async function request<S extends z.ZodType | undefined = undefined>(
  path: string,
  opts: Options<S> = {},
): Promise<S extends z.ZodType ? z.infer<S> : undefined> {
  const method = opts.method ?? 'GET';
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(opts.query ?? {}))
    if (v !== undefined && v !== '') qs.set(k, v);
  const url = qs.size ? `${path}?${qs.toString()}` : path;

  let res = await send(method, url, opts.signal, opts.body);
  if (res.status === 403 && method !== 'GET' && refreshCsrf) {
    const body: unknown = await res
      .clone()
      .json()
      .catch(() => null);
    const parsed = ApiError.safeParse(body);
    if (parsed.success && parsed.data.error.code === 'CSRF_FAILED') {
      csrfToken = await refreshCsrf();
      if (csrfToken) res = await send(method, url, opts.signal, opts.body);
    }
  }

  if (res.ok) {
    if (!opts.schema) return undefined as never;
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new ApiFailure('invalid-response', res.status);
    }
    const parsed = opts.schema.safeParse(json);
    if (!parsed.success) throw new ApiFailure('invalid-response', res.status);
    return parsed.data as never;
  }

  let code: ErrorCode | undefined;
  let retryAfterMs: number | undefined;
  const parsed = ApiError.safeParse(await res.json().catch(() => null));
  if (parsed.success) {
    code = parsed.data.error.code;
    retryAfterMs = parsed.data.error.retryAfterMs;
  }
  if (retryAfterMs === undefined) {
    const header = Number(res.headers.get('Retry-After'));
    if (Number.isFinite(header) && header > 0) retryAfterMs = header * 1000;
  }
  const failure = new ApiFailure(classify(res.status, code), res.status, code, retryAfterMs);
  if (failure.kind === 'unauthenticated' && !opts.quiet401) onSessionLost?.();
  throw failure;
}

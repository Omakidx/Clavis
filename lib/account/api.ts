import { z } from 'zod';
import { ApiError, type ErrorCode } from '../../shared/api-contract/errors';
import { OVERRIDES_ALLOWED } from './config';
import { isLocalHost } from './dev-config';

/**
 * The Clavis API client (docs/clavis-sync-design.md 5). Background only (rule R2). It requests
 * the configured origin and nothing else (rule R4), never follows a redirect (a Bearer token must
 * not be replayed elsewhere), sends no cookies, and its errors carry only a code and a status:
 * never a body, a URL or a header, so nothing here can leak a token into a log or a reply.
 */

export type ApiFailureCode = ErrorCode | 'NETWORK' | 'BAD_RESPONSE';

export class ApiRequestError extends Error {
  readonly code: ApiFailureCode;
  readonly status: number;
  readonly retryAfterMs: number | undefined;

  constructor(code: ApiFailureCode, status: number, retryAfterMs?: number) {
    super(`api:${code}`);
    this.name = 'ApiRequestError';
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }

  /** Worth trying again later (connection trouble, rate limit, server trouble). */
  get transient(): boolean {
    return (
      this.code === 'NETWORK' ||
      this.code === 'RATE_LIMITED' ||
      this.code === 'UNAVAILABLE' ||
      this.code === 'INTERNAL' ||
      this.status >= 500
    );
  }
}

export interface RequestSpec<S extends z.ZodType | undefined> {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string>;
  body?: unknown;
  /** `Authorization: Bearer <token>` */
  token?: string;
  headers?: Record<string, string>;
  /** Schema of the 2xx JSON body; omit for 204. */
  response?: S;
  /** Abort the request (a sign-out that has run out of time). */
  signal?: AbortSignal;
  /** A file to send as the body instead of JSON (PDF upload). Sent with its own content type. */
  blob?: Blob;
  /** The time allowed for the whole exchange; the default suits JSON, a file needs longer. */
  timeoutMs?: number;
}

/** What a file download needs: the call fails with FILE_TOO_LARGE when the body is bigger. */
export interface BlobRequestSpec extends Omit<
  RequestSpec<undefined>,
  'response' | 'body' | 'blob'
> {
  maxBytes: number;
}

export interface ApiClientDeps {
  origin: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ApiClient {
  readonly origin: string;
  request<S extends z.ZodType | undefined = undefined>(
    spec: RequestSpec<S>,
  ): Promise<S extends z.ZodType ? z.infer<S> : undefined>;
  /** Download a file. The body is read up to `maxBytes` and the request is aborted beyond that. */
  requestBlob(spec: BlobRequestSpec): Promise<Blob>;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RETRY_AFTER_MS = 3_600_000;

/** `Retry-After`: seconds, or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (value === null || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(date - now, 0), MAX_RETRY_AFTER_MS);
}

/**
 * https only (rule R4). `http:` to the local machine exists only where dev overrides are compiled
 * in (the same compile-time switch lib/account/config.ts uses), so a store build has no such path.
 */
function acceptedOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.username !== '' || url.password !== '') return null;
  if (url.protocol === 'https:') return url.origin;
  if (OVERRIDES_ALLOWED && url.protocol === 'http:' && isLocalHost(url.hostname)) return url.origin;
  return null;
}

export function createApiClient(deps: ApiClientDeps): ApiClient {
  const origin = acceptedOrigin(deps.origin);
  if (origin === null) throw new Error('api-origin-not-allowed');
  const allowedOrigin: string = origin;
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /**
   * One exchange: build the request, send it, map a failure to an ApiRequestError, and hand a
   * successful response to `readOk` while the timer still runs (so a stalled body is bounded too).
   */
  async function exchange<T>(
    spec: Omit<RequestSpec<undefined>, 'response'>,
    accept: string,
    readOk: (
      response: Response,
      bounded: <U>(promise: Promise<U>) => Promise<U>,
      controller: AbortController,
    ) => Promise<T>,
  ): Promise<T> {
    const url = new URL(spec.path, allowedOrigin);
    if (url.origin !== allowedOrigin) throw new ApiRequestError('BAD_RESPONSE', 0);
    for (const [name, value] of Object.entries(spec.query ?? {})) {
      url.searchParams.set(name, value);
    }
    const headers: Record<string, string> = { Accept: accept, ...spec.headers };
    let body: BodyInit | undefined;
    if (spec.blob !== undefined) {
      headers['Content-Type'] = spec.blob.type === '' ? 'application/octet-stream' : spec.blob.type;
      body = spec.blob;
    } else if (spec.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(spec.body);
    }
    if (spec.token !== undefined) headers['Authorization'] = `Bearer ${spec.token}`;

    // One timer covers the whole exchange, body included: it is cleared only when the body is
    // read (or the request failed), so a server that sends headers and then stalls cannot hold
    // the caller (and the sync lock behind it) forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), spec.timeoutMs ?? timeoutMs);
    if (spec.signal?.aborted === true) controller.abort();
    else spec.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    // A fetch stand-in that ignores `signal` must not outlive the abort either.
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('aborted')), {
        once: true,
      });
    });
    aborted.catch(() => undefined);
    const bounded = <U>(promise: Promise<U>): Promise<U> => Promise.race([promise, aborted]);
    try {
      let response: Response;
      try {
        response = await bounded(
          (deps.fetch ?? fetch)(url.toString(), {
            method: spec.method,
            headers,
            ...(body === undefined ? {} : { body }),
            redirect: 'error',
            credentials: 'omit',
            cache: 'no-store',
            signal: controller.signal,
          }),
        );
      } catch {
        throw new ApiRequestError('NETWORK', 0);
      }

      if (!response.ok) {
        let code: ApiFailureCode = response.status >= 500 ? 'UNAVAILABLE' : 'BAD_RESPONSE';
        let retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
        try {
          const parsed = ApiError.safeParse(await bounded(response.json()));
          if (parsed.success) {
            code = parsed.data.error.code;
            retryAfterMs ??= parsed.data.error.retryAfterMs;
          }
        } catch {
          // Not an envelope (a proxy page, an empty body, a stalled body): the status decides.
        }
        // A bare 404 (the file route answers one without an envelope) is still "not found".
        if (code === 'BAD_RESPONSE' && response.status === 404) code = 'NOT_FOUND';
        throw new ApiRequestError(code, response.status, retryAfterMs);
      }
      return await readOk(response, bounded, controller);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    origin: allowedOrigin,
    request<S extends z.ZodType | undefined = undefined>(spec: RequestSpec<S>) {
      return exchange(spec, 'application/json', async (response, bounded, controller) => {
        if (spec.response === undefined) {
          return undefined as S extends z.ZodType ? z.infer<S> : undefined;
        }
        let json: unknown;
        try {
          json = await bounded(response.json());
        } catch {
          throw new ApiRequestError(
            controller.signal.aborted ? 'NETWORK' : 'BAD_RESPONSE',
            response.status,
          );
        }
        const parsed = spec.response.safeParse(json);
        if (!parsed.success) throw new ApiRequestError('BAD_RESPONSE', response.status);
        return parsed.data as S extends z.ZodType ? z.infer<S> : undefined;
      });
    },

    requestBlob(spec: BlobRequestSpec) {
      return exchange(spec, 'application/pdf', async (response, bounded, controller) => {
        const { maxBytes } = spec;
        const tooLarge = (): ApiRequestError => {
          controller.abort();
          return new ApiRequestError('FILE_TOO_LARGE', response.status);
        };
        const declared = Number(response.headers.get('Content-Length'));
        if (Number.isFinite(declared) && declared > maxBytes) {
          void response.body?.cancel().catch(() => undefined);
          throw tooLarge();
        }
        const reader = response.body?.getReader();
        if (reader === undefined) throw new ApiRequestError('BAD_RESPONSE', response.status);
        const chunks: Uint8Array<ArrayBuffer>[] = [];
        let received = 0;
        try {
          for (;;) {
            const { done, value } = await bounded(reader.read());
            if (done) break;
            received += value.byteLength;
            if (received > maxBytes) {
              void reader.cancel().catch(() => undefined);
              throw tooLarge();
            }
            chunks.push(value as Uint8Array<ArrayBuffer>);
          }
        } catch (error) {
          if (error instanceof ApiRequestError) throw error;
          throw new ApiRequestError('NETWORK', response.status);
        }
        return new Blob(chunks, { type: 'application/pdf' });
      });
    },
  };
}

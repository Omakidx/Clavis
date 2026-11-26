import type { Context } from 'hono';
import { ERROR_STATUS, type ApiError, type ErrorCode } from '../../../shared/api-contract';
import type { z } from 'zod';
import { readJsonBody } from './body';

/** An error that maps to the §5 envelope. Messages are static English text: never user content or secrets. */
export class ApiException extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly extra: Partial<Omit<ApiError['error'], 'code' | 'message'>> = {},
  ) {
    super(message);
    this.name = 'ApiException';
  }
  get status(): number {
    return ERROR_STATUS[this.code];
  }
}

export function errorBody(
  code: ErrorCode,
  message: string,
  extra: Partial<Omit<ApiError['error'], 'code' | 'message'>> = {},
): ApiError {
  return { error: { code, message, ...extra } };
}

/** Send the envelope. RATE_LIMITED / UNAVAILABLE with retryAfterMs also set `Retry-After`. */
export function sendError(c: Context, err: ApiException) {
  if (err.extra.retryAfterMs !== undefined) {
    c.header('Retry-After', String(Math.max(1, Math.ceil(err.extra.retryAfterMs / 1000))));
  }
  return c.json(errorBody(err.code, err.message, err.extra), err.status as never);
}

/** Validate untrusted input. Reports only the field path, never the offending value. */
export function parseOrThrow<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const field = r.error.issues[0]?.path.join('.');
  throw new ApiException('VALIDATION_FAILED', 'Request validation failed', {
    ...(field ? { details: { field } } : {}),
  });
}

/** Read a JSON body of an `application/json` request, then validate it. */
export async function parseJsonBody<S extends z.ZodType>(
  c: Context,
  schema: S,
): Promise<z.infer<S>> {
  return parseOrThrow(schema, await readJsonBody(c));
}

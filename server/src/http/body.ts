import type { Context } from 'hono';
import { ApiException } from './errors';

/** Read an `application/json` request body without validating its shape. */
export async function readJsonBody(c: Context): Promise<unknown> {
  const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') {
    throw new ApiException('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
  }
  try {
    return await c.req.json();
  } catch {
    throw new ApiException('VALIDATION_FAILED', 'Request body is not valid JSON');
  }
}

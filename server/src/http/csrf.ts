import type { Context } from 'hono';
import { safeEqual } from '../auth/crypto';
import { ApiException } from './errors';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Design §2.5 CSRF rules for cookie-authenticated, state-changing requests:
 * (b) `Origin` exactly equals PUBLIC_ORIGIN, (c) `X-CSRF-Token` equals the session's token (constant time),
 * (d) a request with a body must be `application/json`. (a) SameSite=Lax is set on the cookie.
 * Any failure is `403 CSRF_FAILED`.
 */
export function assertCsrf(c: Context, sessionCsrfToken: string, publicOrigin: string): void {
  if (SAFE_METHODS.has(c.req.method)) return;
  const fail = (): never => {
    throw new ApiException('CSRF_FAILED', 'CSRF check failed');
  };
  if (c.req.header('origin') !== publicOrigin) fail();
  const presented = c.req.header('x-csrf-token');
  if (!presented || !safeEqual(presented, sessionCsrfToken)) fail();
  const hasBody =
    c.req.header('transfer-encoding') !== undefined ||
    (c.req.header('content-length') !== undefined && c.req.header('content-length') !== '0');
  const rawType = c.req.header('content-type');
  // A declared content type counts too: a body may be present without a length header.
  if (hasBody || rawType) {
    const type = (rawType ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/json') fail();
  }
}

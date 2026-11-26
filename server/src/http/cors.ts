import type { MiddlewareHandler } from 'hono';
import { ApiException } from './errors';

const ALLOW_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const ALLOW_HEADERS = 'Authorization, Content-Type, Idempotency-Key';

/**
 * CORS for Bearer routes (design §2.6). Allowed origins are exactly `chrome-extension://<allowed id>`.
 * No wildcard and no `Access-Control-Allow-Credentials`. A preflight from any other origin is a 403;
 * a non-preflight request from another origin simply gets no CORS headers (the browser blocks the read).
 * Same-origin requests (the dashboard) carry no extension origin and receive no CORS headers.
 */
export function bearerCors(
  allowedOrigins: readonly string[],
  opts: { skip?: (path: string) => boolean } = {},
): MiddlewareHandler {
  const allowed = new Set(allowedOrigins);
  return async (c, next) => {
    if (opts.skip?.(c.req.path)) return next();
    const origin = c.req.header('origin');
    c.header('Vary', 'Origin', { append: true });
    const ok = origin !== undefined && allowed.has(origin);
    if (c.req.method === 'OPTIONS') {
      if (!ok) throw new ApiException('FORBIDDEN', 'Origin is not allowed');
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Methods', ALLOW_METHODS);
      c.header('Access-Control-Allow-Headers', ALLOW_HEADERS);
      c.header('Access-Control-Max-Age', '600');
      return c.body(null, 204);
    }
    await next();
    if (ok) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Expose-Headers', 'Retry-After, X-Request-Id');
    }
  };
}

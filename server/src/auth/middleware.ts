import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { ApiException } from '../http/errors';
import { assertCsrf } from '../http/csrf';
import type { AppEnv } from '../http/types';
import type { AuthRuntime } from './runtime';

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

/** Bearer access token. Sets `auth` or throws 401 (UNAUTHENTICATED / TOKEN_EXPIRED / SESSION_REVOKED). */
export function requireBearer(rt: AuthRuntime): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const m = BEARER.exec(c.req.header('authorization') ?? '');
    if (!m?.[1]) throw new ApiException('UNAUTHENTICATED', 'Missing bearer token');
    const { userId, familyId } = await rt.service.authenticateBearer(m[1]);
    c.set('auth', { kind: 'bearer', userId, familyId });
    await next();
  };
}

/** Cookie session plus the §2.5 CSRF rules on non-GET requests. */
export function requireCookie(rt: AuthRuntime): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = getCookie(c, rt.cookies.session);
    const session = token ? await rt.store.getWebSession(token, new Date(rt.now())) : undefined;
    if (!session) throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    assertCsrf(c, session.csrfToken, rt.config.publicOrigin);
    c.set('auth', {
      kind: 'cookie',
      userId: session.user.id,
      sessionId: session.id,
      csrfToken: session.csrfToken,
      authenticatedAt: session.authenticatedAt,
    });
    await next();
  };
}

/** `B|C`: an Authorization header selects Bearer (no CSRF needed); otherwise the cookie session applies. */
export function requireBearerOrCookie(rt: AuthRuntime): MiddlewareHandler<AppEnv> {
  const bearer = requireBearer(rt);
  const cookie = requireCookie(rt);
  return (c, next) =>
    c.req.header('authorization') !== undefined ? bearer(c, next) : cookie(c, next);
}

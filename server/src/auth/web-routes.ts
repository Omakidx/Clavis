import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import {
  AuthCallbackQuery,
  AuthStartQuery,
  type SessionResponse,
} from '../../../shared/api-contract';
import { ApiException, parseOrThrow } from '../http/errors';
import { enforce, ipRateLimit, perMinute } from '../http/rate-limit';
import type { AppEnv } from '../http/types';
import { randomToken, safeEqual, seal, unseal } from './crypto';
import { GoogleAuthError, GoogleUnavailableError } from './google';
import { requireCookie } from './middleware';
import type { AuthRuntime } from './runtime';
import { toUser } from './service';

const OAUTH_COOKIE_MAX_AGE_S = 600;
const OauthCookie = z.object({
  s: z.string().min(1),
  n: z.string().min(1),
  v: z.string().min(43),
  /** Set by `?reauth=1`: the callback then requires a fresh Google `auth_time`. */
  r: z.boolean().optional(),
  /** Expiry, epoch ms: the cookie Max-Age is advisory for a hostile client, this is authoritative. */
  exp: z.number(),
});

const FAILED = '/?signin=failed';
const REAUTH_MAX_AGE_MS = 10 * 60_000;
const CLOCK_SKEW_MS = 60_000;

/** `/auth/*` and `/v1/session`: dashboard sign-in with a server-side OAuth redirect (design §2.5). */
export function webRoutes(rt: AuthRuntime): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const trust = rt.config;
  const redirectUri = `${rt.config.publicOrigin}/auth/google/callback`;
  const cookieOpts = {
    path: '/',
    httpOnly: true,
    secure: rt.https,
    sameSite: 'Lax' as const,
  };

  app.get('/auth/google/start', ipRateLimit(rt.limiter, 'web-start', perMinute(20), trust), (c) => {
    const q = parseOrThrow(AuthStartQuery, c.req.query());
    const state = randomToken(16);
    const nonce = randomToken(16);
    const codeVerifier = randomToken(32);
    setCookie(
      c,
      rt.cookies.oauth,
      seal(rt.config.stateCookieSecret, {
        s: state,
        n: nonce,
        v: codeVerifier,
        r: q.reauth === '1',
        exp: rt.now() + OAUTH_COOKIE_MAX_AGE_S * 1000,
      }),
      { ...cookieOpts, maxAge: OAUTH_COOKIE_MAX_AGE_S },
    );
    const url = rt.google.authUrl({
      redirectUri,
      state,
      nonce,
      codeVerifier,
      reauth: q.reauth === '1',
    });
    return c.redirect(url, 302);
  });

  app.get(
    '/auth/google/callback',
    ipRateLimit(rt.limiter, 'web-callback', perMinute(20), trust),
    async (c) => {
      const failed = (reason: string) => {
        c.set('errorCode', `SIGNIN_${reason.toUpperCase()}`); // access log only; the browser sees a fixed redirect
        deleteCookie(c, rt.cookies.oauth, { path: '/', secure: rt.https });
        // Fixed destination: there is no user-supplied redirect target anywhere (no open redirect).
        return c.redirect(FAILED, 302);
      };
      const q = AuthCallbackQuery.safeParse(c.req.query());
      if (!q.success || q.data.error || !q.data.code || !q.data.state) return failed('denied');

      const sealed = getCookie(c, rt.cookies.oauth);
      const parsed = sealed
        ? OauthCookie.safeParse(unseal(rt.config.stateCookieSecret, sealed))
        : undefined;
      if (!parsed?.success) return failed('no_cookie');
      const o = parsed.data;
      if (o.exp <= rt.now()) return failed('expired');
      if (!safeEqual(q.data.state, o.s)) return failed('state');

      try {
        const idToken = await rt.google.exchangeCode(q.data.code, o.v, redirectUri);
        const identity = await rt.google.verifyIdToken(idToken, o.n);
        const now = new Date(rt.now());
        let authenticatedAt = now;
        if (o.r) {
          // Re-auth must be a login Google performed just now (§8.4): bind authenticated_at to its `auth_time`.
          const authMs = identity.authTime === undefined ? NaN : identity.authTime * 1000;
          if (
            !Number.isFinite(authMs) ||
            now.getTime() - authMs > REAUTH_MAX_AGE_MS + CLOCK_SKEW_MS ||
            authMs - now.getTime() > CLOCK_SKEW_MS
          ) {
            return failed('reauth_stale');
          }
          authenticatedAt = new Date(Math.min(authMs, now.getTime()));
        }
        const user = await rt.store.upsertGoogleUser(identity, now);
        // Rotate the session on every login: an old cookie must not survive a new Google login.
        const old = getCookie(c, rt.cookies.session);
        if (old) await rt.store.revokeWebSessionByToken(old, now);
        const session = await rt.store.createWebSession(user.id, now, authenticatedAt);
        deleteCookie(c, rt.cookies.oauth, { path: '/', secure: rt.https });
        setCookie(c, rt.cookies.session, session.token, { ...cookieOpts, maxAge: session.maxAgeS });
        return c.redirect('/', 302);
      } catch (err) {
        if (err instanceof GoogleAuthError) return failed(err.kind);
        if (err instanceof GoogleUnavailableError) return failed('unavailable');
        // Anything else (database, bug): still send the browser somewhere sane. The access log records the code.
        return failed('internal');
      }
    },
  );

  const auth = requireCookie(rt);

  app.post('/auth/logout', auth, async (c) => {
    const a = c.get('auth');
    const token = getCookie(c, rt.cookies.session);
    if (a?.kind !== 'cookie' || !token)
      throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    await rt.store.revokeWebSessionByToken(token, new Date(rt.now()));
    deleteCookie(c, rt.cookies.session, { path: '/', secure: rt.https });
    return c.body(null, 204);
  });

  app.get('/v1/session', auth, async (c) => {
    const a = c.get('auth');
    if (a?.kind !== 'cookie') throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    enforce(rt.limiter, `user:session:${a.userId}`, perMinute(120));
    const user = await rt.store.getUser(a.userId);
    if (!user) throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    const body: SessionResponse = {
      user: toUser(user),
      csrfToken: a.csrfToken,
      authenticatedAt: a.authenticatedAt.getTime(),
    };
    return c.json(body);
  });

  return app;
}

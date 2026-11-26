import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { LIMITS, type AccountResponse, type MetaResponse } from '../../../shared/api-contract';
import { requireBearerOrCookie } from '../auth/middleware';
import type { AuthRuntime } from '../auth/runtime';
import { toUser } from '../auth/service';
import { ApiException } from '../http/errors';
import { enforce, perHour, perMinute, type RateLimiter } from '../http/rate-limit';
import type { AppEnv } from '../http/types';
import { clientIp } from '../http/rate-limit';

/** GET /v1/meta: public, no database. */
export function metaRoutes(limiter: RateLimiter, trustProxy: boolean): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/v1/meta', (c) => {
    enforce(limiter, `ip:meta:${clientIp(c, trustProxy)}`, perMinute(60));
    const body: MetaResponse = {
      apiVersion: 1,
      limits: {
        maxFileBytes: LIMITS.maxFileBytes,
        quotaBytes: LIMITS.quotaBytes,
        maxWords: LIMITS.maxWords,
        maxMessagesPerWord: LIMITS.maxMessagesPerWord,
        maxDocuments: LIMITS.maxDocuments,
        maxHighlightsPerDocument: LIMITS.maxHighlightsPerDocument,
        maxPushChanges: LIMITS.maxPushChanges,
        maxPullLimit: LIMITS.maxPullLimit,
      },
    };
    return c.json(body);
  });
  return app;
}

/** GET /v1/account and POST /v1/account/logout-all (`B|C`). */
export function accountRoutes(rt: AuthRuntime): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const auth = requireBearerOrCookie(rt);

  app.get('/v1/account', auth, async (c) => {
    const a = c.get('auth');
    if (!a) throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    enforce(rt.limiter, `user:account:${a.userId}`, perMinute(120));
    const user = await rt.store.getUser(a.userId);
    if (!user) throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    const counts = await rt.store.usageCounts(a.userId);
    const body: AccountResponse = {
      user: toUser(user),
      usage: {
        storageUsedBytes: Number(user.storageUsedBytes),
        storageQuotaBytes: Number(user.storageQuotaBytes),
        words: counts.words,
        documents: counts.documents,
      },
    };
    return c.json(body);
  });

  app.post('/v1/account/logout-all', auth, async (c) => {
    const a = c.get('auth');
    if (!a) throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    enforce(rt.limiter, `user:logout-all:${a.userId}`, perHour(5));
    await rt.service.logoutAll(a.userId);
    if (a.kind === 'cookie') deleteCookie(c, rt.cookies.session, { path: '/', secure: rt.https });
    return c.body(null, 204);
  });

  return app;
}

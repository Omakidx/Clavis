import { Hono, type MiddlewareHandler } from 'hono';
import { deleteCookie } from 'hono/cookie';
import {
  DeleteAccountRequest,
  LIMITS,
  type AccountResponse,
  type MetaResponse,
} from '../../../shared/api-contract';
import { requireBearerOrCookie, requireCookie } from '../auth/middleware';
import type { AuthRuntime } from '../auth/runtime';
import { toUser } from '../auth/service';
import type { Database } from '../db/client';
import { deleteAccount } from '../db/queries';
import { ApiException, parseJsonBody } from '../http/errors';
import type { Logger } from '../logger';
import { deleteQueuedPrefix } from '../storage/deletions';
import type { ObjectStorage } from '../storage/types';
import { planExport, startExport } from './export';
import {
  clientIp,
  enforce,
  perDay,
  perHour,
  perMinute,
  type ClientIpSource,
  type RateLimiter,
} from '../http/rate-limit';
import type { AppEnv } from '../http/types';

/** GET /v1/meta: public, no database. */
export function metaRoutes(limiter: RateLimiter, ipSource: ClientIpSource): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/v1/meta', (c) => {
    enforce(limiter, `ip:meta:${clientIp(c, ipSource)}`, perMinute(60));
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

/** DELETE /v1/account needs a Google login at most this old (design §8.4). */
export const REAUTH_WINDOW_MS = 10 * 60_000;
/** Exports hold a database connection while they stream: cap them process-wide as well as per user. */
export const MAX_CONCURRENT_EXPORTS = 4;

/** GET /v1/account, POST /v1/account/logout-all (`B|C`), GET /v1/account/export and DELETE /v1/account (`C`). */
export function accountRoutes(
  rt: AuthRuntime,
  db: Database,
  logger: Logger,
  storage?: ObjectStorage | undefined,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const auth = requireBearerOrCookie(rt);
  const cookieAuth = requireCookie(rt);
  /** Users with an export in flight (one replica, so a process-local set is exact). */
  const exporting = new Map<string, { abort: (reason: string) => void }>();

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

  // Cookie-only navigational download (the dashboard uses a plain link): a GET, so no CSRF rules, and no re-auth.
  // HEAD would otherwise run this handler too (Hono routes HEAD to GET): refuse it before it touches anything.
  const refuseHead: MiddlewareHandler<AppEnv> = (c, next) =>
    c.req.method === 'HEAD' ? Promise.resolve(c.body(null, 405, { Allow: 'GET' })) : next();
  app.get('/v1/account/export', refuseHead, cookieAuth, async (c) => {
    const a = c.get('auth');
    if (a?.kind !== 'cookie') throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    const uid = a.userId;
    // Only a navigation of this site (or a typed/bookmarked URL) may start an export; spends nothing.
    const site = c.req.header('sec-fetch-site');
    if (site !== undefined && site !== 'same-origin' && site !== 'none') {
      throw new ApiException('FORBIDDEN', 'Cross-site export is not allowed');
    }
    // One export at a time per user, and a process-wide cap (each holds a database connection while it streams).
    if (exporting.has(uid)) {
      throw new ApiException('RATE_LIMITED', 'An export is already in progress', {
        retryAfterMs: 10_000,
      });
    }
    if (exporting.size >= MAX_CONCURRENT_EXPORTS) {
      throw new ApiException('RATE_LIMITED', 'Too many exports are running; try again shortly', {
        retryAfterMs: 10_000,
      });
    }
    const slot: { abort: (reason: string) => void } = { abort: () => undefined };
    exporting.set(uid, slot);
    let started = false;
    try {
      const plan = await planExport(db, storage, logger, uid);
      // The daily token is spent only once the export can really start: a pre-stream 503 costs nothing.
      enforce(rt.limiter, `user:export:${uid}`, perDay(3));
      const nowMs = rt.now();
      const stream = startExport({
        db,
        storage,
        logger,
        userId: uid,
        nowMs,
        plan,
        onClose: () => exporting.delete(uid),
      });
      slot.abort = stream.abort;
      started = true;
      const day = new Date(nowMs).toISOString().slice(0, 10);
      return c.body(stream.body, 200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="clavis-export-${day}.zip"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
    } finally {
      if (!started) exporting.delete(uid);
    }
  });

  app.delete('/v1/account', cookieAuth, async (c) => {
    const a = c.get('auth');
    if (a?.kind !== 'cookie') throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    enforce(rt.limiter, `user:account-delete:${a.userId}`, perHour(3));
    await parseJsonBody(c, DeleteAccountRequest);
    if (rt.now() - a.authenticatedAt.getTime() > REAUTH_WINDOW_MS) {
      throw new ApiException('REAUTH_REQUIRED', 'Sign in again to delete your account');
    }
    const uid = a.userId;
    const families = await rt.service.familyIdsForUser(uid);
    if (!(await deleteAccount(db, uid))) {
      throw new ApiException('UNAUTHENTICATED', 'Account no longer exists');
    }
    // Committed: every row (sessions, refresh families, content, uploads, idempotency keys) is gone. Make this
    // process refuse the user's still-valid access tokens at once, then clear the cookie.
    rt.service.accountDeleted(uid, families);
    // An export in flight would keep streaming the snapshot of data that no longer exists: stop it now.
    exporting.get(uid)?.abort('account deleted');
    deleteCookie(c, rt.cookies.session, { path: '/', secure: rt.https });
    logger.info({ route: 'account/delete' }, 'account deleted');
    // The durable prefix job is the guarantee; try it inline for at most INLINE_DEADLINE_MS.
    await deleteQueuedPrefix(db, storage, logger, `u/${uid}/`);
    return c.body(null, 204);
  });

  return app;
}

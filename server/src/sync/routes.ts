import { Hono } from 'hono';
import { z } from 'zod';
import {
  IdempotencyKeyHeader,
  LIMITS,
  PullQuery,
  type PullResponse,
} from '../../../shared/api-contract';
import { requireBearer } from '../auth/middleware';
import type { AuthRuntime } from '../auth/runtime';
import type { Database } from '../db/client';
import { readJsonBody } from '../http/body';
import { ApiException, parseOrThrow } from '../http/errors';
import { enforce, perMinute } from '../http/rate-limit';
import type { AppEnv } from '../http/types';
import type { Logger } from '../logger';
import { pullChanges } from './pull';
import { hashBody, pushChanges } from './push';

const MAX_SEQ = 2n ** 63n - 1n;
const Envelope = z.strictObject({
  changes: z.array(z.unknown()).min(1).max(LIMITS.maxPushChanges),
});

/** POST /v1/sync/push and GET /v1/sync/pull (`B`: Bearer only; no cookie route, hence no CSRF surface). */
export function syncRoutes(rt: AuthRuntime, db: Database, logger: Logger): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const auth = requireBearer(rt);
  const userId = (c: { get(k: 'auth'): { userId: string } | undefined }): string => {
    const a = c.get('auth');
    if (!a) throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    return a.userId;
  };

  app.post('/v1/sync/push', auth, async (c) => {
    const uid = userId(c);
    enforce(rt.limiter, `user:push:${uid}`, perMinute(60));
    const key = IdempotencyKeyHeader.safeParse(c.req.header('idempotency-key'));
    if (!key.success) {
      throw new ApiException('VALIDATION_FAILED', 'Idempotency-Key must be a UUID', {
        details: { field: 'Idempotency-Key' },
      });
    }
    const raw = await readJsonBody(c);
    const body = parseOrThrow(Envelope, raw);
    let requestHash: Buffer;
    try {
      requestHash = hashBody(raw);
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      throw new ApiException('VALIDATION_FAILED', 'Request body is nested too deeply');
    }
    const response = await pushChanges(db, {
      userId: uid,
      idempotencyKey: key.data,
      requestHash,
      items: body.changes,
      nowMs: rt.now(),
      warn: (msg) => logger.warn({ route: 'sync/push' }, msg),
    });
    return c.json(response);
  });

  app.get('/v1/sync/pull', auth, async (c) => {
    const uid = userId(c);
    enforce(rt.limiter, `user:pull:${uid}`, perMinute(120));
    const q = parseOrThrow(PullQuery, c.req.query());
    const cursor = BigInt(q.cursor);
    if (cursor > MAX_SEQ) {
      throw new ApiException('VALIDATION_FAILED', 'Request validation failed', {
        details: { field: 'cursor' },
      });
    }
    const body: PullResponse = await pullChanges(db, uid, cursor, q.limit);
    return c.json(body);
  });

  return app;
}

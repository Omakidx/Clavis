import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { ERROR_STATUS, LIMITS } from '../../shared/api-contract';
import { accountRoutes, metaRoutes } from './account/routes';
import { extensionRoutes } from './auth/extension-routes';
import type { GoogleClient } from './auth/google';
import { createAuthRuntime } from './auth/runtime';
import { webRoutes } from './auth/web-routes';
import type { Config } from './config';
import type { DbHandle } from './db/client';
import { bearerCors } from './http/cors';
import { ApiException, errorBody, sendError } from './http/errors';
import { RateLimiter } from './http/rate-limit';
import type { AppEnv } from './http/types';
import type { Logger } from './logger';
import { fileRoutes } from './documents/file-routes';
import { documentRoutes } from './documents/routes';
import type { ObjectStorage } from './storage/types';
import { dashboardStatic, isApiPath } from './static';
import { syncRoutes } from './sync/routes';
import { wordRoutes } from './words/routes';

export { errorBody } from './http/errors';

export interface AppDeps {
  config: Config;
  logger: Logger;
  /** Absent when DATABASE_URL is unset: /readyz then reports 503 and auth routes answer 503. */
  db?: (Pick<DbHandle, 'ping'> & Partial<Pick<DbHandle, 'db'>>) | undefined;
  /** Directory holding the built dashboard; omitted to serve no static files. */
  dashboardDir?: string | undefined;
  /** Test seams. */
  now?: (() => number) | undefined;
  google?: GoogleClient | undefined;
  limiter?: RateLimiter | undefined;
  /** PDF object storage. Absent when S3 is not configured: file routes then answer 503 UNAVAILABLE. */
  storage?: ObjectStorage | undefined;
}

/** Routes that never get CORS headers: cookie-only dashboard routes (design §2.6). */
const NO_CORS = new Set(['/v1/session', '/v1/account/export']);

export function createApp({
  config,
  logger,
  db,
  dashboardDir,
  now,
  google,
  limiter,
  storage,
}: AppDeps) {
  const app = new Hono<AppEnv>();
  const clock = now ?? Date.now;
  const rateLimiter = limiter ?? new RateLimiter(clock);

  // Access log (design §8.6): route template, status, duration, error code and the internal user id only.
  // Never the concrete path, query string, headers, bodies, IPs or emails.
  app.use(async (c, next) => {
    const started = performance.now();
    const requestId = randomUUID();
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    await next();
    if (c.req.path === '/healthz' && c.res.status === 200) return; // keep probe noise out of the logs
    const handler = c.req.matchedRoutes.filter((r) => r.method !== 'ALL').at(-1)?.path;
    logger.info(
      {
        requestId,
        method: c.req.method,
        route: isApiPath(c.req.path) ? (handler ?? '(unmatched)') : '(static)',
        status: c.res.status,
        ms: Math.round(performance.now() - started),
        ...(c.get('errorCode') ? { errorCode: c.get('errorCode') } : {}),
        ...(c.get('auth') ? { userId: c.get('auth')?.userId } : {}),
      },
      'request',
    );
  });

  // The API is JSON and must never be cached (design §5.4). Static files set their own headers.
  app.use(async (c, next) => {
    await next();
    // A route may set a stricter value itself (the PDF download: `private, no-store`).
    if (isApiPath(c.req.path) && !c.res.headers.has('Cache-Control')) {
      c.header('Cache-Control', 'no-store');
    }
  });

  // Baseline hardening on every response (API, errors and static). HSTS only where the origin is https.
  const https = config.publicOrigin?.startsWith('https://') ?? false;
  app.use(async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    if (https) c.header('Strict-Transport-Security', 'max-age=31536000');
  });

  app.use('/v1/*', bearerCors(config.allowedExtensionOrigins, { skip: (p) => NO_CORS.has(p) }));
  const limitJson = bodyLimit({
    maxSize: LIMITS.maxJsonBodyBytes,
    onError: (c) => {
      c.set('errorCode', 'PAYLOAD_TOO_LARGE');
      return c.json(errorBody('PAYLOAD_TOO_LARGE', 'Request body is too large'), 413);
    },
  });
  // The 512 KiB JSON limit does not apply to the PDF upload: its own limit is 15 MiB, enforced in the route.
  const isFilePut = (method: string, path: string) =>
    method === 'PUT' && /^\/v1\/documents\/[^/]+\/file$/.test(path);
  for (const p of ['/v1/*', '/auth/*']) {
    app.use(p, (c, next) => (isFilePut(c.req.method, c.req.path) ? next() : limitJson(c, next)));
  }

  app.get('/healthz', (c) => c.json({ status: 'ok' as const }));

  app.get('/readyz', async (c) => {
    if (db && (await db.ping())) return c.json({ status: 'ok' as const });
    return c.json(
      errorBody('UNAVAILABLE', 'Database is not ready', { retryAfterMs: 5000 }),
      ERROR_STATUS.UNAVAILABLE,
    );
  });

  app.route('/', metaRoutes(rateLimiter, config));

  const runtime = createAuthRuntime({
    config,
    db: db?.db,
    limiter: rateLimiter,
    now: clock,
    google,
  });
  if (runtime && db?.db) {
    app.route('/v1/auth/extension', extensionRoutes(runtime));
    app.route('/', webRoutes(runtime));
    app.route('/', accountRoutes(runtime));
    app.route('/', syncRoutes(runtime, db.db, logger, storage));
    app.route('/', wordRoutes(runtime, db.db));
    app.route('/', documentRoutes(runtime, db.db, logger, storage));
    app.route(
      '/',
      fileRoutes(runtime, db.db, logger, storage, {
        maxConcurrentUploads: config.maxConcurrentUploads,
      }),
    );
  } else {
    // Development without Google credentials or a database: say so instead of a misleading 404.
    for (const p of [
      '/v1/auth/*',
      '/auth/*',
      '/v1/session',
      '/v1/account',
      '/v1/account/*',
      '/v1/sync/*',
      '/v1/words',
      '/v1/words/*',
      '/v1/documents',
      '/v1/documents/*',
    ]) {
      app.all(p, () => {
        throw new ApiException('UNAVAILABLE', 'Authentication is not configured');
      });
    }
  }

  if (dashboardDir) {
    app.use(dashboardStatic(dashboardDir, config.publicOrigin?.startsWith('https://') ?? false));
  }

  app.notFound((c) => c.json(errorBody('NOT_FOUND', 'Not found'), ERROR_STATUS.NOT_FOUND));

  app.onError((err, c) => {
    if (err instanceof ApiException) {
      c.set('errorCode', err.code);
      return sendError(c, err);
    }
    if (err instanceof HTTPException) {
      const code = err.status === 413 ? 'PAYLOAD_TOO_LARGE' : 'VALIDATION_FAILED';
      c.set('errorCode', code);
      return c.json(errorBody(code, 'Bad request'), err.status === 413 ? 413 : 400);
    }
    // Class name only: error messages can contain user data or connection details.
    c.set('errorCode', 'INTERNAL');
    logger.error({ name: err.name }, 'unhandled error');
    return c.json(errorBody('INTERNAL', 'Internal error'), ERROR_STATUS.INTERNAL);
  });

  return app;
}

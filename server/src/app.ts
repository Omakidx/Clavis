import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { ERROR_STATUS, type ApiError, type ErrorCode } from '../../shared/api-contract';
import type { Config } from './config';
import type { DbHandle } from './db/client';
import type { Logger } from './logger';
import { dashboardStatic, isApiPath } from './static';

export interface AppDeps {
  config: Config;
  logger: Logger;
  /** Absent when DATABASE_URL is unset: /readyz then reports 503. */
  db?: Pick<DbHandle, 'ping'> | undefined;
  /** Directory holding the built dashboard; omitted to serve no static files. */
  dashboardDir?: string | undefined;
}

export function errorBody(
  code: ErrorCode,
  message: string,
  extra: Partial<ApiError['error']> = {},
): ApiError {
  return { error: { code, message, ...extra } };
}

export function createApp({ config, logger, db, dashboardDir }: AppDeps) {
  const app = new Hono();

  // Access log: method, path (never the query string), status and duration. No IPs, headers or bodies.
  app.use(async (c, next) => {
    const started = performance.now();
    const requestId = randomUUID();
    c.header('X-Request-Id', requestId);
    await next();
    if (c.req.path === '/healthz' && c.res.status === 200) return; // keep probe noise out of the logs
    logger.info(
      {
        requestId,
        method: c.req.method,
        path: isApiPath(c.req.path) ? c.req.path.replace(/[0-9a-f]{64}/g, ':hex64') : '(static)',
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      'request',
    );
  });

  // The API is JSON and must never be cached (design §5.4). Static files set their own headers.
  app.use(async (c, next) => {
    await next();
    if (isApiPath(c.req.path)) c.header('Cache-Control', 'no-store');
  });

  app.get('/healthz', (c) => c.json({ status: 'ok' as const }));

  app.get('/readyz', async (c) => {
    if (db && (await db.ping())) return c.json({ status: 'ok' as const });
    return c.json(
      errorBody('UNAVAILABLE', 'Database is not ready', { retryAfterMs: 5000 }),
      ERROR_STATUS.UNAVAILABLE,
    );
  });

  if (dashboardDir) {
    app.use(dashboardStatic(dashboardDir, config.publicOrigin?.startsWith('https://') ?? false));
  }

  app.notFound((c) => c.json(errorBody('NOT_FOUND', 'Not found'), ERROR_STATUS.NOT_FOUND));

  app.onError((err, c) => {
    // Class name only: error messages can contain user data or connection details.
    logger.error({ name: err.name }, 'unhandled error');
    return c.json(errorBody('INTERNAL', 'Internal error'), ERROR_STATUS.INTERNAL);
  });

  return app;
}

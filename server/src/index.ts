import { serve } from '@hono/node-server';
import { createApp } from './app';
import { ConfigError, loadConfig } from './config';
import { createDb, type DbHandle } from './db/client';
import { createLogger } from './logger';
import { startJobs } from './jobs';
import { findDashboardDir } from './paths';
import { createStorage } from './storage';

let config;
try {
  config = loadConfig();
} catch (err) {
  // The logger needs a validated level, so report config failures directly. ConfigError lists names only.
  process.stderr.write(
    `${err instanceof ConfigError ? err.message : 'Failed to load configuration'}\n`,
  );
  process.exit(1);
}

const logger = createLogger(config.logLevel);
const dbHandle: DbHandle | undefined = config.databaseUrl
  ? createDb(config.databaseUrl, logger)
  : undefined;
if (!dbHandle) logger.warn('DATABASE_URL is not set: /readyz will report 503');

const dashboardDir = findDashboardDir();
if (!dashboardDir) logger.warn('dashboard build not found: static files are not served');

const storage = createStorage(config.s3, {
  onStreamError: (name) => logger.warn({ name }, 'download stream failed'),
});
if (!storage) logger.warn('S3 is not configured: PDF file routes answer 503');

const app = createApp({ config, logger, db: dbHandle, dashboardDir, storage });
const jobs =
  config.jobsEnabled && dbHandle
    ? startJobs({ handle: dbHandle, storage, logger, alertBytes: config.storageAlertBytes })
    : undefined;
const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info({ port: info.port, env: config.nodeEnv }, 'clavis-api listening');
});

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 10_000);
  force.unref();
  server.close(async () => {
    await jobs?.stop();
    await dbHandle?.close().catch(() => undefined);
    process.exit(0);
  });
  if ('closeIdleConnections' in server) server.closeIdleConnections();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

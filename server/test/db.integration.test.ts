import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDb, type DbHandle } from '../src/db/client';
import { createLogger } from '../src/logger';

// Integration tests need a real Postgres. They skip cleanly when TEST_DATABASE_URL is unset
// (e.g. `postgres://clavis:...@localhost:5433/clavis` from docker-compose.dev.yml).
const url = process.env['TEST_DATABASE_URL'];

describe.skipIf(!url)('database (real Postgres)', () => {
  let handle: DbHandle;
  const logger = createLogger('silent');

  beforeAll(() => {
    handle = createDb(url as string, logger, { max: 2 });
  });
  afterAll(async () => {
    await handle.close();
  });

  it('ping succeeds and runs queries through the pool', async () => {
    expect(await handle.ping()).toBe(true);
    const r = await handle.pool.query<{ one: number }>('SELECT 1 AS one');
    expect(r.rows[0]?.one).toBe(1);
  });

  it('/readyz is 200 against a live database', async () => {
    const app = createApp({ config: loadConfig({}), logger, db: handle });
    expect((await app.request('/readyz')).status).toBe(200);
  });

  it('applies the statement timeout', async () => {
    const short = createDb(url as string, logger, { max: 1, statementTimeoutMs: 100 });
    try {
      await expect(short.pool.query('SELECT pg_sleep(2)')).rejects.toMatchObject({ code: '57014' });
    } finally {
      await short.close();
    }
  });
});

describe('database ping when unreachable', () => {
  it('returns false instead of throwing', async () => {
    const handle = createDb('postgres://u:p@127.0.0.1:1/none', createLogger('silent'), {
      connectionTimeoutMs: 300,
    });
    try {
      expect(await handle.ping(1000)).toBe(false);
    } finally {
      await handle.close();
    }
  });
});

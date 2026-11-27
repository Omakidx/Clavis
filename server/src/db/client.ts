import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import type { Logger } from '../logger';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

export interface DbHandle {
  pool: pg.Pool;
  db: Database;
  /** `SELECT 1` bounded by a timeout; resolves true when Postgres answers. */
  ping(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface DbOptions {
  max?: number;
  connectionTimeoutMs?: number;
  statementTimeoutMs?: number;
}

/** One pool per process. Every connection gets a statement timeout so no query can hang forever. */
export function createDb(databaseUrl: string, logger: Logger, options: DbOptions = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMs ?? 5000,
    idleTimeoutMillis: 30_000,
    statement_timeout: options.statementTimeoutMs ?? 15_000,
  });
  // An idle client erroring must not crash the process. Log the code only: messages can embed host details.
  pool.on('error', (err: Error & { code?: string }) => {
    logger.error({ code: err.code, name: err.name }, 'postgres idle client error');
  });
  const db = drizzle(pool, { schema });

  async function ping(timeoutMs = 2000): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const query = pool.query('SELECT 1');
      query.catch(() => undefined); // avoid an unhandled rejection if the timeout wins the race
      await Promise.race([
        query,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('ping timeout')), timeoutMs);
        }),
      ]);
      return true;
    } catch (err) {
      const e = err as Error & { code?: string };
      logger.warn({ code: e.code, name: e.name }, 'postgres ping failed');
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return { pool, db, ping, close: () => pool.end() };
}

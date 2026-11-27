import { existsSync } from 'node:fs';
import path from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { migrationsDir } from './paths';

/* eslint-disable no-console */
// Railway pre-deploy command: `node dist/migrate.js`. Forward-only; a failure aborts the deploy.
// With no generated migrations yet (no meta/_journal.json) this is a logged no-op.
async function main(): Promise<void> {
  const folder = migrationsDir();
  if (!existsSync(path.join(folder, 'meta', '_journal.json'))) {
    console.log('migrate: no migrations found, nothing to do');
    return;
  }
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required to run migrations');
  const pool = new pg.Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 10_000 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
    console.log('migrate: migrations applied');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(`migrate failed: ${err instanceof Error ? err.name : 'unknown error'}`);
  process.exit(1);
});

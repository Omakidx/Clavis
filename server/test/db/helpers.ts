import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { createDb, type DbHandle } from '../../src/db/client';
import { createLogger } from '../../src/logger';

export const adminUrl = process.env['TEST_DATABASE_URL'];

export const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../migrations',
);

export interface TestDb {
  handle: DbHandle;
  name: string;
  drop(): Promise<void>;
}

/**
 * Creates a THROWAWAY database (clavis_test_<random>) on the server named by TEST_DATABASE_URL, applies the real
 * migrations with the real migrator, and returns a pool on it. drop() removes it. Nothing else is touched.
 */
export async function createTestDb(max = 25): Promise<TestDb> {
  const base = new URL(adminUrl as string);
  const name = `clavis_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }
  const url = new URL(base.toString());
  url.pathname = `/${name}`;
  const handle = createDb(url.toString(), createLogger('silent'), {
    max,
    statementTimeoutMs: 30_000,
  });
  await migrate(handle.db, { migrationsFolder });
  return {
    handle,
    name,
    async drop() {
      await handle.close();
      const a = new pg.Client({ connectionString: base.toString() });
      await a.connect();
      try {
        await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      } finally {
        await a.end();
      }
    },
  };
}

export const hex64 = (c = 'a') => c.repeat(64);

/** Inserts a user and returns its id. */
export async function insertUser(
  h: DbHandle,
  over: { quota?: bigint; sub?: string } = {},
): Promise<string> {
  const sub = over.sub ?? `sub-${randomBytes(8).toString('hex')}`;
  const r = await h.db.execute<{ id: string }>(
    sql`INSERT INTO users (google_sub, email, storage_quota_bytes)
        VALUES (${sub}, ${sub + '@example.test'}, ${over.quota ?? 104857600n}) RETURNING id`,
  );
  return (r.rows[0] as { id: string }).id;
}

export async function insertWord(
  h: DbHandle,
  userId: string,
  seq: bigint,
  over: { key?: string; deletedAt?: string } = {},
): Promise<string> {
  const key = over.key ?? randomBytes(32).toString('hex');
  await h.db.execute(sql`
    INSERT INTO saved_words (user_id, word_key, text, meaning, source_kind, created_at, client_modified_at, seq, deleted_at)
    VALUES (${userId}, ${key}, 'word', '{"title":"t"}'::jsonb, 'webpage', now(), now(), ${seq},
            ${over.deletedAt ?? null}::timestamptz)`);
  return key;
}

export async function insertDocument(
  h: DbHandle,
  userId: string,
  seq: bigint,
  over: { fingerprint?: string; deletedAt?: string } = {},
): Promise<string> {
  const fp = over.fingerprint ?? randomBytes(32).toString('hex');
  await h.db.execute(sql`
    INSERT INTO documents (user_id, fingerprint, client_modified_at, seq, deleted_at)
    VALUES (${userId}, ${fp}, now(), ${seq}, ${over.deletedAt ?? null}::timestamptz)`);
  return fp;
}

/** Error code of a rejected statement (pg SQLSTATE) and constraint name, via drizzle's DrizzleQueryError cause. */
export async function pgError(
  p: Promise<unknown>,
): Promise<{ code?: string; constraint?: string }> {
  try {
    await p;
  } catch (e) {
    const err = (e as { cause?: unknown }).cause ?? e;
    const { code, constraint } = err as { code?: string; constraint?: string };
    return { ...(code ? { code } : {}), ...(constraint ? { constraint } : {}) };
  }
  throw new Error('expected the statement to be rejected');
}

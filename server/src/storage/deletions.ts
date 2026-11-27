// Durable bucket deletions (docs/clavis-sync-design.md §6.4, §6.5). Rows in object_deletions are inserted in the
// same transaction as the change that orphans an object, so a crash can never leak a key permanently.
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import type { Logger } from '../logger';
import type { ObjectStorage } from './types';

export const ALERT_AFTER_ATTEMPTS = 10;
export const BATCH_SIZE = 100;

type DeletionRow = {
  id: string;
  object_key: string | null;
  object_prefix: string | null;
  attempts: number;
};

async function attempt(
  db: Database,
  storage: ObjectStorage,
  logger: Logger,
  row: DeletionRow,
): Promise<boolean> {
  try {
    if (row.object_key !== null) await storage.delete(row.object_key);
    else if (row.object_prefix !== null) await storage.deletePrefix(row.object_prefix);
    await db.execute(sql`DELETE FROM object_deletions WHERE id = ${row.id}`);
    return true;
  } catch (err) {
    const attempts = row.attempts + 1;
    // Backoff 1 min x 2^attempts, capped at 24 h. Class name only: SDK messages can embed endpoints.
    await db.execute(sql`
      UPDATE object_deletions
      SET attempts = attempts + 1,
          next_attempt_at = now() + make_interval(secs => LEAST(60 * power(2, attempts), 86400))
      WHERE id = ${row.id}`);
    const fields = { deletionId: row.id, attempts, name: (err as Error).name };
    if (attempts >= ALERT_AFTER_ATTEMPTS) logger.error(fields, 'object deletion keeps failing');
    else logger.warn(fields, 'object deletion failed, will retry');
    return false;
  }
}

/** Process due rows (oldest first). Returns how many objects/prefixes were removed. */
export async function processObjectDeletions(
  db: Database,
  storage: ObjectStorage,
  logger: Logger,
  limit = BATCH_SIZE,
): Promise<{ attempted: number; deleted: number }> {
  const due = await db.execute<DeletionRow>(sql`
    SELECT id::text AS id, object_key, object_prefix, attempts FROM object_deletions
    WHERE next_attempt_at <= now() ORDER BY next_attempt_at, id LIMIT ${limit}`);
  let deleted = 0;
  for (const row of due.rows) if (await attempt(db, storage, logger, row)) deleted += 1;
  return { attempted: due.rows.length, deleted };
}

/** Longest an inline attempt may hold up a response; the job finishes whatever is left. */
export const INLINE_DEADLINE_MS = 3000;

/**
 * Inline attempt right after a commit. Only keys that have a queued row are touched, so a key that a rolled-back
 * transaction merely considered can never be deleted by mistake. Never throws and never delays the caller by more
 * than `deadlineMs`: a slow or down bucket leaves the row queued and the job (the guarantee) retries with backoff.
 */
export async function deleteQueuedKeys(
  db: Database,
  storage: ObjectStorage | undefined,
  logger: Logger,
  keys: readonly string[],
  deadlineMs = INLINE_DEADLINE_MS,
): Promise<void> {
  if (!storage || keys.length === 0) return;
  const run = async () => {
    try {
      const rows = await db.execute<DeletionRow>(sql`
        SELECT id::text AS id, object_key, object_prefix, attempts FROM object_deletions
        WHERE object_key IN (${sql.join(
          keys.map((k) => sql`${k}`),
          sql`, `,
        )})`);
      for (const row of rows.rows) await attempt(db, storage, logger, row);
    } catch (err) {
      logger.warn({ name: (err as Error).name }, 'inline object deletion skipped');
    }
  };
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deadlineMs);
    timer.unref();
  });
  try {
    await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

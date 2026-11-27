// Single-run job bodies (docs/clavis-sync-design.md §3.3, §6.5). Exported so tests can call them directly;
// the scheduler in ./index.ts wraps them with advisory locks and intervals.
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  expireUserUploads,
  findUsersWithExpiredUploads,
  purgeIdempotencyKeys,
  purgeRefreshTokens,
  purgeTombstones,
  purgeUploads,
  purgeWebSessions,
} from '../db/queries';
import type { Logger } from '../logger';
import { processObjectDeletions } from '../storage/deletions';
import type { ObjectStorage } from '../storage/types';

/** Release the reservations of pending uploads past `expires_at` and queue their keys (§6.2.7). */
export async function expireUploads(db: Database, logger: Logger): Promise<number> {
  let total = 0;
  for (let round = 0; round < 50; round += 1) {
    const users = await findUsersWithExpiredUploads(db, 100);
    if (users.length === 0) break;
    let progressed = 0;
    for (const userId of users) progressed += await expireUserUploads(db, userId);
    total += progressed;
    if (progressed === 0) break;
  }
  if (total > 0) logger.info({ expired: total }, 'expired stale uploads');
  return total;
}

/** Drain due object_deletions rows in batches of 100 (bounded per run so one run cannot starve shutdown). */
export async function runObjectDeletions(
  db: Database,
  storage: ObjectStorage,
  logger: Logger,
  maxBatches = 20,
): Promise<{ attempted: number; deleted: number }> {
  const sum = { attempted: 0, deleted: 0 };
  for (let i = 0; i < maxBatches; i += 1) {
    const r = await processObjectDeletions(db, storage, logger);
    sum.attempted += r.attempted;
    sum.deleted += r.deleted;
    if (r.attempted < 100 || r.deleted === 0) break;
  }
  if (sum.attempted > 0) logger.info(sum, 'processed object deletions');
  return sum;
}

/** §3.3: tombstones older than 90 days, expired idempotency keys, tokens, sessions and finished uploads. */
export async function runPurge(db: Database, logger: Logger) {
  const tombstones = { users: 0, words: 0, documents: 0, highlights: 0 };
  for (let i = 0; i < 100; i += 1) {
    const r = await purgeTombstones(db);
    if (r.users === 0) break;
    tombstones.users += r.users;
    tombstones.words += r.words;
    tombstones.documents += r.documents;
    tombstones.highlights += r.highlights;
  }
  const result = {
    tombstones,
    idempotencyKeys: await purgeIdempotencyKeys(db),
    refreshTokens: await purgeRefreshTokens(db),
    webSessions: await purgeWebSessions(db),
    uploads: await purgeUploads(db),
  };
  logger.info(result, 'purge finished');
  return result;
}

const SWEEP_AGE_MS = 24 * 3_600_000;

export interface SweepOptions {
  /** Defaults to Date.now(); tests move it forward to age objects. */
  nowMs?: number;
  /** Defaults to `u/`. */
  prefix?: string;
  /** STORAGE_ALERT_BYTES: log an error when the listed objects exceed it. */
  alertBytes?: number | undefined;
}

/**
 * §6.4 orphan sweep: delete objects older than 24 h whose key is neither a document's `object_key` nor a pending
 * upload's. Also totals the listed bytes for the storage alert.
 */
export async function sweepOrphans(
  db: Database,
  storage: ObjectStorage,
  logger: Logger,
  opts: SweepOptions = {},
): Promise<{ listed: number; deleted: number; errors: number; totalBytes: number }> {
  const cutoff = (opts.nowMs ?? Date.now()) - SWEEP_AGE_MS;
  let listed = 0;
  let deleted = 0;
  let errors = 0;
  let totalBytes = 0;
  let batch: string[] = [];

  const flush = async () => {
    if (batch.length === 0) return;
    const keys = batch;
    batch = [];
    const arr = sql`ARRAY[${sql.join(
      keys.map((k) => sql`${k}`),
      sql`, `,
    )}]::text[]`;
    let keep: Set<string>;
    try {
      const referenced = await db.execute<{ k: string }>(sql`
        SELECT k FROM unnest(${arr}) AS k
        WHERE EXISTS (SELECT 1 FROM documents d WHERE d.object_key = k)
           OR EXISTS (SELECT 1 FROM uploads u WHERE u.object_key = k AND u.status = 'pending')`);
      keep = new Set(referenced.rows.map((r) => r.k));
    } catch (err) {
      // Without the reference check nothing in this batch may be deleted.
      errors += keys.length;
      logger.warn({ name: (err as Error).name }, 'orphan sweep: reference check failed');
      return;
    }
    for (const key of keys) {
      if (keep.has(key)) continue;
      try {
        await storage.delete(key);
        deleted += 1;
      } catch (err) {
        errors += 1;
        logger.warn({ name: (err as Error).name }, 'orphan sweep: delete failed');
      }
    }
  };

  try {
    for await (const o of storage.list(opts.prefix ?? 'u/')) {
      listed += 1;
      totalBytes += o.size;
      if (o.lastModified.getTime() >= cutoff) continue;
      batch.push(o.key);
      if (batch.length >= 200) await flush();
    }
  } catch (err) {
    errors += 1;
    logger.warn({ name: (err as Error).name }, 'orphan sweep: listing failed');
  }
  await flush();
  if (opts.alertBytes !== undefined && totalBytes > opts.alertBytes) {
    logger.error(
      { totalBytes, alertBytes: opts.alertBytes },
      'bucket usage is above the alert threshold',
    );
  }
  logger.info({ listed, deleted, errors, totalBytes }, 'orphan sweep finished');
  return { listed, deleted, errors, totalBytes };
}

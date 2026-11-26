// Retention purges (docs/clavis-sync-design.md §3.3). Run daily by the purge job.
//
// Contract
//   purgeTombstones(db, { olderThanDays = 90, maxUsers = 100 }): Promise<{ users, words, documents, highlights }>
//       One transaction: lock (FOR UPDATE, id order) up to maxUsers users that own tombstones older than the
//       cutoff, hard-delete their expired tombstones (highlights first, including live-less children of expired
//       document tombstones) and raise users.tombstone_floor_seq = GREATEST(floor, max purged seq).
//       Call repeatedly until it returns users = 0 to drain a backlog.
//   purgeIdempotencyKeys(db, hours = 24): Promise<number>
//   purgeRefreshTokens(db, days = 7): Promise<number>   -- expired or revoked more than `days` ago
//   purgeWebSessions(db, days = 7): Promise<number>     -- expired or revoked more than `days` ago
//   purgeUploads(db, days = 7): Promise<number>         -- finished (non-pending) rows older than `days`;
//                                                          pending rows are handled by expireUserUploads
//
// Content columns of a tombstone are nulled at DELETE time by the sync code (§3.3), not here.
import { sql } from 'drizzle-orm';
import type { Database } from '../client';
import { toBig } from './executor';

export interface TombstonePurgeResult {
  users: number;
  words: number;
  documents: number;
  highlights: number;
}

export async function purgeTombstones(
  db: Database,
  opts: { olderThanDays?: number; maxUsers?: number } = {},
): Promise<TombstonePurgeResult> {
  const days = opts.olderThanDays ?? 90;
  const maxUsers = opts.maxUsers ?? 100;
  return db.transaction(async (tx) => {
    // Lock users first (same order as writers: user row, then data rows) so purge cannot deadlock with a push.
    const locked = await tx.execute<{ id: string }>(sql`
      SELECT id FROM users WHERE id IN (
        SELECT user_id FROM saved_words WHERE deleted_at < now() - make_interval(days => ${days})
        UNION SELECT user_id FROM documents WHERE deleted_at < now() - make_interval(days => ${days})
        UNION SELECT user_id FROM highlights WHERE deleted_at < now() - make_interval(days => ${days}))
      ORDER BY id LIMIT ${maxUsers} FOR UPDATE`);
    const ids = locked.rows.map((r) => r.id);
    if (ids.length === 0) return { users: 0, words: 0, documents: 0, highlights: 0 };
    const idArray = sql`ARRAY[${sql.join(
      ids.map((i) => sql`${i}::uuid`),
      sql`, `,
    )}]`;
    const r = await tx.execute<{ words: string; documents: string; highlights: string }>(sql`
      WITH cutoff AS (SELECT now() - make_interval(days => ${days}) AS c),
      hl AS (
        DELETE FROM highlights h USING cutoff
        WHERE h.user_id = ANY(${idArray})
          AND (h.deleted_at < cutoff.c OR EXISTS (
            SELECT 1 FROM documents d
            WHERE d.user_id = h.user_id AND d.fingerprint = h.fingerprint AND d.deleted_at < cutoff.c))
        RETURNING h.user_id, h.seq),
      dc AS (
        DELETE FROM documents d USING cutoff
        WHERE d.user_id = ANY(${idArray}) AND d.deleted_at < cutoff.c
        RETURNING d.user_id, d.seq),
      sw AS (
        DELETE FROM saved_words w USING cutoff
        WHERE w.user_id = ANY(${idArray}) AND w.deleted_at < cutoff.c
        RETURNING w.user_id, w.seq),
      mx AS (
        SELECT user_id, max(seq) AS s FROM (
          SELECT * FROM hl UNION ALL SELECT * FROM dc UNION ALL SELECT * FROM sw) x GROUP BY user_id),
      fl AS (
        UPDATE users u SET tombstone_floor_seq = GREATEST(u.tombstone_floor_seq, mx.s)
        FROM mx WHERE u.id = mx.user_id RETURNING u.id)
      SELECT (SELECT count(*) FROM sw) AS words, (SELECT count(*) FROM dc) AS documents,
             (SELECT count(*) FROM hl) AS highlights, (SELECT count(*) FROM fl) AS floors`);
    const row = r.rows[0];
    return {
      users: ids.length,
      words: Number(toBig(row?.words ?? 0)),
      documents: Number(toBig(row?.documents ?? 0)),
      highlights: Number(toBig(row?.highlights ?? 0)),
    };
  });
}

async function count(db: Database, stmt: ReturnType<typeof sql>): Promise<number> {
  const r = await db.execute(stmt);
  return r.rowCount ?? 0;
}

export function purgeIdempotencyKeys(db: Database, hours = 24): Promise<number> {
  return count(
    db,
    sql`DELETE FROM idempotency_keys WHERE created_at < now() - make_interval(hours => ${hours})`,
  );
}

export function purgeRefreshTokens(db: Database, days = 7): Promise<number> {
  return count(
    db,
    sql`DELETE FROM refresh_tokens
        WHERE expires_at < now() - make_interval(days => ${days})
           OR revoked_at < now() - make_interval(days => ${days})`,
  );
}

export function purgeWebSessions(db: Database, days = 7): Promise<number> {
  return count(
    db,
    sql`DELETE FROM web_sessions
        WHERE expires_at < now() - make_interval(days => ${days})
           OR revoked_at < now() - make_interval(days => ${days})`,
  );
}

export function purgeUploads(db: Database, days = 7): Promise<number> {
  return count(
    db,
    sql`DELETE FROM uploads
        WHERE status <> 'pending' AND created_at < now() - make_interval(days => ${days})`,
  );
}

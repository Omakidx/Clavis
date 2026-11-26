// Race-free PDF quota accounting (docs/clavis-sync-design.md §3.2, §6.2, §6.4).
//
// Contract (all take the transaction executor; callers hold the user row lock via lockUserForSeq):
//   reserveQuota(tx, userId, bytes): Promise<boolean>
//       Conditional UPDATE: reserved += bytes only if used + reserved + bytes <= quota. false => 422 QUOTA_EXCEEDED.
//       Atomic even without the lock; the CHECK storage_within_quota is the backstop.
//   commitReservation(tx, userId, bytes): Promise<boolean>
//       reserved -= bytes, used += bytes (upload finished). false if the reservation does not exist.
//   releaseReservation(tx, userId, bytes): Promise<boolean>
//       reserved -= bytes (upload failed/expired/aborted). false if reserved < bytes.
//   releaseStoredBytes(tx, userId, bytes): Promise<boolean>
//       used -= bytes (file removed). false if used < bytes.
//   enqueueObjectDeletion(tx, target): Promise<void>
//       Insert a durable bucket-delete job ({ key } or { prefix }); do it in the same transaction as the change.
//   expireUserUploads(db, userId): Promise<number>
//       Sweeper step (§6.2.7): in one transaction lock the user, mark expired pending uploads 'expired',
//       release their reservation and enqueue deletion of their keys. Returns rows expired.
//   findUsersWithExpiredUploads(db, limit): Promise<string[]>
//       Candidates for the sweeper (uses uploads_expiry). Lock order is always user row first, then uploads.
//   deleteAccount(db, userId): Promise<boolean>
//       §6.4/§8.5: enqueue prefix 'u/<userId>/' then DELETE the user; FKs cascade every owned row.
import { sql } from 'drizzle-orm';
import type { Database } from '../client';
import { lockUserForSeq } from './seq';
import { toBig, type Executor } from './executor';

export async function reserveQuota(tx: Executor, userId: string, bytes: bigint): Promise<boolean> {
  const r = await tx.execute(sql`
    UPDATE users SET storage_reserved_bytes = storage_reserved_bytes + ${bytes}
    WHERE id = ${userId}
      AND storage_used_bytes + storage_reserved_bytes + ${bytes} <= storage_quota_bytes`);
  return (r.rowCount ?? 0) === 1;
}

export async function commitReservation(
  tx: Executor,
  userId: string,
  bytes: bigint,
): Promise<boolean> {
  const r = await tx.execute(sql`
    UPDATE users SET storage_reserved_bytes = storage_reserved_bytes - ${bytes},
                     storage_used_bytes = storage_used_bytes + ${bytes}
    WHERE id = ${userId} AND storage_reserved_bytes >= ${bytes}`);
  return (r.rowCount ?? 0) === 1;
}

export async function releaseReservation(
  tx: Executor,
  userId: string,
  bytes: bigint,
): Promise<boolean> {
  const r = await tx.execute(sql`
    UPDATE users SET storage_reserved_bytes = storage_reserved_bytes - ${bytes}
    WHERE id = ${userId} AND storage_reserved_bytes >= ${bytes}`);
  return (r.rowCount ?? 0) === 1;
}

export async function releaseStoredBytes(
  tx: Executor,
  userId: string,
  bytes: bigint,
): Promise<boolean> {
  const r = await tx.execute(sql`
    UPDATE users SET storage_used_bytes = storage_used_bytes - ${bytes}
    WHERE id = ${userId} AND storage_used_bytes >= ${bytes}`);
  return (r.rowCount ?? 0) === 1;
}

export async function enqueueObjectDeletion(
  tx: Executor,
  target: { key: string } | { prefix: string },
): Promise<void> {
  if ('key' in target) {
    await tx.execute(sql`INSERT INTO object_deletions (object_key) VALUES (${target.key})`);
  } else {
    await tx.execute(sql`INSERT INTO object_deletions (object_prefix) VALUES (${target.prefix})`);
  }
}

export async function findUsersWithExpiredUploads(db: Database, limit = 100): Promise<string[]> {
  const r = await db.execute<{ user_id: string }>(sql`
    SELECT DISTINCT user_id FROM (
      SELECT user_id FROM uploads WHERE status = 'pending' AND expires_at < now()
      ORDER BY expires_at LIMIT ${limit}) s`);
  return r.rows.map((row) => row.user_id);
}

export async function expireUserUploads(db: Database, userId: string): Promise<number> {
  return db.transaction(async (tx) => {
    if ((await lockUserForSeq(tx, userId)) === null) return 0;
    const r = await tx.execute<{ reserved_bytes: string; object_key: string }>(sql`
      UPDATE uploads SET status = 'expired', finished_at = now()
      WHERE user_id = ${userId} AND status = 'pending' AND expires_at < now()
      RETURNING reserved_bytes, object_key`);
    if (r.rows.length === 0) return 0;
    const total = r.rows.reduce((acc, row) => acc + toBig(row.reserved_bytes), 0n);
    await releaseReservation(tx, userId, total);
    for (const row of r.rows) await enqueueObjectDeletion(tx, { key: row.object_key });
    return r.rows.length;
  });
}

export async function deleteAccount(db: Database, userId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    await enqueueObjectDeletion(tx, { prefix: `u/${userId}/` });
    const r = await tx.execute(sql`DELETE FROM users WHERE id = ${userId}`);
    return (r.rowCount ?? 0) === 1;
  });
}

// PDF file lifecycle in Postgres (docs/clavis-sync-design.md §6.2, §6.4). Transport and S3 live elsewhere.
// Every transaction takes the user row lock first, so quota, live-count and seq checks are serialised per user.
import { randomUUID } from 'node:crypto';
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import { LIMITS } from '../../../shared/api-contract';
import type { Database } from '../db/client';
import {
  commitReservation,
  commitSeq,
  createSeqAllocator,
  enqueueObjectDeletion,
  lockUserForSeq,
  releaseReservation,
  releaseStoredBytes,
  reserveQuota,
} from '../db/queries';
import { documents, uploads } from '../db/schema';
import { ApiException } from '../http/errors';
import { MIN_CLIENT_MS } from '../sync/apply';

export const UPLOAD_TTL_MINUTES = 15;

export type Reservation =
  { kind: 'stored' } | { kind: 'reserved'; uploadId: string; objectKey: string };

/** Transaction A (§6.2 step 2): dedupe, 409 on a live pending upload, conditional quota reservation. */
export async function reserveUpload(
  db: Database,
  a: { userId: string; fingerprint: string; bytes: number },
): Promise<Reservation> {
  return db.transaction(async (tx) => {
    if ((await lockUserForSeq(tx, a.userId)) === null) {
      throw new ApiException('UNAUTHENTICATED', 'Account no longer exists');
    }
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.userId, a.userId), eq(documents.fingerprint, a.fingerprint)))
      .limit(1);
    if (doc && doc.deletedAt === null && doc.storageState === 'stored') return { kind: 'stored' };

    // A pending row past its expiry is dead (the sweeper has not reached it yet): expire it here, which also
    // frees the unique (user, fingerprint) slot.
    const expired = await tx.execute<{ reserved_bytes: string; object_key: string }>(sql`
      UPDATE uploads SET status = 'expired', finished_at = now()
      WHERE user_id = ${a.userId} AND fingerprint = ${a.fingerprint}
        AND status = 'pending' AND expires_at <= now()
      RETURNING reserved_bytes, object_key`);
    for (const row of expired.rows) {
      await releaseReservation(tx, a.userId, BigInt(row.reserved_bytes));
      await enqueueObjectDeletion(tx, { key: row.object_key });
    }
    const [pending] = await tx
      .select({ id: uploads.id })
      .from(uploads)
      .where(
        and(
          eq(uploads.userId, a.userId),
          eq(uploads.fingerprint, a.fingerprint),
          eq(uploads.status, 'pending'),
        ),
      )
      .limit(1);
    if (pending) throw new ApiException('UPLOAD_IN_PROGRESS', 'An upload of this file is running');

    if (!doc || doc.deletedAt !== null) {
      const [n] = await tx
        .select({ n: count() })
        .from(documents)
        .where(and(eq(documents.userId, a.userId), isNull(documents.deletedAt)));
      if (Number(n?.n ?? 0) >= LIMITS.maxDocuments) {
        throw new ApiException('LIMIT_EXCEEDED', 'Document limit reached');
      }
    }
    if (!(await reserveQuota(tx, a.userId, BigInt(a.bytes)))) {
      throw new ApiException('QUOTA_EXCEEDED', 'Not enough storage space left');
    }
    const uploadId = randomUUID();
    const objectKey = `u/${a.userId}/${uploadId}.pdf`;
    await tx.insert(uploads).values({
      id: uploadId,
      userId: a.userId,
      fingerprint: a.fingerprint,
      reservedBytes: BigInt(a.bytes),
      objectKey,
      status: 'pending',
      expiresAt: sql`now() + make_interval(mins => ${UPLOAD_TTL_MINUTES})`,
    });
    return { kind: 'reserved', uploadId, objectKey };
  });
}

export type CommitOutcome = 'committed' | 'already-stored' | 'expired' | 'limit-exceeded';

/** Transaction B (§6.2 step 5). The object is already in the bucket and verified. */
export async function commitUpload(
  db: Database,
  a: {
    userId: string;
    fingerprint: string;
    uploadId: string;
    objectKey: string;
    bytes: number;
    title: string | null;
  },
): Promise<CommitOutcome> {
  return db.transaction(async (tx) => {
    const current = await lockUserForSeq(tx, a.userId);
    if (current === null) {
      // Account deleted mid-flight. The account-delete prefix job may already have run, so queue this key too
      // (object_deletions has no FK to users).
      await enqueueObjectDeletion(tx, { key: a.objectKey });
      return 'expired';
    }
    const [up] = await tx
      .select({ status: uploads.status })
      .from(uploads)
      .where(and(eq(uploads.id, a.uploadId), eq(uploads.userId, a.userId)))
      .limit(1);
    if (!up || up.status !== 'pending') {
      // The sweeper already released the reservation and queued this key; queue it again (cheap, idempotent).
      await enqueueObjectDeletion(tx, { key: a.objectKey });
      return 'expired';
    }
    const bytes = BigInt(a.bytes);
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.userId, a.userId), eq(documents.fingerprint, a.fingerprint)))
      .limit(1);
    if (doc && doc.deletedAt === null && doc.storageState === 'stored') {
      await releaseReservation(tx, a.userId, bytes);
      await tx
        .update(uploads)
        .set({ status: 'aborted', finishedAt: sql`now()` })
        .where(eq(uploads.id, a.uploadId));
      await enqueueObjectDeletion(tx, { key: a.objectKey });
      return 'already-stored';
    }
    if (!doc || doc.deletedAt !== null) {
      // The stub below is a new live document: re-check the limit (it was checked at reservation, but other
      // pushes may have run since).
      const [n] = await tx
        .select({ n: count() })
        .from(documents)
        .where(and(eq(documents.userId, a.userId), isNull(documents.deletedAt)));
      if (Number(n?.n ?? 0) >= LIMITS.maxDocuments) {
        await releaseReservation(tx, a.userId, bytes);
        await tx
          .update(uploads)
          .set({ status: 'aborted', finishedAt: sql`now()` })
          .where(eq(uploads.id, a.uploadId));
        await enqueueObjectDeletion(tx, { key: a.objectKey });
        return 'limit-exceeded';
      }
    }
    if (!(await commitReservation(tx, a.userId, bytes))) {
      throw new Error('quota reservation missing at commit');
    }
    await tx
      .update(uploads)
      .set({ status: 'completed', finishedAt: sql`now()` })
      .where(eq(uploads.id, a.uploadId));
    const alloc = createSeqAllocator(current);
    const storage = {
      storageState: 'stored',
      objectKey: a.objectKey,
      storedBytes: bytes,
      storedAt: sql`now()`,
      serverModifiedAt: sql`now()`,
      seq: alloc.next(),
    };
    if (doc) {
      await tx
        .update(documents)
        .set({
          ...storage,
          // A tombstone is resurrected as a stub; a live document keeps its title unless it has none.
          title: doc.deletedAt === null ? (doc.title ?? a.title) : a.title,
          deletedAt: null,
        })
        .where(and(eq(documents.userId, a.userId), eq(documents.fingerprint, a.fingerprint)));
    } else {
      await tx.insert(documents).values({
        userId: a.userId,
        fingerprint: a.fingerprint,
        title: a.title,
        // The lowest valid time: any real document upsert (always newer) fills the stub in.
        clientModifiedAt: new Date(MIN_CLIENT_MS),
        ...storage,
      });
    }
    await commitSeq(tx, a.userId, alloc);
    return 'committed';
  });
}

/** §6.2 step 6: release the reservation (when still pending) and queue the key for deletion. */
export async function failUpload(
  db: Database,
  a: { userId: string; uploadId: string; objectKey: string; bytes: number },
): Promise<void> {
  await db.transaction(async (tx) => {
    if ((await lockUserForSeq(tx, a.userId)) === null) {
      // Account deleted mid-flight: the prefix job may already have run, so queue the key itself.
      await enqueueObjectDeletion(tx, { key: a.objectKey });
      return;
    }
    const [row] = await tx
      .select({ status: uploads.status })
      .from(uploads)
      .where(and(eq(uploads.id, a.uploadId), eq(uploads.userId, a.userId)))
      .limit(1);
    // A completed upload means the commit succeeded (only the acknowledgement failed): the object is live.
    if (row?.status === 'completed') return;
    if (row?.status === 'pending') {
      await tx
        .update(uploads)
        .set({ status: 'aborted', finishedAt: sql`now()` })
        .where(eq(uploads.id, a.uploadId));
      await releaseReservation(tx, a.userId, BigInt(a.bytes));
    }
    await enqueueObjectDeletion(tx, { key: a.objectKey });
  });
}

export type RemoveOutcome =
  { kind: 'not-found' } | { kind: 'no-file' } | { kind: 'removed'; objectKey: string };

/** §6.4 "Remove file": refund quota, clear the storage fields, bump seq, queue the key. */
export async function removeFile(
  db: Database,
  a: { userId: string; fingerprint: string; warn: (msg: string) => void },
): Promise<RemoveOutcome> {
  return db.transaction(async (tx) => {
    const current = await lockUserForSeq(tx, a.userId);
    if (current === null) throw new ApiException('UNAUTHENTICATED', 'Account no longer exists');
    const [doc] = await tx
      .select()
      .from(documents)
      .where(and(eq(documents.userId, a.userId), eq(documents.fingerprint, a.fingerprint)))
      .limit(1);
    if (!doc || doc.deletedAt !== null) return { kind: 'not-found' };
    if (doc.storageState !== 'stored' || doc.objectKey === null || doc.storedBytes === null) {
      return { kind: 'no-file' };
    }
    if (!(await releaseStoredBytes(tx, a.userId, doc.storedBytes))) {
      a.warn('quota refund skipped: storage_used_bytes below stored file size');
    }
    await enqueueObjectDeletion(tx, { key: doc.objectKey });
    const alloc = createSeqAllocator(current);
    await tx
      .update(documents)
      .set({
        storageState: 'none',
        objectKey: null,
        storedBytes: null,
        storedAt: null,
        serverModifiedAt: sql`now()`,
        seq: alloc.next(),
      })
      .where(and(eq(documents.userId, a.userId), eq(documents.fingerprint, a.fingerprint)));
    await commitSeq(tx, a.userId, alloc);
    return { kind: 'removed', objectKey: doc.objectKey };
  });
}

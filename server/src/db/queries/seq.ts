// Per-user sync sequence (docs/clavis-sync-design.md §4.2).
//
// Contract
//   lockUserForSeq(tx, userId): Promise<bigint | null>
//       SELECT change_seq ... FOR UPDATE. Must be the FIRST statement of every write transaction for a user.
//       Returns the current change_seq, or null when the user does not exist. The lock also serialises the
//       quota and live-count checks of §3.2 and §6.2.
//   createSeqAllocator(current): { next(): bigint; last(): bigint; used(): boolean }
//       Hands out current+1, current+2, ... Assign `seq = alloc.next()` to every row written.
//   commitSeq(tx, userId, alloc): Promise<void>
//       UPDATE users SET change_seq = alloc.last() (no-op when nothing was allocated). Call last, before commit.
//   withUserSeq(db, userId, fn): Promise<T | null>
//       Convenience: transaction { lock; fn(tx, alloc); commitSeq }. Returns null if the user is missing.
//       Throwing from fn rolls everything back, including the seq bump.
//
// Because the row lock is held until commit, commits for one user are serialised in seq order, so a pull that
// sees seq N never later finds an uncommitted seq < N, and seqs are gap-free except for rolled-back transactions
// (which never advance change_seq).
import { sql } from 'drizzle-orm';
import type { Database } from '../client';
import { toBig, type Executor, type Tx } from './executor';

export interface SeqAllocator {
  next(): bigint;
  last(): bigint;
  used(): boolean;
}

export async function lockUserForSeq(tx: Executor, userId: string): Promise<bigint | null> {
  const r = await tx.execute<{ change_seq: string }>(
    sql`SELECT change_seq FROM users WHERE id = ${userId} FOR UPDATE`,
  );
  const row = r.rows[0];
  return row ? toBig(row.change_seq) : null;
}

export function createSeqAllocator(current: bigint): SeqAllocator {
  let last = current;
  let used = false;
  return {
    next() {
      used = true;
      last += 1n;
      return last;
    },
    last: () => last,
    used: () => used,
  };
}

export async function commitSeq(tx: Executor, userId: string, alloc: SeqAllocator): Promise<void> {
  if (!alloc.used()) return;
  await tx.execute(sql`UPDATE users SET change_seq = ${alloc.last()} WHERE id = ${userId}`);
}

export async function withUserSeq<T>(
  db: Database,
  userId: string,
  fn: (tx: Tx, alloc: SeqAllocator) => Promise<T>,
): Promise<T | null> {
  return db.transaction(async (tx) => {
    const current = await lockUserForSeq(tx, userId);
    if (current === null) return null;
    const alloc = createSeqAllocator(current);
    const result = await fn(tx, alloc);
    await commitSeq(tx, userId, alloc);
    return result;
  });
}

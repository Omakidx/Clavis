import type pg from 'pg';

/** Stable advisory-lock ids, one per job (docs/clavis-sync-design.md §6.5). */
export const LOCK_IDS = {
  expireUploads: 0x434c_0001,
  objectDeletions: 0x434c_0002,
  purge: 0x434c_0003,
  orphanSweep: 0x434c_0004,
} as const;

/**
 * Run `fn` only if no other session holds `id` (session-level pg_try_advisory_lock on a dedicated connection),
 * so a second API replica would skip the run. The lock is released when `fn` finishes, or when the connection closes.
 */
export async function withAdvisoryLock<T>(
  pool: pg.Pool,
  id: number,
  fn: () => Promise<T>,
): Promise<{ ran: true; value: T } | { ran: false }> {
  const client = await pool.connect();
  // Only a failing lock/unlock query (a suspect connection) discards the connection; an error thrown by `fn`
  // leaves it healthy and is simply passed on.
  let broken = false;
  try {
    let ok: boolean | undefined;
    try {
      ok = (await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [id]))
        .rows[0]?.ok;
    } catch (err) {
      broken = true;
      throw err;
    }
    if (!ok) return { ran: false };
    try {
      return { ran: true, value: await fn() };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [id]).catch(() => {
        broken = true; // closing the connection releases the lock
      });
    }
  } finally {
    client.release(broken);
  }
}

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  commitReservation,
  deleteAccount,
  expireUserUploads,
  findUsersWithExpiredUploads,
  lockUserForSeq,
  purgeIdempotencyKeys,
  purgeRefreshTokens,
  purgeTombstones,
  purgeUploads,
  purgeWebSessions,
  releaseReservation,
  releaseStoredBytes,
  reserveQuota,
  withUserSeq,
} from '../../src/db/queries';
import {
  adminUrl,
  createTestDb,
  hex64,
  insertDocument,
  insertUser,
  insertWord,
  type TestDb,
} from './helpers';

const MiB = 1024n * 1024n;

describe.skipIf(!adminUrl)('quota, sequence and purge helpers (real Postgres)', () => {
  let t: TestDb;
  const exec = (q: ReturnType<typeof sql>) => t.handle.db.execute(q);
  const userRow = async (id: string) => {
    const r = await exec(
      sql`SELECT change_seq, tombstone_floor_seq, storage_used_bytes, storage_reserved_bytes FROM users WHERE id = ${id}`,
    );
    const row = r.rows[0] as Record<string, string>;
    return {
      seq: BigInt(row['change_seq'] as string),
      floor: BigInt(row['tombstone_floor_seq'] as string),
      used: BigInt(row['storage_used_bytes'] as string),
      reserved: BigInt(row['storage_reserved_bytes'] as string),
    };
  };

  beforeAll(async () => {
    t = await createTestDb(25);
  });
  afterAll(async () => {
    await t.drop();
  });

  describe('quota reservation', () => {
    it('20 concurrent 10 MiB reservations against 100 MiB: exactly 10 succeed (lock-free path)', async () => {
      const u = await insertUser(t.handle);
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          t.handle.db.transaction((tx) => reserveQuota(tx, u, 10n * MiB)),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(10);
      expect(await userRow(u)).toMatchObject({ reserved: 100n * MiB, used: 0n });
    });

    it('same through the documented path (user row lock first), with jitter', async () => {
      const u = await insertUser(t.handle);
      const results = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          t.handle.db.transaction(async (tx) => {
            await lockUserForSeq(tx, u);
            await new Promise((r) => setTimeout(r, (i * 7) % 13));
            return reserveQuota(tx, u, 10n * MiB);
          }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(10);
      expect((await userRow(u)).reserved).toBe(100n * MiB);
    });

    it('mixed sizes never exceed quota and leave no room for any rejected request', async () => {
      const u = await insertUser(t.handle);
      const sizes = Array.from({ length: 20 }, (_, i) => BigInt(3 + (i % 7) * 2) * MiB); // 3..15 MiB
      const results = await Promise.all(
        sizes.map((s) => t.handle.db.transaction((tx) => reserveQuota(tx, u, s))),
      );
      const row = await userRow(u);
      const accepted = sizes.filter((_, i) => results[i]).reduce((a, b) => a + b, 0n);
      expect(row.reserved).toBe(accepted);
      expect(row.reserved).toBeLessThanOrEqual(100n * MiB);
      const free = 100n * MiB - row.reserved;
      for (const [i, s] of sizes.entries()) if (!results[i]) expect(s).toBeGreaterThan(free);
    });

    it('commit, release and stored-bytes release keep the books balanced', async () => {
      const u = await insertUser(t.handle);
      await t.handle.db.transaction(async (tx) => {
        expect(await reserveQuota(tx, u, 5n * MiB)).toBe(true);
        expect(await reserveQuota(tx, u, 7n * MiB)).toBe(true);
        expect(await commitReservation(tx, u, 5n * MiB)).toBe(true);
        expect(await releaseReservation(tx, u, 7n * MiB)).toBe(true);
        expect(await releaseReservation(tx, u, 1n)).toBe(false); // nothing reserved
      });
      expect(await userRow(u)).toMatchObject({ used: 5n * MiB, reserved: 0n });
      await t.handle.db.transaction(async (tx) => {
        expect(await releaseStoredBytes(tx, u, 6n * MiB)).toBe(false);
        expect(await releaseStoredBytes(tx, u, 5n * MiB)).toBe(true);
      });
      expect(await userRow(u)).toMatchObject({ used: 0n, reserved: 0n });
    });

    it('the sweeper expires stale pending uploads and refunds the reservation', async () => {
      const u = await insertUser(t.handle);
      await t.handle.db.transaction((tx) => reserveQuota(tx, u, 8n * MiB));
      await exec(sql`INSERT INTO uploads (user_id, fingerprint, reserved_bytes, object_key, status, expires_at)
        VALUES (${u}, ${hex64('a')}, ${8n * MiB}, ${`u/${u}/x.pdf`}, 'pending', now() - interval '1 minute')`);
      expect(await findUsersWithExpiredUploads(t.handle.db)).toContain(u);
      expect(await expireUserUploads(t.handle.db, u)).toBe(1);
      expect(await expireUserUploads(t.handle.db, u)).toBe(0);
      expect((await userRow(u)).reserved).toBe(0n);
      const st = await exec(sql`SELECT status FROM uploads WHERE user_id = ${u}`);
      expect(st.rows[0]?.['status']).toBe('expired');
      const del = await exec(
        sql`SELECT 1 FROM object_deletions WHERE object_key = ${`u/${u}/x.pdf`}`,
      );
      expect(del.rows).toHaveLength(1);
    });
  });

  describe('per-user change_seq', () => {
    it('30 concurrent transactions get gap-free, strictly commit-ordered seqs', async () => {
      const u = await insertUser(t.handle);
      const finished: bigint[] = [];
      await Promise.all(
        Array.from({ length: 30 }, (_, i) =>
          withUserSeq(t.handle.db, u, async (tx, alloc) => {
            const first = alloc.next();
            alloc.next();
            alloc.next();
            await new Promise((r) => setTimeout(r, (i * 5) % 11));
            await tx.execute(sql`INSERT INTO documents (user_id, fingerprint, client_modified_at, seq)
              VALUES (${u}, ${i.toString(16).padStart(64, '0')}, now(), ${first})`);
            return first;
          }).then((first) => {
            finished.push(first as bigint);
          }),
        ),
      );
      // Commit order == seq order: each transaction finished after all lower-seq ones.
      expect(finished).toEqual([...finished].sort((a, b) => (a < b ? -1 : 1)));
      expect(finished).toEqual(Array.from({ length: 30 }, (_, i) => BigInt(i * 3 + 1)));
      expect((await userRow(u)).seq).toBe(90n);
    });

    it('a pull never skips a row: committed seqs are always a prefix 1..N', async () => {
      const u = await insertUser(t.handle);
      let stop = false;
      const writers = Array.from({ length: 8 }, (_, w) =>
        (async () => {
          for (let i = 0; i < 10; i++) {
            await withUserSeq(t.handle.db, u, async (tx, alloc) => {
              const seq = alloc.next();
              await tx.execute(sql`INSERT INTO documents (user_id, fingerprint, client_modified_at, seq)
                VALUES (${u}, ${(w * 100 + i).toString(16).padStart(64, '0')}, now(), ${seq})`);
            });
          }
        })(),
      );
      const violations: string[] = [];
      const reader = (async () => {
        while (!stop) {
          const r = await exec(
            sql`SELECT count(*)::int AS n, coalesce(max(seq),0)::int AS m FROM documents WHERE user_id = ${u}`,
          );
          const { n, m } = r.rows[0] as { n: number; m: number };
          if (n !== m) violations.push(`count ${n} != max ${m}`);
        }
      })();
      await Promise.all(writers);
      stop = true;
      await reader;
      expect(violations).toEqual([]);
      expect((await userRow(u)).seq).toBe(80n);
    });

    it('a rolled-back transaction does not advance change_seq', async () => {
      const u = await insertUser(t.handle);
      await withUserSeq(t.handle.db, u, async (_tx, a) => void a.next());
      await expect(
        withUserSeq(t.handle.db, u, async (_tx, a) => {
          a.next();
          a.next();
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect((await userRow(u)).seq).toBe(1n);
      const next = await withUserSeq(t.handle.db, u, async (_tx, a) => a.next());
      expect(next).toBe(2n);
      expect(
        await withUserSeq(t.handle.db, '00000000-0000-4000-8000-000000000000', async () => 1),
      ).toBeNull();
    });
  });

  describe('retention', () => {
    const old = "now() - interval '91 days'";
    it('purges expired tombstones, cascades children and raises tombstone_floor_seq', async () => {
      const u = await insertUser(t.handle);
      const fresh = await insertWord(t.handle, u, 1n);
      await insertWord(t.handle, u, 2n, {
        deletedAt: new Date(Date.now() - 91 * 864e5).toISOString(),
      });
      await insertWord(t.handle, u, 3n, { deletedAt: new Date().toISOString() }); // recent tombstone stays
      const doc = await insertDocument(t.handle, u, 4n, {
        deletedAt: new Date(Date.now() - 91 * 864e5).toISOString(),
      });
      await exec(sql`INSERT INTO highlights (user_id, id, fingerprint, page, start_offset, end_offset, color, created_at, client_modified_at, seq, deleted_at)
        VALUES (${u}, gen_random_uuid(), ${doc}, 1, 0, 1, 'pink', now(), now(), 9, ${sql.raw(old)})`);
      const res = await purgeTombstones(t.handle.db);
      expect(res).toMatchObject({ users: 1, words: 1, documents: 1, highlights: 1 });
      expect((await userRow(u)).floor).toBe(9n);
      const left = await exec(
        sql`SELECT word_key, seq FROM saved_words WHERE user_id = ${u} ORDER BY seq`,
      );
      expect(left.rows.map((r) => r['seq'])).toEqual(['1', '3']);
      expect(left.rows[0]?.['word_key']).toBe(fresh);
      expect(await purgeTombstones(t.handle.db)).toMatchObject({ users: 0 });
    });

    it('purges idempotency keys, tokens, sessions and finished uploads past their windows', async () => {
      const u = await insertUser(t.handle);
      await exec(sql`INSERT INTO idempotency_keys (user_id, key, request_hash, response, created_at) VALUES
        (${u}, gen_random_uuid(), 'x'::bytea, '{}', now() - interval '25 hours'),
        (${u}, gen_random_uuid(), 'x'::bytea, '{}', now() - interval '1 hour')`);
      await exec(sql`INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, family_expires_at, revoked_at) VALUES
        (${u}, gen_random_uuid(), 'a1'::bytea, now() - interval '8 days', now(), null),
        (${u}, gen_random_uuid(), 'a2'::bytea, now() + interval '1 day', now(), now() - interval '8 days'),
        (${u}, gen_random_uuid(), 'a3'::bytea, now() + interval '1 day', now() + interval '1 day', null)`);
      await exec(sql`INSERT INTO web_sessions (user_id, session_hash, csrf_token, authenticated_at, expires_at) VALUES
        (${u}, 's1'::bytea, 'c', now(), now() - interval '8 days'),
        (${u}, 's2'::bytea, 'c', now(), now() + interval '1 day')`);
      await exec(sql`INSERT INTO uploads (user_id, fingerprint, reserved_bytes, object_key, status, created_at, expires_at) VALUES
        (${u}, ${hex64('1')}, 1, 'k1', 'completed', now() - interval '8 days', now()),
        (${u}, ${hex64('2')}, 1, 'k2', 'aborted', now(), now()),
        (${u}, ${hex64('3')}, 1, 'k3', 'pending', now() - interval '8 days', now() + interval '1 day')`);
      expect(await purgeIdempotencyKeys(t.handle.db)).toBe(1);
      expect(await purgeRefreshTokens(t.handle.db)).toBe(2);
      expect(await purgeWebSessions(t.handle.db)).toBe(1);
      expect(await purgeUploads(t.handle.db)).toBe(1);
    });

    it('deleteAccount enqueues the bucket prefix and cascades everything', async () => {
      const u = await insertUser(t.handle);
      await insertWord(t.handle, u, 1n);
      expect(await deleteAccount(t.handle.db, u)).toBe(true);
      expect(await deleteAccount(t.handle.db, u)).toBe(false);
      const r = await exec(sql`SELECT 1 FROM object_deletions WHERE object_prefix = ${`u/${u}/`}`);
      expect(r.rows.length).toBeGreaterThanOrEqual(1);
      const w = await exec(sql`SELECT 1 FROM saved_words WHERE user_id = ${u}`);
      expect(w.rows).toHaveLength(0);
    });
  });
});

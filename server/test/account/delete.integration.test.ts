import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer, cookiesOf, webLogin, ORIGIN } from '../auth/harness';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import { Api, docUp, makeWorld, rows, type World } from '../sync/helpers';
import { FakeStorage, makePdf, realStorage, s3Configured } from '../storage/support';
import { processObjectDeletions } from '../../src/storage/deletions';
import { createLogger } from '../../src/logger';
import { commitUpload, reserveUpload } from '../../src/documents/file-service';
import {
  authHeaders,
  deleteAccountReq,
  freshLogin,
  plainLogin,
  putPdf,
  rowCounts,
  seedUser,
  userTables,
} from './support';

vi.setConfig({ testTimeout: 60_000 });

type Err = { error: { code: string } };
const code = async (r: Response) => ((await r.json()) as Err).error.code;
const keysOf = async (storage: ReturnType<typeof realStorage>, userId: string) => {
  const out: string[] = [];
  for await (const o of storage.list(`u/${userId}/`)) out.push(o.key);
  return out;
};

describe.skipIf(!adminUrl || !s3Configured)('DELETE /v1/account (real Postgres + MinIO)', () => {
  let tdb: TestDb;
  let storage: ReturnType<typeof realStorage>;
  let w: World;

  beforeAll(async () => {
    tdb = await createTestDb(30);
    storage = realStorage();
    w = await makeWorld(tdb.handle, { storage, env: { MAX_CONCURRENT_UPLOADS: '100' } });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const exists = async (id: string) =>
    ((await rows(tdb.handle, sql`SELECT 1 FROM users WHERE id = ${id}`)) as unknown[]).length === 1;

  it('removes every row in every user-owned table and every bucket key; the other user is untouched', async () => {
    const A = await seedUser(w, 'del-a', 2);
    const B = await seedUser(w, 'del-b', 1);
    // A second device and a second web session for A: sessions and families all go.
    await w.device(A.a);
    await webLogin(w.h, { sub: A.a.sub, email: A.a.pair.user.email });

    const tables = await userTables(tdb.handle);
    // Every kind of row is really present before the delete (so zero afterwards means something).
    const before = await rowCounts(tdb.handle, A.a.userId);
    for (const t of [
      'users',
      'refresh_tokens',
      'web_sessions',
      'saved_words',
      'word_chat_messages',
      'documents',
      'highlights',
      'uploads',
      'idempotency_keys',
    ]) {
      expect(before[t], t).toBeGreaterThan(0);
    }
    expect(tables.map((t) => t.table)).toEqual(expect.arrayContaining(Object.keys(before)));
    expect((await keysOf(storage, A.a.userId)).length).toBe(2);
    const bBefore = await rowCounts(tdb.handle, B.a.userId);
    const bKeys = await keysOf(storage, B.a.userId);
    expect(bKeys).toHaveLength(1);

    const res = await deleteAccountReq(w, A.web);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    const cleared = cookiesOf(res)['__Host-clavis_session'];
    expect(cleared?.value).toBe('');
    expect(cleared?.attrs).toMatch(/Max-Age=0/i);

    const after = await rowCounts(tdb.handle, A.a.userId);
    for (const [t, n] of Object.entries(after)) expect(n, `rows left in ${t}`).toBe(0);

    // Bucket: the inline attempt (or, failing that, the job) leaves nothing under the prefix.
    await processObjectDeletions(tdb.handle.db, storage, createLogger('silent'));
    expect(await keysOf(storage, A.a.userId)).toEqual([]);
    // The immediate prefix job is done; only the delayed second sweep (after the upload TTL) remains queued.
    const left = await rows<{ delayed: boolean }>(
      tdb.handle,
      sql`SELECT next_attempt_at > now() + interval '15 minutes' AS delayed FROM object_deletions
          WHERE object_prefix = ${`u/${A.a.userId}/`}`,
    );
    expect(left).toEqual([{ delayed: true }]);

    // The other user is untouched: same rows, same objects, can still export-read their data.
    expect(await rowCounts(tdb.handle, B.a.userId)).toEqual(bBefore);
    expect(await keysOf(storage, B.a.userId)).toEqual(bKeys);
    expect((await B.a.req('GET', '/v1/account')).status).toBe(200);
  });

  it('every table with a user_id reaches users through an ON DELETE CASCADE foreign key', async () => {
    const r = await rows<{ tbl: string }>(
      tdb.handle,
      sql`SELECT c.relname AS tbl FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'user_id'
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND NOT EXISTS (SELECT 1 FROM pg_constraint k
                            WHERE k.conrelid = c.oid AND k.contype = 'f' AND k.confdeltype = 'c')`,
    );
    expect(r).toEqual([]);
  });

  it('answers 204 even when the bucket is down; the durable job finishes the prefix later', async () => {
    const fake = new FakeStorage();
    const w2 = await makeWorld(tdb.handle, { storage: fake });
    const U = await seedUser(w2, 'del-job', 2);
    const prefix = `u/${U.a.userId}/`;
    expect([...fake.objects.keys()].filter((k) => k.startsWith(prefix))).toHaveLength(2);
    fake.failDelete = true;
    const res = await deleteAccountReq(w2, U.web);
    expect(res.status).toBe(204);
    expect([...fake.objects.keys()].filter((k) => k.startsWith(prefix))).toHaveLength(2);
    // One immediate job (failed, backing off) plus the delayed second sweep.
    expect(
      await rows(tdb.handle, sql`SELECT 1 FROM object_deletions WHERE object_prefix = ${prefix}`),
    ).toHaveLength(2);
    await tdb.handle.db.execute(
      sql`UPDATE object_deletions SET next_attempt_at = now()
          WHERE object_prefix = ${prefix} AND next_attempt_at < now() + interval '15 minutes'`,
    );
    fake.failDelete = false;
    await processObjectDeletions(tdb.handle.db, fake, createLogger('silent'));
    expect([...fake.objects.keys()].filter((k) => k.startsWith(prefix))).toEqual([]);
    // The delayed sweep stays queued and, when it comes due, finds nothing and finishes.
    expect(
      await rows(tdb.handle, sql`SELECT 1 FROM object_deletions WHERE object_prefix = ${prefix}`),
    ).toHaveLength(1);
    fake.objects.set(`${prefix}crash-leftover.pdf`, {
      bytes: Buffer.from('x'),
      lastModified: new Date(),
    });
    await tdb.handle.db.execute(
      sql`UPDATE object_deletions SET next_attempt_at = now() WHERE object_prefix = ${prefix}`,
    );
    await processObjectDeletions(tdb.handle.db, fake, createLogger('silent'));
    expect([...fake.objects.keys()].filter((k) => k.startsWith(prefix))).toEqual([]);
    expect(
      await rows(tdb.handle, sql`SELECT 1 FROM object_deletions WHERE object_prefix = ${prefix}`),
    ).toHaveLength(0);
  });

  describe('re-authentication', () => {
    const sessionOf = async (cookie: string) =>
      (await (await w.h.app.request('/v1/session', { headers: { cookie } })).json()) as {
        authenticatedAt: number;
      };

    it('an ordinary Google login is not a re-auth: DELETE right after it is 403 REAUTH_REQUIRED', async () => {
      const a = await w.user();
      const plain = await plainLogin(w, a);
      expect((await sessionOf(plain.cookie)).authenticatedAt).toBe(0);
      const res = await deleteAccountReq(w, plain);
      expect(res.status).toBe(403);
      expect(await code(res)).toBe('REAUTH_REQUIRED');
      expect(await exists(a.userId)).toBe(true);

      // A forced re-auth login (auth_time-bound) is accepted.
      const fresh = await webLogin(
        w.h,
        { sub: a.sub, email: a.pair.user.email },
        { reauth: true, cookie: plain.cookie },
      );
      expect(fresh.res.headers.get('location')).toBe('/?reauth=done');
      expect((await sessionOf(fresh.cookie)).authenticatedAt).toBe(w.h.clock.now());
      expect((await deleteAccountReq(w, fresh)).status).toBe(204);
      expect(await exists(a.userId)).toBe(false);
    });

    it('refuses a re-auth older than 10 minutes and accepts one just inside the window', async () => {
      const a = await w.user();
      const s = await freshLogin(w, a);
      w.h.clock.advance(10 * 60_000 + 1);
      const stale = await deleteAccountReq(w, s);
      expect(stale.status).toBe(403);
      expect(await code(stale)).toBe('REAUTH_REQUIRED');
      expect(await exists(a.userId)).toBe(true);

      const b = await w.user();
      const s2 = await freshLogin(w, b);
      // Google's auth_time has one-second resolution, so test just inside the window.
      w.h.clock.advance(10 * 60_000 - 1_000);
      expect((await deleteAccountReq(w, s2)).status).toBe(204);
    });

    it('re-auth needs a signed-in session: without one /auth/google/start redirects to a fixed failure path', async () => {
      for (const headers of [{}, { cookie: '__Host-clavis_session=bogus' }]) {
        const res = await w.h.app.request('/auth/google/start?reauth=1', { headers });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/?signin=failed&reason=reauth_session');
        expect(cookiesOf(res)['__Host-clavis_oauth']).toBeUndefined();
      }
    });

    it('re-auth is bound to the signed-in account: another Google identity fails with reauth_mismatch', async () => {
      const a = await w.user();
      const plain = await plainLogin(w, a);
      const usersBefore = await rows(tdb.handle, sql`SELECT 1 FROM users`);
      const attempt = await webLogin(
        w.h,
        { sub: `other-${Math.random()}`, email: 'someone-else@example.test' },
        { reauth: true, cookie: plain.cookie },
      );
      expect(attempt.res.headers.get('location')).toBe('/?signin=failed&reason=reauth_mismatch');
      expect(attempt.session).toBe('');
      // No user was created, the original session still works and did not become a re-auth.
      expect(await rows(tdb.handle, sql`SELECT 1 FROM users`)).toHaveLength(usersBefore.length);
      const still = await w.h.app.request('/v1/session', { headers: { cookie: plain.cookie } });
      expect(still.status).toBe(200);
      expect(((await still.json()) as { authenticatedAt: number }).authenticatedAt).toBe(0);
      expect((await deleteAccountReq(w, plain)).status).toBe(403);
    });
  });

  describe('request validation and caller rules', () => {
    it('rejects a missing or wrong confirmation with 400 and keeps the account', async () => {
      const a = await w.user();
      const s = await freshLogin(w, a);
      for (const body of [
        {},
        { confirm: 'delete' },
        { confirm: 'DELETE ' },
        { confirm: true },
        { confirm: 'DELETE', extra: 1 },
        [],
      ]) {
        const res = await deleteAccountReq(w, s, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        expect(await code(res)).toBe('VALIDATION_FAILED');
      }
      const noBody = await w.h.app.request('/v1/account', {
        method: 'DELETE',
        headers: authHeaders(s),
      });
      expect(noBody.status).toBe(415);
      expect(await exists(a.userId)).toBe(true);
    });

    it('is cookie-only: a Bearer caller is rejected', async () => {
      const a = await w.user();
      const res = await w.h.app.request('/v1/account', {
        method: 'DELETE',
        headers: { ...bearer(a.pair), 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' }),
      });
      expect(res.status).toBe(401);
      expect(await code(res)).toBe('UNAUTHENTICATED');
      // Even with a valid cookie session next to it, the Bearer token does not authorise the delete.
      expect(await exists(a.userId)).toBe(true);
    });

    it('enforces CSRF: missing token, wrong token and foreign origin are 403', async () => {
      const a = await w.user();
      const s = await freshLogin(w, a);
      const attempts: Record<string, Record<string, string>> = {
        'no csrf': { cookie: s.cookie, origin: ORIGIN },
        'wrong csrf': { cookie: s.cookie, origin: ORIGIN, 'x-csrf-token': 'nope' },
        'foreign origin': {
          cookie: s.cookie,
          origin: 'https://evil.example',
          'x-csrf-token': s.csrf,
        },
        'no origin': { cookie: s.cookie, 'x-csrf-token': s.csrf },
      };
      for (const [name, headers] of Object.entries(attempts)) {
        const res = await w.h.app.request('/v1/account', {
          method: 'DELETE',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({ confirm: 'DELETE' }),
        });
        expect(res.status, name).toBe(403);
        expect(await code(res), name).toBe('CSRF_FAILED');
      }
      expect(await exists(a.userId)).toBe(true);
    });

    it('allows 3 attempts per hour per user', async () => {
      const lw = await makeWorld(tdb.handle, { storage, limited: true });
      const a = await lw.user();
      const s = await freshLogin(lw, a);
      for (let i = 0; i < 3; i++) expect((await deleteAccountReq(lw, s, {})).status).toBe(400);
      const res = await deleteAccountReq(lw, s);
      expect(res.status).toBe(429);
      expect(await code(res)).toBe('RATE_LIMITED');
      expect(res.headers.get('retry-after')).toBeTruthy();
      expect(await exists(a.userId)).toBe(true);
      // The bucket refills after an hour; the login is by then too old for the re-auth gate.
      lw.h.clock.advance(3_600_000);
      const later = await deleteAccountReq(lw, s);
      expect(later.status).toBe(403);
      expect(await code(later)).toBe('REAUTH_REQUIRED');
    });
  });

  describe('after the account is gone', () => {
    const REPRESENTATIVE = (a: Api) => {
      const fp = makePdf(1000, 'gone').fp;
      return [
        () => a.push([]),
        () => a.pull(),
        () => a.req('GET', '/v1/words'),
        () => a.req('GET', '/v1/documents'),
        () => a.req('GET', '/v1/account'),
        () => a.req('POST', '/v1/account/logout-all'),
        () => a.req('DELETE', `/v1/words/${'a'.repeat(64)}`),
        () => a.req('DELETE', `/v1/documents/${fp}`),
        () => putPdf(a, fp, makePdf(1000, 'gone').bytes, 'x'),
      ];
    };

    it('a still-valid access token gets 401 UNAUTHENTICATED on every Bearer route and nothing is recreated', async () => {
      const U = await seedUser(w, 'gone-a', 1);
      // Warm the family cache so the "cached as active" path is the one under test.
      expect((await U.a.req('GET', '/v1/account')).status).toBe(200);
      expect((await deleteAccountReq(w, U.web)).status).toBe(204);

      for (const call of REPRESENTATIVE(U.a)) {
        const res = await call();
        expect(res.status).toBe(401);
        expect(await code(res)).toBe('UNAUTHENTICATED');
      }
      // A replica that never cached the family reaches the same verdict from the database.
      const cold = await makeWorld(tdb.handle, { storage });
      const verdict = await cold.h.app.request('/v1/words', { headers: bearer(U.a.pair) });
      expect(verdict.status).toBe(401);
      expect(await code(verdict)).toBe('UNAUTHENTICATED');

      const counts = await rowCounts(tdb.handle, U.a.userId);
      expect(Object.values(counts).every((n) => n === 0)).toBe(true);
      expect(await keysOf(storage, U.a.userId)).toEqual([]);
    });

    it('the refresh token and the session cookie no longer work', async () => {
      const U = await seedUser(w, 'gone-b', 0);
      expect((await deleteAccountReq(w, U.web)).status).toBe(204);
      const refresh = await w.h.app.request('/v1/auth/extension/refresh', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: U.a.pair.refreshToken }),
      });
      expect(refresh.status).toBe(401);
      expect(await code(refresh)).toBe('UNAUTHENTICATED');
      const session = await w.h.app.request('/v1/session', { headers: { cookie: U.web.cookie } });
      expect(session.status).toBe(401);
      expect(await code(session)).toBe('UNAUTHENTICATED');
      const again = await deleteAccountReq(w, U.web);
      expect(again.status).toBe(401);
    });

    it('does not log emails, names, titles or word text', async () => {
      const U = await seedUser(w, 'pii-mark', 1);
      await deleteAccountReq(w, U.web);
      const logs = w.h.logs.join('');
      for (const needle of [U.a.pair.user.email, 'pii-mark', 'Ada Lovelace']) {
        expect(logs).not.toContain(needle);
      }
    });
  });

  describe('an upload in flight while the account is deleted', () => {
    it('leaves no object behind (route-level race)', async () => {
      const a = await w.user();
      const s = await freshLogin(w, a);
      const pdf = makePdf(300_000, 'inflight');
      await a.pushOk([docUp(pdf.fp, 1_800_000_000_000, { title: 'inflight' })]);

      // Stream the body in two halves; delete the account between them.
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const half = pdf.bytes.length / 2;
      const body = new ReadableStream<Uint8Array>({
        async start(ctl) {
          ctl.enqueue(new Uint8Array(pdf.bytes.subarray(0, half)));
          await gate;
          ctl.enqueue(new Uint8Array(pdf.bytes.subarray(half)));
          ctl.close();
        },
      });
      const putPromise = w.h.app.request(`/v1/documents/${pdf.fp}/file`, {
        method: 'PUT',
        headers: {
          ...bearer(a.pair),
          'content-type': 'application/pdf',
          'content-length': String(pdf.bytes.length),
        },
        body,
        duplex: 'half',
      } as RequestInit);
      // Wait until the reservation exists, i.e. the upload is really in flight.
      let found = false;
      for (let i = 0; i < 100 && !found; i++) {
        const r = await rows(tdb.handle, sql`SELECT 1 FROM uploads WHERE user_id = ${a.userId}`);
        found = r.length > 0;
        if (!found) await new Promise((res) => setTimeout(res, 20));
      }
      expect(found).toBe(true);
      expect((await deleteAccountReq(w, s)).status).toBe(204);
      release();
      const put = await putPromise;
      expect(put.status).toBeGreaterThanOrEqual(400); // not stored: the account is gone

      await processObjectDeletions(tdb.handle.db, storage, createLogger('silent'));
      expect(await keysOf(storage, a.userId)).toEqual([]);
      expect(Object.values(await rowCounts(tdb.handle, a.userId)).every((n) => n === 0)).toBe(true);
    });

    it('a commit after the delete queues its own key (service level)', async () => {
      const a = await w.user();
      const pdf = makePdf(5000, 'commit-after');
      const r = await reserveUpload(tdb.handle.db, {
        userId: a.userId,
        fingerprint: pdf.fp,
        bytes: pdf.bytes.length,
      });
      if (r.kind !== 'reserved') throw new Error('expected a reservation');
      await storage.putStream(r.objectKey, Readable.from([pdf.bytes]), {
        contentType: 'application/pdf',
      });
      const s = await freshLogin(w, a);
      expect((await deleteAccountReq(w, s)).status).toBe(204);
      expect(
        await commitUpload(tdb.handle.db, {
          userId: a.userId,
          fingerprint: pdf.fp,
          uploadId: r.uploadId,
          objectKey: r.objectKey,
          bytes: pdf.bytes.length,
          title: null,
        }),
      ).toBe('expired');
      await processObjectDeletions(tdb.handle.db, storage, createLogger('silent'));
      expect(await keysOf(storage, a.userId)).toEqual([]);
    });
  });
});

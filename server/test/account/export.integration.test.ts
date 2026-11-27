import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { planExport, startExport } from '../../src/account/export';
import { MAX_CONCURRENT_EXPORTS } from '../../src/account/routes';
import { createLogger } from '../../src/logger';
import { ClavisExport, exportPdfPath } from '../../../shared/api-contract';
import { bearer, type WebLogin } from '../auth/harness';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import { docUp, makeWorld, rows, type World } from '../sync/helpers';
import { FakeStorage, makePdf, realStorage, s3Configured } from '../storage/support';
import {
  deleteAccountReq,
  exportReq,
  freshLogin,
  plainLogin,
  putPdf,
  seedUser,
  unzip,
  type Seeded,
} from './support';

vi.setConfig({ testTimeout: 60_000 });

type Err = { error: { code: string } };
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
/** Poll `cond` (every 10 ms, up to `ms`) instead of sleeping for a guessed time. */
async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('condition not reached in time');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const errMessage = async (res: Response) =>
  ((await res.json()) as { error: { code: string; message: string } }).error;

/** Request an export, retrying while the user's previous one is still releasing its slot. */
async function exportWhenFree(w: World, s: WebLogin): Promise<Response> {
  for (let i = 0; i < 300; i++) {
    const res = await exportReq(w, s);
    if (res.status !== 429) return res;
    const body = await errMessage(res);
    if (!body.message.includes('in progress'))
      return new Response(JSON.stringify({ error: body }), { status: 429 });
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('export slot never freed');
}

/** A user with one 4 MiB stored PDF: an export that cannot finish into the stream's buffers unread. */
async function bigUser(w: World, fresh = false) {
  const a = await w.user();
  const s = fresh ? await freshLogin(w, a) : await plainLogin(w, a);
  const big = makePdf(4 * 1024 * 1024, `big-${a.userId}`);
  await a.pushOk([docUp(big.fp, 1_800_000_000_000)]);
  expect((await putPdf(a, big.fp, big.bytes, 'big')).status).toBe(200);
  return { a, s, big };
}

/** Fully read an export and parse it. */
async function readExport(res: Response) {
  expect(res.status).toBe(200);
  const files = await unzip(Buffer.from(await res.arrayBuffer()));
  const json = ClavisExport.parse(
    JSON.parse((files.get('clavis-export.json') as Buffer).toString()),
  );
  return { files, json };
}

/** Storage that records how many object streams are open at once and fails on demand. */
class SpyStorage extends FakeStorage {
  open = 0;
  maxOpen = 0;
  gets: string[] = [];
  failListing = false;
  failGetOn: string | undefined;
  /** Objects that exist for the listing but are gone when fetched (deleted mid-export). */
  vanish = new Set<string>();
  override async *list(prefix: string) {
    if (this.failListing) throw new Error('injected list failure');
    yield* super.list(prefix);
  }
  override async getStream(key: string) {
    this.gets.push(key);
    if (this.failGetOn === key) throw new Error('injected get failure');
    if (this.vanish.has(key)) return null;
    const o = this.objects.get(key);
    if (!o) return null;
    this.open += 1;
    this.maxOpen = Math.max(this.maxOpen, this.open);
    let off = 0;
    const CH = 4096;
    const stream = new ReadableStream<Uint8Array>({
      pull: (ctl) => {
        if (off >= o.bytes.length) {
          this.open -= 1;
          ctl.close();
          return;
        }
        ctl.enqueue(new Uint8Array(o.bytes.subarray(off, off + CH)));
        off += CH;
      },
      cancel: () => {
        this.open -= 1;
      },
    });
    return { stream, contentLength: o.bytes.length };
  }
}

/** Exports of this world that have finished (any outcome), counted from the log. */
const finished = (lw: World) => lw.h.logs.filter((l) => l.includes('"export finished"')).length;

describe.skipIf(!adminUrl || !s3Configured)(
  'GET /v1/account/export (real Postgres + MinIO)',
  () => {
    let tdb: TestDb;
    let storage: ReturnType<typeof realStorage>;
    let w: World;
    let A: Seeded;
    let B: Seeded;

    beforeAll(async () => {
      tdb = await createTestDb(30);
      storage = realStorage();
      w = await makeWorld(tdb.handle, { storage, env: { MAX_CONCURRENT_UPLOADS: '100' } });
      A = await seedUser(w, 'exp-a', 2);
      B = await seedUser(w, 'exp-b', 1);
    });
    afterAll(async () => {
      await tdb.drop();
    });

    it('round-trips: ZIP parses as ClavisExport and matches the seeded data, PDFs hash to their fingerprint', async () => {
      const res = await exportReq(w, A.web);
      expect(res.headers.get('content-type')).toBe('application/zip');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      const day = new Date(w.h.clock.now()).toISOString().slice(0, 10);
      expect(res.headers.get('content-disposition')).toBe(
        `attachment; filename="clavis-export-${day}.zip"`,
      );
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      const { files, json } = await readExport(res);

      expect([...files.keys()].sort()).toEqual(
        ['README.txt', 'clavis-export.json', ...A.stored.map((d) => exportPdfPath(d.fp))].sort(),
      );
      expect(files.get('README.txt')?.toString()).toContain('clavis-export.json');

      expect(json.format).toBe('clavis-export');
      expect(json.version).toBe(1);
      expect(json.exportedAt).toBe(new Date(w.h.clock.now()).toISOString());
      expect(json.account).toEqual({
        email: A.a.pair.user.email,
        displayName: A.a.pair.user.displayName,
        createdAt: A.a.pair.user.createdAt,
      });

      // Words: exactly the live ones, tombstones absent, chat in order, ids and keys intact.
      expect(json.savedWords.map((x) => x.text).sort()).toEqual([...A.words.keys()].sort());
      expect(json.savedWords.map((x) => x.text)).not.toContain(A.tombWord);
      for (const word of json.savedWords) expect(word.key).toBe(A.words.get(word.text));
      const withChat = json.savedWords.find((x) => x.text === 'exp-a-alpha');
      expect(withChat?.messages.map((m) => m.content)).toEqual([
        'exp-a chat one',
        'exp-a chat two',
        'exp-a chat three',
      ]);
      expect(withChat?.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
      expect(withChat?.messages[1]?.model).toBe('test-model');
      expect(
        json.savedWords.flatMap((x) => x.messages).some((m) => m.content.includes('dies with')),
      ).toBe(false);

      // Documents: live only; stored ones point at their PDF, others have file null.
      const byFp = new Map(json.documents.map((d) => [d.fingerprint, d]));
      expect([...byFp.keys()].sort()).toEqual([...A.stored.map((d) => d.fp), A.plainFp].sort());
      expect(byFp.has(A.tombDocFp)).toBe(false);
      for (const d of A.stored) {
        const doc = byFp.get(d.fp);
        expect(doc?.file).toBe(exportPdfPath(d.fp));
        expect(doc?.title).toBe(d.title);
        expect(doc?.storage).toMatchObject({ state: 'stored', bytes: d.bytes.length });
        const bytes = files.get(exportPdfPath(d.fp)) as Buffer;
        expect(bytes.equals(d.bytes)).toBe(true);
        expect(sha256(bytes)).toBe(d.fp);
      }
      expect(byFp.get(A.plainFp)?.file).toBeNull();
      expect(byFp.get(A.plainFp)?.storage.state).toBe('none');
      // Highlights: the tombstoned one is absent and the live count agrees with the list.
      const first = byFp.get(A.stored[0]?.fp as string);
      expect(first?.highlights).toHaveLength(1);
      expect(first?.highlightCount).toBe(1);
      expect(byFp.get(A.plainFp)?.highlights).toHaveLength(1);
    });

    it("contains none of the other user's data", async () => {
      const res = await exportReq(w, A.web);
      const { files, json } = await readExport(res);
      const text = JSON.stringify(json) + [...files.keys()].join();
      expect(text).not.toContain('exp-b');
      expect(text).not.toContain(B.a.pair.user.email);
      for (const d of B.stored) {
        expect(files.has(exportPdfPath(d.fp))).toBe(false);
        expect(text).not.toContain(d.fp);
      }
      // B's own export holds B's data only.
      const mine = await readExport(await exportReq(w, B.web));
      expect(JSON.stringify(mine.json)).not.toContain('exp-a');
      expect(mine.json.account?.email).toBe(B.a.pair.user.email);
    });

    it('streams one PDF at a time, pulled lazily from the bucket', async () => {
      const spy = new SpyStorage();
      const sw = await makeWorld(tdb.handle, { storage: spy });
      const U = await seedUser(sw, 'exp-stream', 4);
      spy.gets.length = 0;
      const { files } = await readExport(await exportReq(sw, U.web));
      expect(files.size).toBe(2 + 4);
      expect(spy.gets).toHaveLength(4);
      expect(spy.maxOpen).toBe(1);
      expect(spy.open).toBe(0);
    });

    it('does not touch the bucket when no file is stored', async () => {
      const spy = new SpyStorage();
      const sw = await makeWorld(tdb.handle, { storage: spy });
      const U = await seedUser(sw, 'exp-none', 0);
      const { files, json } = await readExport(await exportReq(sw, U.web));
      expect([...files.keys()].sort()).toEqual(['README.txt', 'clavis-export.json']);
      expect(json.documents.every((d) => d.file === null)).toBe(true);
      expect(spy.gets).toEqual([]);
    });

    it('an empty account exports an empty, valid archive', async () => {
      const a = await w.user();
      const s = await plainLogin(w, a);
      const { json } = await readExport(await exportReq(w, s));
      expect(json.savedWords).toEqual([]);
      expect(json.documents).toEqual([]);
    });

    it('pages through more words and documents than one page holds', async () => {
      const a = await w.user();
      const s = await plainLogin(w, a);
      const N = 45; // > WORD_PAGE (20)
      const { makeWord, chatIns } = await import('../sync/helpers');
      const changes = await Promise.all(
        Array.from({ length: N }, (_, i) => makeWord(`page-${i}`, 1_800_000_000_000 + i)),
      );
      for (let i = 0; i < changes.length; i += 100) await a.pushOk(changes.slice(i, i + 100));
      await a.pushOk(
        changes
          .slice(0, 3)
          .map((c, i) => chatIns(crypto.randomUUID(), c.key, 1_800_000_000_100 + i)),
      );
      const fps = Array.from({ length: 120 }, (_, i) => i.toString(16).padStart(64, '0')); // > DOC_PAGE (50)
      for (let i = 0; i < fps.length; i += 100) {
        await a.pushOk(fps.slice(i, i + 100).map((f, j) => docUp(f, 1_800_000_000_000 + i + j)));
      }
      const { json } = await readExport(await exportReq(w, s));
      expect(new Set(json.savedWords.map((x) => x.key)).size).toBe(N);
      expect(json.savedWords).toHaveLength(N);
      expect(json.savedWords.flatMap((x) => x.messages)).toHaveLength(3);
      expect(json.documents).toHaveLength(120);
      expect(new Set(json.documents.map((d) => d.fingerprint)).size).toBe(120);
    });

    describe('failures', () => {
      it('a stored object missing from the bucket gives file null and the export continues', async () => {
        const U = await seedUser(w, 'exp-miss', 2);
        const [gone, kept] = U.stored as [Seeded['stored'][number], Seeded['stored'][number]];
        const key = (
          await rows<{ object_key: string }>(
            tdb.handle,
            sql`SELECT object_key FROM documents WHERE user_id = ${U.a.userId} AND fingerprint = ${gone.fp}`,
          )
        )[0]?.object_key as string;
        await storage.delete(key);
        const { files, json } = await readExport(await exportReq(w, U.web));
        expect(files.has(exportPdfPath(gone.fp))).toBe(false);
        expect(files.get(exportPdfPath(kept.fp))?.equals(kept.bytes)).toBe(true);
        const docs = new Map(json.documents.map((d) => [d.fingerprint, d]));
        expect(docs.get(gone.fp)?.file).toBeNull();
        expect(docs.get(kept.fp)?.file).toBe(exportPdfPath(kept.fp));
      });

      it('an object that vanishes mid-export is skipped: file null, nothing aborted', async () => {
        const spy = new SpyStorage();
        const sw = await makeWorld(tdb.handle, { storage: spy });
        const U = await seedUser(sw, 'exp-vanish', 3);
        const keys = await rows<{ fingerprint: string; object_key: string }>(
          tdb.handle,
          sql`SELECT fingerprint, object_key FROM documents WHERE user_id = ${U.a.userId} AND storage_state = 'stored' ORDER BY fingerprint`,
        );
        const gone = keys[1] as { fingerprint: string; object_key: string };
        spy.vanish.add(gone.object_key); // listed at pre-flight, missing when its turn comes
        const { files, json } = await readExport(await exportReq(sw, U.web));
        expect(files.has(exportPdfPath(gone.fingerprint))).toBe(false);
        const docs = new Map(json.documents.map((d) => [d.fingerprint, d]));
        expect(docs.get(gone.fingerprint)?.file).toBeNull();
        for (const k of keys.filter((x) => x !== gone)) {
          expect(files.has(exportPdfPath(k.fingerprint))).toBe(true);
          expect(docs.get(k.fingerprint)?.file).toBe(exportPdfPath(k.fingerprint));
        }
        // `file` is non-null exactly for the PDFs present in the archive.
        for (const d of json.documents) {
          expect(d.file ? files.has(d.file) : true).toBe(true);
        }
      });

      it('a stalled client aborts the stream, releases the slot and returns the database connection', async () => {
        const { a, big } = await bigUser(w);
        void big;
        // A user with a large JSON too, so the snapshot transaction is open when the stall hits.
        const { makeWord, chatIns } = await import('../sync/helpers');
        const wc = await makeWord('stall-word', 1_800_000_000_000);
        await a.pushOk([wc]);
        for (let b = 0; b < 4; b++) {
          await a.pushOk(
            Array.from({ length: 100 }, (_, i) =>
              chatIns(crypto.randomUUID(), wc.key, 1_800_000_001_000 + b * 100 + i, {
                content: randomBytes(3000).toString('base64'),
              }),
            ),
          );
        }
        let closed = 0;
        const logs: string[] = [];
        const logger = createLogger('info', {
          write: (l: string) => void logs.push(l),
        } as unknown as NodeJS.WritableStream);
        const plan = await planExport(tdb.handle.db, storage, logger, a.userId);
        const ex = startExport({
          db: tdb.handle.db,
          storage,
          logger,
          userId: a.userId,
          nowMs: Date.now(),
          plan,
          onClose: () => void closed++,
          stallMs: 300,
        });
        void ex; // the body is never read: the consumer has stalled
        await until(() => closed === 1);
        expect(logs.join('')).toContain('EXPORT_STALLED');
        const pool = tdb.handle.pool;
        await until(() => pool.idleCount === pool.totalCount && pool.waitingCount === 0);
      });

      it('a bucket outage before streaming is a clean 503 UNAVAILABLE (no ZIP headers) and frees the slot', async () => {
        const spy = new SpyStorage();
        const sw = await makeWorld(tdb.handle, { storage: spy });
        const U = await seedUser(sw, 'exp-down', 1);
        spy.failListing = true;
        const res = await exportReq(sw, U.web);
        expect(res.status).toBe(503);
        expect(res.headers.get('content-type')).toContain('application/json');
        expect(res.headers.get('content-disposition')).toBeNull();
        expect(((await res.json()) as Err).error.code).toBe('UNAVAILABLE');
        spy.failListing = false;
        expect((await exportReq(sw, U.web)).status).toBe(200);
      });

      it('a bucket failure after streaming started aborts the response without leaking error text', async () => {
        const spy = new SpyStorage();
        const sw = await makeWorld(tdb.handle, { storage: spy });
        const U = await seedUser(sw, 'exp-abort', 3);
        const keys = (
          await rows<{ object_key: string }>(
            tdb.handle,
            sql`SELECT object_key FROM documents WHERE user_id = ${U.a.userId} AND storage_state = 'stored' ORDER BY fingerprint`,
          )
        ).map((r) => r.object_key);
        spy.failGetOn = keys[1] as string; // the second object
        const res = await exportReq(sw, U.web);
        expect(res.status).toBe(200);
        let received = '';
        let failed = false;
        try {
          const reader = (res.body as ReadableStream<Uint8Array>).getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            received += Buffer.from(value).toString('latin1');
          }
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
        expect(received).not.toContain('injected');
        await until(() => spy.open === 0);
        // The in-flight slot was released: the next export is accepted.
        spy.failGetOn = undefined;
        expect((await exportReq(sw, U.web)).status).toBe(200);
      });
    });

    describe('access rules', () => {
      it('is cookie-only: Bearer-only and anonymous callers get 401', async () => {
        const bearerOnly = await w.h.app.request('/v1/account/export', {
          headers: bearer(A.a.pair),
        });
        expect(bearerOnly.status).toBe(401);
        expect(((await bearerOnly.json()) as Err).error.code).toBe('UNAUTHENTICATED');
        expect((await w.h.app.request('/v1/account/export')).status).toBe(401);
      });

      it('needs no recent login: an old session can export', async () => {
        const a = await w.user();
        const s = await plainLogin(w, a);
        w.h.clock.advance(60 * 60_000);
        expect((await exportReq(w, s)).status).toBe(200);
      });

      it('allows one export in flight per user (429, no daily token spent) and 3 per day', async () => {
        const lw = await makeWorld(tdb.handle, { storage, limited: true });
        const { s } = await bigUser(lw);
        const first = await exportReq(lw, s); // headers received, body not yet read
        expect(first.status).toBe(200);
        for (let i = 0; i < 5; i++) {
          const dup = await exportReq(lw, s);
          expect(dup.status).toBe(429);
          const e = await errMessage(dup);
          expect(e.code).toBe('RATE_LIMITED');
          expect(e.message).toContain('in progress');
          expect(dup.headers.get('retry-after')).toBeTruthy();
        }
        await first.arrayBuffer();
        // The five refused duplicates cost nothing: two more exports fit in the day, the fourth overall does not.
        for (let i = 0; i < 2; i++) {
          const next = await exportWhenFree(lw, s);
          expect(next.status).toBe(200);
          expect((await next.arrayBuffer()).byteLength).toBeGreaterThan(0);
        }
        const fourth = await exportWhenFree(lw, s);
        expect(fourth.status).toBe(429);
        expect((await errMessage(fourth)).code).toBe('RATE_LIMITED');
        // A client that disconnects mid-download frees the slot too.
        lw.h.clock.advance(86_400_000);
        const aborted = await exportWhenFree(lw, s);
        expect(aborted.status).toBe(200);
        await aborted.body?.cancel();
        const last = await exportWhenFree(lw, s);
        expect(last.status).toBe(200);
        await last.body?.cancel();
      });

      it('caps exports process-wide with its own message (429 + Retry-After)', async () => {
        const holders: Response[] = [];
        const users = [];
        for (let i = 0; i < MAX_CONCURRENT_EXPORTS; i++) users.push(await bigUser(w));
        for (const u of users) {
          const r = await exportReq(w, u.s);
          expect(r.status).toBe(200);
          holders.push(r);
        }
        const extra = await w.user();
        const s = await plainLogin(w, extra);
        const refused = await exportReq(w, s);
        expect(refused.status).toBe(429);
        const e = await errMessage(refused);
        expect(e.code).toBe('RATE_LIMITED');
        expect(e.message).toBe('Too many exports are running; try again shortly');
        expect(refused.headers.get('retry-after')).toBeTruthy();
        for (const r of holders) await r.body?.cancel();
        const ok = await exportWhenFree(w, s);
        expect(ok.status).toBe(200);
        await ok.arrayBuffer();
      });

      it('HEAD is 405 and neither takes a slot nor touches the bucket', async () => {
        const spy = new SpyStorage();
        const sw = await makeWorld(tdb.handle, { storage: spy });
        const U = await seedUser(sw, 'exp-head', 1);
        spy.gets.length = 0;
        const head = await sw.h.app.request('/v1/account/export', {
          method: 'HEAD',
          headers: { cookie: U.web.cookie },
        });
        expect(head.status).toBe(405);
        expect(head.headers.get('allow')).toBe('GET');
        expect(spy.gets).toEqual([]);
        expect((await exportReq(sw, U.web)).status).toBe(200); // no slot was taken
      });

      it('HEAD on a stored file is answered from the database row, without a bucket read', async () => {
        const spy = new SpyStorage();
        const sw = await makeWorld(tdb.handle, { storage: spy });
        const U = await seedUser(sw, 'exp-headfile', 1);
        spy.gets.length = 0;
        const fp = (U.stored[0] as { fp: string }).fp;
        const head = await sw.h.app.request(`/v1/documents/${fp}/file`, {
          method: 'HEAD',
          headers: bearer(U.a.pair),
        });
        expect(head.status).toBe(200);
        expect(head.headers.get('content-type')).toBe('application/pdf');
        expect(spy.gets).toEqual([]);
      });

      it('refuses cross-site fetches with 403 FORBIDDEN before spending a daily token', async () => {
        const lw = await makeWorld(tdb.handle, { storage, limited: true });
        const a = await lw.user();
        const s = await plainLogin(lw, a);
        for (const site of ['cross-site', 'same-site', 'bogus']) {
          for (let i = 0; i < 3; i++) {
            const res = await lw.h.app.request('/v1/account/export', {
              headers: { cookie: s.cookie, 'sec-fetch-site': site },
            });
            expect(res.status, site).toBe(403);
            expect((await errMessage(res)).code).toBe('FORBIDDEN');
          }
        }
        // same-origin, none and absent are accepted, and the nine refusals above cost nothing.
        let done = 0;
        for (const site of ['same-origin', 'none', undefined]) {
          const res = await lw.h.app.request('/v1/account/export', {
            headers: { cookie: s.cookie, ...(site ? { 'sec-fetch-site': site } : {}) },
          });
          expect(res.status, String(site)).toBe(200);
          await res.arrayBuffer();
          await until(() => finished(lw) === ++done);
        }
        const fourth = await exportWhenFree(lw, s);
        expect(fourth.status).toBe(429);
      });

      it('a pre-stream 503 does not spend a daily token', async () => {
        const spy = new SpyStorage();
        const lw = await makeWorld(tdb.handle, { storage: spy, limited: true });
        const U = await seedUser(lw, 'exp-503', 1);
        spy.failListing = true;
        for (let i = 0; i < 5; i++) expect((await exportReq(lw, U.web)).status).toBe(503);
        spy.failListing = false;
        for (let i = 0; i < 3; i++) {
          const ok = await exportWhenFree(lw, U.web);
          expect(ok.status).toBe(200);
          await ok.arrayBuffer();
        }
        const fourth = await exportWhenFree(lw, U.web);
        expect(fourth.status).toBe(429);
      });

      it('deleting the account aborts an export in flight', async () => {
        const dw = await makeWorld(tdb.handle, { storage });
        const { a, s } = await bigUser(dw, true);
        const res = await exportReq(dw, s);
        expect(res.status).toBe(200);
        expect((await deleteAccountReq(dw, s)).status).toBe(204);
        let failed = false;
        try {
          await res.arrayBuffer();
        } catch {
          failed = true;
        }
        expect(failed).toBe(true);
        expect(
          (await rows(tdb.handle, sql`SELECT 1 FROM users WHERE id = ${a.userId}`)) as unknown[],
        ).toHaveLength(0);
      });

      it('does not log emails, names, titles or word text', async () => {
        await (await exportReq(w, A.web)).arrayBuffer();
        const logs = w.h.logs.join('');
        for (const needle of [A.a.pair.user.email, 'exp-a', 'Ada Lovelace']) {
          expect(logs).not.toContain(needle);
        }
        expect(logs).toContain('export finished');
      });
    });
  },
);

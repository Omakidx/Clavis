import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DocumentDetailResponse,
  DocumentsResponse,
  WordDetailResponse,
  WordsResponse,
} from '../../../shared/api-contract';
import { ORIGIN, bearer, webLogin, type WebLogin } from '../auth/harness';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import {
  Api,
  chatIns,
  docDel,
  docUp,
  fp,
  hlUp,
  makeWord,
  makeWorld,
  meaning,
  rows,
  userRow,
  wordDel,
  type World,
} from '../sync/helpers';

// Integration files run in parallel against one Postgres; give slow cases headroom.
vi.setConfig({ testTimeout: 30_000 });

type Err = { error: { code: string } };

describe.skipIf(!adminUrl)('words and documents REST (real Postgres)', () => {
  let tdb: TestDb;
  let w: World;
  let T: number;

  beforeAll(async () => {
    tdb = await createTestDb(25);
    w = await makeWorld(tdb.handle);
    T = w.h.clock.now();
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const get = (a: Api, path: string) => a.req('GET', path);
  const code = async (r: Response) => ((await r.json()) as Err).error.code;
  const cookieOf = (a: Api) =>
    webLogin(w.h, { sub: a.sub, email: `${a.sub}@example.test` }, {}) as Promise<WebLogin>;
  const cookieReq = (
    c: WebLogin,
    method: string,
    path: string,
    extra: Record<string, string> = {},
  ) => w.h.app.request(path, { method, headers: { cookie: c.cookie, ...extra } });
  const csrfHeaders = (c: WebLogin) => ({ origin: ORIGIN, 'x-csrf-token': c.csrf });

  describe('GET /v1/words', () => {
    it('lists live words newest first with title, summary, source and messageCount', async () => {
      const a = await w.user();
      const old = await makeWord('apple', T - 3000, {
        meaning: meaning({ title: 'Apple', summary: 'A fruit' }),
      });
      const mid = await makeWord('banana', T - 2000);
      const gone = await makeWord('cherry', T - 1000);
      await a.pushOk([
        old,
        mid,
        gone,
        chatIns(randomUUID(), old.key, T),
        chatIns(randomUUID(), old.key, T + 1),
      ]);
      await a.pushOk([await wordDel('cherry', T)]);
      const res = await get(a, '/v1/words');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const body = WordsResponse.parse(await res.json());
      expect(body.items.map((i) => i.text)).toEqual(['banana', 'apple']);
      expect(body.items[1]).toMatchObject({
        key: old.key,
        title: 'Apple',
        summary: 'A fruit',
        messageCount: 2,
        createdAt: T - 3000,
      });
      expect(body.nextCursor).toBeNull();
    });

    it('searches text, title and summary case-insensitively and treats % and _ literally', async () => {
      const a = await w.user();
      await a.pushOk([
        await makeWord('Quokka', T, {
          meaning: meaning({ title: 'Small marsupial', summary: 'smiles a lot' }),
        }),
        await makeWord('100% sure', T + 1),
        await makeWord('under_score', T + 2),
        await makeWord('underXscore', T + 3),
      ]);
      const texts = async (qs: string) =>
        WordsResponse.parse(await (await get(a, `/v1/words?${qs}`)).json())
          .items.map((i) => i.text)
          .sort();
      expect(await texts('q=QUOK')).toEqual(['Quokka']);
      expect(await texts('q=marsupial')).toEqual(['Quokka']);
      expect(await texts('q=SMILES')).toEqual(['Quokka']);
      expect(await texts('q=' + encodeURIComponent('%'))).toEqual(['100% sure']);
      expect(await texts('q=' + encodeURIComponent('r_s'))).toEqual(['under_score']);
      expect(await texts('q=nomatch')).toEqual([]);
      expect((await get(a, `/v1/words?q=${'x'.repeat(101)}`)).status).toBe(400);
    });

    it('keyset pagination is stable across inserts and deletes between pages (ties on createdAt too)', async () => {
      const a = await w.user();
      const mk = async (t: string, at: number) => makeWord(t, T, { createdAt: at });
      const items = await Promise.all(
        ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'].map((t, i) =>
          mk(t, T - (i < 4 ? 100 : 200 + i)),
        ),
      );
      await a.pushOk(items);
      const page = async (cursor: string | null) => {
        const r = await get(a, `/v1/words?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
        expect(r.status).toBe(200);
        return WordsResponse.parse(await r.json());
      };
      const p1 = await page(null);
      expect(p1.items).toHaveLength(3);
      expect(p1.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
      // A newer word and a deletion of an unseen one happen between page 1 and page 2.
      await a.pushOk([
        await makeWord('newest', T, { createdAt: T + 50 }),
        await wordDel(items[6]?.data.text ?? '', T + 1),
      ]);
      const p2 = await page(p1.nextCursor);
      expect(p2.nextCursor).toBeNull(); // p7 was deleted, so six live words remain after `newest`
      const p3 = { items: [] as typeof p2.items, nextCursor: null };
      const seen = [...p1.items, ...p2.items, ...p3.items].map((i) => i.text);
      expect(new Set(seen).size).toBe(seen.length); // no duplicates
      expect(seen).toEqual(expect.arrayContaining(['p1', 'p2', 'p3', 'p4', 'p5', 'p6']));
      expect(seen).not.toContain('p7');
      expect(seen).not.toContain('newest'); // inserted before the cursor position: not revisited
      expect(p3.nextCursor).toBeNull();
      // Order is by createdAt desc, then key.
      const ordered = [...p1.items, ...p2.items, ...p3.items];
      for (let i = 1; i < ordered.length; i++) {
        const [x, y] = [ordered[i - 1], ordered[i]];
        expect(
          x && y && (x.createdAt > y.createdAt || (x.createdAt === y.createdAt && x.key < y.key)),
        ).toBe(true);
      }
    });

    it('validates limit and cursor', async () => {
      const a = await w.user();
      for (const qs of [
        'limit=0',
        'limit=101',
        'limit=x',
        'cursor=!!!',
        'cursor=' + Buffer.from('[1,"x"]').toString('base64url'),
        'extra=1',
      ]) {
        const r = await get(a, `/v1/words?${qs}`);
        expect([r.status, await code(r)], qs).toEqual([400, 'VALIDATION_FAILED']);
      }
      expect((await get(a, '/v1/words?limit=100')).status).toBe(200);
    });
  });

  describe('GET /v1/words/:key', () => {
    it('returns the word and its messages by createdAt', async () => {
      const a = await w.user();
      const word = await makeWord('detail', T);
      const [m1, m2] = [randomUUID(), randomUUID()];
      await a.pushOk([
        word,
        chatIns(m2, word.key, T + 20, { role: 'assistant', content: 'second', model: 'mm' }),
        chatIns(m1, word.key, T + 10, { content: 'first' }),
      ]);
      const res = await get(a, `/v1/words/${word.key}`);
      expect(res.status).toBe(200);
      const body = WordDetailResponse.parse(await res.json());
      expect(body.word).toMatchObject({ key: word.key, text: 'detail', clientModifiedAt: T });
      expect(body.messages).toEqual([
        { id: m1, role: 'user', content: 'first', model: null, createdAt: T + 10 },
        { id: m2, role: 'assistant', content: 'second', model: 'mm', createdAt: T + 20 },
      ]);
    });

    it('404 for a non-hex key, an unknown key and a tombstone', async () => {
      const a = await w.user();
      const word = await makeWord('tomb', T);
      await a.pushOk([word, await wordDel('tomb', T + 1)]);
      for (const k of ['nothex', 'A'.repeat(64), 'a'.repeat(63), 'a'.repeat(64), word.key]) {
        const r = await get(a, `/v1/words/${k}`);
        expect([k.slice(0, 8), r.status, await code(r)]).toEqual([k.slice(0, 8), 404, 'NOT_FOUND']);
      }
    });
  });

  describe('DELETE /v1/words/:key', () => {
    it('tombstones the word, hard-deletes its messages, bumps seq and is visible to pull', async () => {
      const a = await w.user();
      const word = await makeWord('to-delete', T);
      await a.pushOk([word, chatIns(randomUUID(), word.key, T)]); // seqs 1, 2
      const res = await a.req('DELETE', `/v1/words/${word.key}`);
      expect(res.status).toBe(204);
      expect(await res.text()).toBe('');
      expect((await userRow(tdb.handle, a.userId)).change_seq).toBe('3');
      expect(
        await rows(tdb.handle, sql`SELECT 1 FROM word_chat_messages WHERE user_id = ${a.userId}`),
      ).toHaveLength(0);
      const pulled = await a.pullAll('2');
      expect(pulled.changes).toEqual([
        expect.objectContaining({
          kind: 'word',
          key: word.key,
          seq: '3',
          deleted: true,
          data: null,
        }),
      ]);
      expect((await get(a, `/v1/words/${word.key}`)).status).toBe(404);
      expect((await a.req('DELETE', `/v1/words/${word.key}`)).status).toBe(404);
      expect((await a.req('DELETE', `/v1/words/${'0'.repeat(64)}`)).status).toBe(404);
      expect((await a.req('DELETE', '/v1/words/zzz')).status).toBe(404);
    });

    it('wins over a stored record with a later client time, and a subsequent older push is stale', async () => {
      const a = await w.user();
      const word = await makeWord('future', T + 30_000); // stored cma ahead of "now"
      await a.pushOk([word]);
      expect((await a.req('DELETE', `/v1/words/${word.key}`)).status).toBe(204);
      const r = await a.pushOk([await makeWord('future', T + 30_000)]);
      expect(r.results[0]?.status).toBe('stale');
    });
  });

  describe('documents', () => {
    it('lists live documents most recently read first, with highlightCount and storage', async () => {
      const a = await w.user();
      await a.pushOk([
        docUp(fp('a'), T - 300, { title: 'Old' }),
        docUp(fp('b'), T - 100, { title: 'New' }),
        docUp(fp('c'), T - 200, { title: 'Gone' }),
        hlUp(randomUUID(), fp('b'), T),
        hlUp(randomUUID(), fp('b'), T),
        docDel(fp('c'), T),
      ]);
      await rows(
        tdb.handle,
        sql`UPDATE documents SET storage_state='stored', object_key='k', stored_bytes=42, stored_at=now() WHERE user_id=${a.userId} AND fingerprint=${fp('b')}`,
      );
      const res = await get(a, '/v1/documents');
      expect(res.status).toBe(200);
      const body = DocumentsResponse.parse(await res.json());
      expect(body.items.map((d) => d.title)).toEqual(['New', 'Old']);
      expect(body.items[0]).toMatchObject({
        fingerprint: fp('b'),
        highlightCount: 2,
        storage: { state: 'stored', bytes: 42 },
        clientModifiedAt: T - 100,
      });
      expect(body.items[0]?.storage.storedAt).toEqual(expect.any(Number));
      expect(body.items[1]?.storage).toEqual({ state: 'none', bytes: null, storedAt: null });
    });

    it('paginates with a stable keyset cursor', async () => {
      const a = await w.user();
      await a.pushOk(
        ['1', '2', '3', '4', '5'].map((c, i) =>
          docUp(fp(c), T - (i < 3 ? 10 : 50 - i), { title: c }),
        ),
      );
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 5; i++) {
        const r = await get(a, `/v1/documents?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
        const body = DocumentsResponse.parse(await r.json());
        seen.push(...body.items.map((d) => d.fingerprint));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(5);
      expect(new Set(seen).size).toBe(5);
    });

    it('returns detail with live highlights; 404 for non-hex, unknown and tombstoned', async () => {
      const a = await w.user();
      const [h1, h2] = [randomUUID(), randomUUID()];
      await a.pushOk([
        docUp(fp('d'), T, { title: 'Detail' }),
        hlUp(h2, fp('d'), T, { page: 2, start: 3, end: 8 }),
        hlUp(h1, fp('d'), T, { page: 1, start: 0, end: 5 }),
        docUp(fp('e'), T),
        docDel(fp('e'), T + 1),
      ]);
      const res = await get(a, `/v1/documents/${fp('d')}`);
      const body = DocumentDetailResponse.parse(await res.json());
      expect(body.document).toMatchObject({
        fingerprint: fp('d'),
        title: 'Detail',
        highlightCount: 2,
      });
      expect(body.highlights.map((h) => h.id)).toEqual([h1, h2]);
      for (const k of ['nothex', fp('9'), fp('e')]) {
        expect((await get(a, `/v1/documents/${k}`)).status).toBe(404);
      }
    });

    it('DELETE tombstones the document and its highlights, refunds a stored file and queues the object', async () => {
      const a = await w.user();
      const h1 = randomUUID();
      await a.pushOk([docUp(fp('d'), T), hlUp(h1, fp('d'), T)]); // seqs 1, 2
      await rows(
        tdb.handle,
        sql`UPDATE documents SET storage_state='stored', object_key='u/x/doc.pdf', stored_bytes=777, stored_at=now() WHERE user_id=${a.userId}`,
      );
      await rows(tdb.handle, sql`UPDATE users SET storage_used_bytes = 777 WHERE id=${a.userId}`);
      const res = await a.req('DELETE', `/v1/documents/${fp('d')}`);
      expect(res.status).toBe(204);
      expect((await userRow(tdb.handle, a.userId)).storage_used_bytes).toBe('0');
      expect(
        await rows(tdb.handle, sql`SELECT 1 FROM object_deletions WHERE object_key='u/x/doc.pdf'`),
      ).toHaveLength(1);
      const pulled = await a.pullAll('2');
      expect(pulled.changes.map((c) => [c.kind, c.seq, 'deleted' in c ? c.deleted : null])).toEqual(
        [
          ['highlight', '3', true],
          ['document', '4', true],
        ],
      );
      expect((await get(a, `/v1/documents/${fp('d')}`)).status).toBe(404);
      expect((await a.req('DELETE', `/v1/documents/${fp('d')}`)).status).toBe(404);
      expect((await a.req('DELETE', '/v1/documents/zz')).status).toBe(404);
      // The title is no longer listed.
      expect(DocumentsResponse.parse(await (await get(a, '/v1/documents')).json()).items).toEqual(
        [],
      );
    });
  });

  describe('isolation between users (IDOR matrix)', () => {
    it("another user's keys are 404 for every method, and nothing of theirs leaks or changes", async () => {
      const [alice, bob] = [await w.user(), await w.user()];
      const word = await makeWord('alice-secret', T);
      await alice.pushOk([
        word,
        chatIns(randomUUID(), word.key, T, { content: 'alice chat' }),
        docUp(fp('a'), T, { title: 'Alice document' }),
        hlUp(randomUUID(), fp('a'), T),
      ]);
      await bob.pushOk([
        await makeWord('bob-word', T),
        docUp(fp('b'), T, { title: 'Bob document' }),
      ]);
      const bobCookie = await cookieOf(bob);

      const attempts: [string, string][] = [
        ['GET', `/v1/words/${word.key}`],
        ['DELETE', `/v1/words/${word.key}`],
        ['GET', `/v1/documents/${fp('a')}`],
        ['DELETE', `/v1/documents/${fp('a')}`],
      ];
      for (const [m, p] of attempts) {
        const viaBearer = await bob.req(m, p);
        expect([m, p, viaBearer.status, await code(viaBearer)]).toEqual([m, p, 404, 'NOT_FOUND']);
        const viaCookie = await cookieReq(
          bobCookie,
          m,
          p,
          m === 'GET' ? {} : csrfHeaders(bobCookie),
        );
        expect([m, p, viaCookie.status, await code(viaCookie)]).toEqual([m, p, 404, 'NOT_FOUND']);
      }
      const bobLists = JSON.stringify([
        await (await get(bob, '/v1/words')).json(),
        await (await get(bob, '/v1/documents')).json(),
        await (await get(bob, '/v1/words?q=alice')).json(),
        await bob.pullAll(),
      ]);
      expect(bobLists).not.toMatch(/alice/i);

      // Alice's data is untouched, and Bob's own rows were not disturbed.
      expect((await get(alice, `/v1/words/${word.key}`)).status).toBe(200);
      expect((await get(alice, `/v1/documents/${fp('a')}`)).status).toBe(200);
      expect((await alice.pullAll()).changes).toHaveLength(4);
      expect((await get(bob, `/v1/documents/${fp('b')}`)).status).toBe(200);
    });
  });

  describe('authentication, CSRF and rate limits', () => {
    it('requires credentials', async () => {
      const key = '1'.repeat(64);
      for (const [m, p] of [
        ['GET', '/v1/words'],
        ['GET', `/v1/words/${key}`],
        ['DELETE', `/v1/words/${key}`],
        ['GET', '/v1/documents'],
        ['GET', `/v1/documents/${key}`],
        ['DELETE', `/v1/documents/${key}`],
      ] as const) {
        const r = await w.h.app.request(p, { method: m });
        expect([m, p, r.status]).toEqual([m, p, 401]);
      }
    });

    it('cookie sessions can read; a cookie DELETE needs the CSRF token, the exact Origin and no foreign body type', async () => {
      const a = await w.user();
      const word = await makeWord('csrf-word', T);
      await a.pushOk([word, docUp(fp('c'), T)]);
      const c = await cookieOf(a);
      expect((await cookieReq(c, 'GET', '/v1/words')).status).toBe(200);
      expect((await cookieReq(c, 'GET', `/v1/words/${word.key}`)).status).toBe(200);
      expect((await cookieReq(c, 'GET', '/v1/documents')).status).toBe(200);

      const path = `/v1/words/${word.key}`;
      const noToken = await cookieReq(c, 'DELETE', path, { origin: ORIGIN });
      expect([noToken.status, await code(noToken)]).toEqual([403, 'CSRF_FAILED']);
      const noOrigin = await cookieReq(c, 'DELETE', path, { 'x-csrf-token': c.csrf });
      expect([noOrigin.status, await code(noOrigin)]).toEqual([403, 'CSRF_FAILED']);
      const badOrigin = await cookieReq(c, 'DELETE', path, {
        origin: 'https://evil.example',
        'x-csrf-token': c.csrf,
      });
      expect(badOrigin.status).toBe(403);
      const badToken = await cookieReq(c, 'DELETE', path, {
        origin: ORIGIN,
        'x-csrf-token': 'x'.repeat(c.csrf.length),
      });
      expect(badToken.status).toBe(403);
      const docNoToken = await cookieReq(c, 'DELETE', `/v1/documents/${fp('c')}`, {
        origin: ORIGIN,
      });
      expect([docNoToken.status, await code(docNoToken)]).toEqual([403, 'CSRF_FAILED']);
      expect((await get(a, path)).status).toBe(200); // nothing was deleted by any failed attempt

      expect((await cookieReq(c, 'DELETE', path, csrfHeaders(c))).status).toBe(204);
      expect(
        (await cookieReq(c, 'DELETE', `/v1/documents/${fp('c')}`, csrfHeaders(c))).status,
      ).toBe(204);
      // Bearer needs no CSRF headers.
      const other = await makeWord('bearer-del', T);
      await a.pushOk([other]);
      expect((await a.req('DELETE', `/v1/words/${other.key}`)).status).toBe(204);
    });

    it('is rate limited at 120/min/user per resource group', async () => {
      const lim = await makeWorld(tdb.handle, { limited: true });
      const u = await lim.user();
      for (let i = 0; i < 120; i++) {
        expect((await lim.h.app.request('/v1/words', { headers: bearer(u.pair) })).status).toBe(
          200,
        );
      }
      const over = await lim.h.app.request('/v1/words', { headers: bearer(u.pair) });
      expect(over.status).toBe(429);
      expect((await lim.h.app.request('/v1/documents', { headers: bearer(u.pair) })).status).toBe(
        200,
      );
    });
  });
});

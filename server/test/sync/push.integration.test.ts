import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { LIMITS, wordKey } from '../../../shared/api-contract';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import {
  Api,
  chatIns,
  docDel,
  docUp,
  fp,
  hlDel,
  hlUp,
  makeWord,
  makeWorld,
  meaning,
  rows,
  userRow,
  wordDel,
  type World,
} from './helpers';

// Integration files run in parallel against one Postgres; give slow cases headroom.
vi.setConfig({ testTimeout: 30_000 });

type Err = { error: { code: string; details?: { field?: string } } };

describe.skipIf(!adminUrl)('POST /v1/sync/push (real Postgres)', () => {
  let tdb: TestDb;
  let w: World;
  let a: Api;
  let T: number;

  beforeAll(async () => {
    tdb = await createTestDb(25);
    w = await makeWorld(tdb.handle);
    T = w.h.clock.now();
  });
  afterAll(async () => {
    await tdb.drop();
  });
  // A fresh user per test keeps counts and seqs independent.
  const fresh = async () => (a = await w.user());
  const q = <R = Record<string, unknown>>(s: ReturnType<typeof sql>) => rows<R>(tdb.handle, s);

  describe('last-writer-wins', () => {
    it('applies a new word with the first seq', async () => {
      await fresh();
      const r = await a.pushOk([await makeWord('Serendipity', T)]);
      expect(r.results).toEqual([{ index: 0, status: 'applied', seq: '1' }]);
      expect(r.serverTime).toBe(T);
      const [row] = await q<{ text: string; seq: string; deleted_at: null }>(
        sql`SELECT text, seq::text, deleted_at FROM saved_words WHERE user_id = ${a.userId}`,
      );
      expect(row).toMatchObject({ text: 'Serendipity', seq: '1', deleted_at: null });
      expect((await userRow(tdb.handle, a.userId)).change_seq).toBe('1');
    });

    it('equal or older is stale and returns the server record; newer replaces it', async () => {
      await fresh();
      const first = await makeWord('alpha', T, { meaning: meaning({ title: 'first' }) });
      await a.pushOk([first]);
      const older = await makeWord('alpha', T - 1, { meaning: meaning({ title: 'older' }) });
      const equal = await makeWord('alpha', T, { meaning: meaning({ title: 'equal' }) });
      const r = await a.pushOk([older, equal]);
      for (const res of r.results) {
        expect(res.status).toBe('stale');
        expect(res.current).toMatchObject({
          kind: 'word',
          key: first.key,
          seq: '1',
          deleted: false,
          clientModifiedAt: T,
          data: { meaning: { title: 'first' } },
        });
      }
      const newer = await makeWord('alpha', T + 1, { meaning: meaning({ title: 'newer' }) });
      expect((await a.pushOk([newer])).results[0]).toEqual({
        index: 0,
        status: 'applied',
        seq: '2',
      });
      const pulled = await a.pullAll();
      expect(pulled.changes).toHaveLength(1);
      expect(pulled.changes[0]).toMatchObject({ seq: '2', data: { meaning: { title: 'newer' } } });
    });

    it('re-saving a word keeps its chat', async () => {
      await fresh();
      const word = await makeWord('beta', T);
      await a.pushOk([word, chatIns(randomUUID(), word.key, T)]);
      await a.pushOk([await makeWord('beta', T + 5, { meaning: meaning({ title: 'again' }) })]);
      const [n] = await q<{ n: string }>(
        sql`SELECT count(*)::text n FROM word_chat_messages WHERE user_id = ${a.userId}`,
      );
      expect(n?.n).toBe('1');
    });

    it('clamps clientModifiedAt to now + 60 s', async () => {
      await fresh();
      const far = await makeWord('gamma', T + 86_400_000);
      await a.pushOk([far]);
      const [row] = await q<{ cma: string }>(
        sql`SELECT (extract(epoch FROM client_modified_at) * 1000)::bigint::text cma FROM saved_words WHERE user_id = ${a.userId}`,
      );
      expect(Number(row?.cma)).toBe(T + 60_000);
      // Something between now and the clamp is older than the stored (clamped) value.
      const r = await a.pushOk([await makeWord('gamma', T + 30_000)]);
      expect(r.results[0]?.status).toBe('stale');
    });

    it('rejects values before 2020-01-01 per item without aborting the batch', async () => {
      await fresh();
      const bad = await makeWord('delta', 1_577_836_799_999);
      const good = await makeWord('epsilon', T);
      const r = await a.pushOk([bad, good]);
      expect(r.results).toEqual([
        { index: 0, status: 'rejected', code: 'VALIDATION_FAILED' },
        { index: 1, status: 'applied', seq: '1' },
      ]);
    });

    it('tombstones win only if newer; a newer upsert resurrects; an older upsert is stale', async () => {
      await fresh();
      const word = await makeWord('zeta', T);
      await a.pushOk([word]);
      expect((await a.pushOk([await wordDel('zeta', T - 1)])).results[0]?.status).toBe('stale');
      expect((await a.pushOk([await wordDel('zeta', T)])).results[0]?.status).toBe('stale');
      expect((await a.pushOk([await wordDel('zeta', T + 10)])).results[0]).toMatchObject({
        status: 'applied',
        seq: '2',
      });
      // The tombstone keeps no content.
      const [t] = await q<Record<string, unknown>>(
        sql`SELECT text, meaning, language, context_before, source_url, source_title, pdf_fingerprint, deleted_at
            FROM saved_words WHERE user_id = ${a.userId}`,
      );
      expect(t).toMatchObject({
        text: '-',
        meaning: {},
        language: null,
        context_before: null,
        source_url: null,
        source_title: null,
        pdf_fingerprint: null,
      });
      expect(t?.['deleted_at']).not.toBeNull();
      const stale = await a.pushOk([await makeWord('zeta', T + 10), await makeWord('zeta', T + 9)]);
      expect(stale.results.map((x) => x.status)).toEqual(['stale', 'stale']);
      expect(stale.results[0]?.current).toMatchObject({ deleted: true, data: null, seq: '2' });
      const res = await a.pushOk([await makeWord('zeta', T + 11)]);
      expect(res.results[0]).toMatchObject({ status: 'applied', seq: '3' });
      const [live] = await q<{ deleted_at: null; text: string }>(
        sql`SELECT text, deleted_at FROM saved_words WHERE user_id = ${a.userId}`,
      );
      expect(live).toMatchObject({ text: 'zeta', deleted_at: null });
    });

    it('a delete for an unknown word leaves a tombstone that beats an older upsert', async () => {
      await fresh();
      expect((await a.pushOk([await wordDel('eta', T)])).results[0]?.status).toBe('applied');
      expect((await a.pushOk([await makeWord('eta', T - 5)])).results[0]?.status).toBe('stale');
    });

    it('strips query and fragment from source URLs and rejects non-http(s) schemes', async () => {
      await fresh();
      const ok = await makeWord('theta', T, {
        source: { kind: 'webpage', url: 'https://example.test/p?token=secret#frag', title: null },
      });
      const evil = await makeWord('iota', T, {
        source: { kind: 'webpage', url: 'javascript:alert(1)', title: null },
      });
      const r = await a.pushOk([ok, evil]);
      expect(r.results.map((x) => x.status)).toEqual(['applied', 'rejected']);
      const p = await a.pullAll();
      expect(p.changes[0]).toMatchObject({ data: { source: { url: 'https://example.test/p' } } });
    });

    it('stores a pdf source with its fingerprint and page', async () => {
      await fresh();
      const word = await makeWord('kappa', T, {
        source: { kind: 'pdf', fingerprint: fp('c'), title: 'P', page: 3 },
      });
      await a.pushOk([word]);
      const p = await a.pullAll();
      expect(p.changes[0]).toMatchObject({
        data: { source: { kind: 'pdf', fingerprint: fp('c'), title: 'P', page: 3 } },
      });
    });
  });

  describe('validation', () => {
    it('rejects a wordKey that does not match the text', async () => {
      await fresh();
      const word = await makeWord('lambda', T);
      const bad = { ...word, key: await wordKey('something else') };
      const r = await a.pushOk([bad]);
      expect(r.results[0]).toEqual({ index: 0, status: 'rejected', code: 'VALIDATION_FAILED' });
      expect((await a.pullAll()).changes).toHaveLength(0);
    });

    it('normalises the key: whitespace and case variants share one identity', async () => {
      await fresh();
      const word = await makeWord('  Mu   Nu ', T);
      expect(word.key).toBe(await wordKey('mu nu'));
      const r = await a.pushOk([word]);
      expect(r.results[0]?.status).toBe('applied');
    });

    it('rejects per item: malformed items, unknown fields, NUL characters, server-owned storage fields', async () => {
      await fresh();
      const word = await makeWord('nu', T);
      const nul = await makeWord('xi', T, { meaning: meaning({ summary: 'a\u0000b' }) });
      const lone = await makeWord('omicron', T, { meaning: meaning({ summary: 'a\ud800b' }) });
      const withStorage = {
        kind: 'document',
        op: 'upsert',
        key: fp('1'),
        clientModifiedAt: T,
        data: {
          title: 'x',
          pageCount: 1,
          lastPage: 1,
          pageOffset: 0,
          fileBytes: 1,
          storageState: 'stored',
        },
      };
      const r = await a.pushOk([
        { kind: 'nonsense' },
        { ...word, extra: 1 },
        nul,
        lone,
        withStorage,
        word,
      ]);
      expect(r.results.map((x) => x.status)).toEqual([
        'rejected',
        'rejected',
        'rejected',
        'rejected',
        'rejected',
        'applied',
      ]);
      expect(r.results.slice(0, 5).every((x) => x.code === 'VALIDATION_FAILED')).toBe(true);
      expect(r.results[5]?.seq).toBe('1'); // rejected items consume no seq
    });

    it('a database CHECK failure rejects only that item and leaves no seq gap', async () => {
      await fresh();
      // Control characters escape to 6 bytes each in jsonb text: the meaning exceeds the 16 KiB CHECK.
      const c = '\u0001';
      const heavy = await makeWord('pi', T, {
        meaning: {
          title: c.repeat(120),
          summary: c.repeat(600),
          contextualMeaning: c.repeat(800),
          definition: c.repeat(600),
          examples: [
            { sentence: c.repeat(300), note: c.repeat(200) },
            { sentence: c.repeat(300), note: c.repeat(200) },
          ],
          caveat: c.repeat(400),
          model: c.repeat(128),
        },
      });
      const r = await a.pushOk([await makeWord('rho', T), heavy, await makeWord('sigma', T)]);
      expect(r.results).toEqual([
        { index: 0, status: 'applied', seq: '1' },
        { index: 1, status: 'rejected', code: 'VALIDATION_FAILED' },
        { index: 2, status: 'applied', seq: '2' },
      ]);
      expect((await userRow(tdb.handle, a.userId)).change_seq).toBe('2');
    });

    it('enforces the combined context length', async () => {
      await fresh();
      const ok = await makeWord('tau', T, {
        contextBefore: 'a'.repeat(500),
        contextAfter: 'b'.repeat(500),
      });
      const bad = await makeWord('upsilon', T, {
        contextBefore: 'a'.repeat(600),
        contextAfter: 'b'.repeat(600),
      });
      const r = await a.pushOk([ok, bad]);
      expect(r.results.map((x) => x.status)).toEqual(['applied', 'rejected']);
    });

    it('far-future timestamps are item-level rejections, never a batch abort', async () => {
      await fresh();
      const max = 253_402_300_799_999;
      const future = await makeWord('far-future', T, { createdAt: 9e15 });
      const beyond = await makeWord('beyond', T, { createdAt: max + 1 });
      const farCma = await makeWord('far-cma', 9e15);
      const hl = hlUp(randomUUID(), fp('6'), T);
      const farHl = { ...hl, data: { ...(hl as { data: object }).data, createdAt: 9e15 } };
      const edge = await makeWord('edge', T, { createdAt: max });
      const r = await a.pushOk([future, beyond, farCma, farHl, edge]);
      expect(r.results.map((x) => x.status + (x.code ? `/${x.code}` : ''))).toEqual([
        'rejected/VALIDATION_FAILED',
        'rejected/VALIDATION_FAILED',
        'rejected/VALIDATION_FAILED',
        'rejected/VALIDATION_FAILED',
        'applied',
      ]);
      expect(r.results[4]?.seq).toBe('1');
    });

    it('a deeply nested body is a 400, not a 500', async () => {
      await fresh();
      const n = 100_000;
      const body = `{"changes":${'['.repeat(n)}${']'.repeat(n)}}`;
      expect(body.length).toBeLessThan(LIMITS.maxJsonBodyBytes);
      const res = await w.h.app.request('/v1/sync/push', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${a.pair.accessToken}`,
          'content-type': 'application/json',
          'idempotency-key': randomUUID(),
        },
        body,
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as Err).error.code).toBe('VALIDATION_FAILED');
    });

    it('request-level errors', async () => {
      await fresh();
      const post = (body: string, headers: Record<string, string> = {}) =>
        w.h.app.request('/v1/sync/push', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${a.pair.accessToken}`,
            'content-type': 'application/json',
            'idempotency-key': randomUUID(),
            ...headers,
          },
          body,
        });
      const code = async (r: Response) => ((await r.json()) as Err).error.code;
      const one = JSON.stringify({ changes: [await makeWord('phi', T)] });
      expect(await code(await post('{"changes":[]}'))).toBe('VALIDATION_FAILED');
      expect(await code(await post('{"changes":[],"x":1}'))).toBe('VALIDATION_FAILED');
      expect(await code(await post('not json'))).toBe('VALIDATION_FAILED');
      const many = JSON.stringify({
        changes: Array.from({ length: LIMITS.maxPushChanges + 1 }, () => ({})),
      });
      expect(await code(await post(many))).toBe('VALIDATION_FAILED');
      const wrongType = await post(one, { 'content-type': 'text/plain' });
      expect(wrongType.status).toBe(415);
      const missing = await post(one, { 'idempotency-key': '' });
      expect(missing.status).toBe(400);
      expect(((await missing.json()) as Err).error.details?.field).toBe('Idempotency-Key');
      expect((await post(one, { 'idempotency-key': 'not-a-uuid' })).status).toBe(400);
      const huge = await post(
        JSON.stringify({ changes: [{ pad: 'x'.repeat(LIMITS.maxJsonBodyBytes) }] }),
      );
      expect(huge.status).toBe(413);
      expect((await post(one)).status).toBe(200);
      expect((await post(one)).headers.get('cache-control')).toBe('no-store');
    });

    it('requires a Bearer token (no cookie route) and is rate limited at 60/min/user', async () => {
      const lim = await makeWorld(tdb.handle, { limited: true });
      const u = await lim.user();
      const anon = await lim.h.app.request('/v1/sync/push', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
        body: JSON.stringify({ changes: [await makeWord('chi', T)] }),
      });
      expect(anon.status).toBe(401);
      for (let i = 0; i < 60; i++)
        expect((await u.push([await makeWord(`rl${i}`, T)])).status).toBe(200);
      const over = await u.push([await makeWord('rl-over', T)]);
      expect(over.status).toBe(429);
      expect(over.headers.get('retry-after')).toBeTruthy();
    });
  });

  describe('chat messages (insert-only)', () => {
    it('applies, and treats an identical duplicate as applied with the original seq', async () => {
      await fresh();
      const word = await makeWord('psi', T);
      const id = randomUUID();
      const msg = chatIns(id, word.key, T + 1, { role: 'assistant', content: 'hi', model: 'm1' });
      const r1 = await a.pushOk([word, msg]);
      expect(r1.results[1]).toEqual({ index: 1, status: 'applied', seq: '2' });
      const r2 = await a.pushOk([msg]);
      expect(r2.results[0]).toEqual({ index: 0, status: 'applied', seq: '2' });
      expect((await userRow(tdb.handle, a.userId)).change_seq).toBe('2'); // no new seq
    });

    it('a different payload under the same id is rejected CONFLICT and changes nothing', async () => {
      await fresh();
      const word = await makeWord('omega', T);
      const id = randomUUID();
      await a.pushOk([word, chatIns(id, word.key, T, { content: 'original' })]);
      const r = await a.pushOk([chatIns(id, word.key, T, { content: 'edited' })]);
      expect(r.results[0]).toEqual({ index: 0, status: 'rejected', code: 'CONFLICT' });
      const [m] = await q<{ content: string }>(
        sql`SELECT content FROM word_chat_messages WHERE user_id = ${a.userId}`,
      );
      expect(m?.content).toBe('original');
    });

    it('rejects a message for an unknown or deleted word (NOT_FOUND) and invalid roles', async () => {
      await fresh();
      const ghost = await wordKey('ghost');
      const word = await makeWord('live', T);
      await a.pushOk([word, await wordDel('dead', T)]);
      const r = await a.pushOk([
        chatIns(randomUUID(), ghost, T),
        chatIns(randomUUID(), await wordKey('dead'), T),
        {
          ...chatIns(randomUUID(), word.key, T, { role: 'assistant' }),
          data: { wordKey: word.key, role: 'assistant', content: 'x', createdAt: T },
        },
        chatIns(randomUUID(), word.key, T, { content: 'u'.repeat(2001) }),
      ]);
      expect(r.results).toEqual([
        { index: 0, status: 'rejected', code: 'NOT_FOUND' },
        { index: 1, status: 'rejected', code: 'NOT_FOUND' },
        { index: 2, status: 'rejected', code: 'VALIDATION_FAILED' },
        { index: 3, status: 'rejected', code: 'VALIDATION_FAILED' },
      ]);
    });
  });

  describe('cascades and stubs', () => {
    it('deleting a word hard-deletes its messages', async () => {
      await fresh();
      const word = await makeWord('cascade-word', T);
      await a.pushOk([
        word,
        chatIns(randomUUID(), word.key, T),
        chatIns(randomUUID(), word.key, T + 1),
      ]);
      await a.pushOk([await wordDel('cascade-word', T + 5)]);
      const [n] = await q<{ n: string }>(
        sql`SELECT count(*)::text n FROM word_chat_messages WHERE user_id = ${a.userId}`,
      );
      expect(n?.n).toBe('0');
      const p = await a.pullAll();
      expect(p.changes.filter((c) => c.kind === 'chat')).toHaveLength(0);
    });

    it('deleting a document tombstones each live highlight with its own seq and nulls the content', async () => {
      await fresh();
      const [h1, h2, h3] = [randomUUID(), randomUUID(), randomUUID()];
      await a.pushOk([
        docUp(fp('d'), T, { title: 'Secret title' }),
        hlUp(h1, fp('d'), T),
        hlUp(h2, fp('d'), T),
        hlUp(h3, fp('d'), T),
        hlDel(h3, fp('d'), T + 1),
      ]); // seqs 1..5
      const r = await a.pushOk([docDel(fp('d'), T + 10)]);
      expect(r.results[0]).toEqual({ index: 0, status: 'applied', seq: '8' }); // h1, h2 get 6, 7
      const hs = await q<{ id: string; seq: string; deleted_at: string | null }>(
        sql`SELECT id, seq::text, deleted_at FROM highlights WHERE user_id = ${a.userId} ORDER BY seq`,
      );
      expect(hs.every((h) => h.deleted_at !== null)).toBe(true);
      expect(
        hs
          .filter((h) => Number(h.seq) >= 6)
          .map((h) => h.id)
          .sort(),
      ).toEqual([h1, h2].sort());
      const [d] = await q<Record<string, unknown>>(
        sql`SELECT title, page_count, last_page, page_offset, file_bytes FROM documents WHERE user_id = ${a.userId}`,
      );
      expect(d).toEqual({
        title: null,
        page_count: null,
        last_page: null,
        page_offset: null,
        file_bytes: null,
      });
      const pulled = await a.pullAll('5');
      expect(pulled.changes.map((c) => c.kind)).toEqual(['highlight', 'highlight', 'document']);
      expect(pulled.changes.every((c) => 'deleted' in c && c.deleted)).toBe(true);
    });

    it('deleting a stored document refunds the quota, clears storage and queues the object delete', async () => {
      await fresh();
      await a.pushOk([docUp(fp('e'), T)]);
      await q(sql`UPDATE documents SET storage_state = 'stored', object_key = 'u/x/e.pdf', stored_bytes = 5000, stored_at = now()
                  WHERE user_id = ${a.userId}`);
      await q(sql`UPDATE users SET storage_used_bytes = 5000 WHERE id = ${a.userId}`);
      // Upserting a stored document never touches the server-owned storage fields.
      await a.pushOk([docUp(fp('e'), T + 1, { title: 'renamed' })]);
      const [kept] = await q<{ storage_state: string; stored_bytes: string }>(
        sql`SELECT storage_state, stored_bytes::text FROM documents WHERE user_id = ${a.userId}`,
      );
      expect(kept).toEqual({ storage_state: 'stored', stored_bytes: '5000' });
      await a.pushOk([docDel(fp('e'), T + 2)]);
      const [d] = await q<Record<string, unknown>>(
        sql`SELECT storage_state, object_key, stored_bytes, stored_at FROM documents WHERE user_id = ${a.userId}`,
      );
      expect(d).toEqual({
        storage_state: 'none',
        object_key: null,
        stored_bytes: null,
        stored_at: null,
      });
      expect((await userRow(tdb.handle, a.userId)).storage_used_bytes).toBe('0');
      const jobs = await q<{ object_key: string }>(
        sql`SELECT object_key FROM object_deletions WHERE object_key = 'u/x/e.pdf'`,
      );
      expect(jobs).toHaveLength(1);
    });

    it('a highlight for an unknown document creates a title-less stub that a real upsert fills in', async () => {
      await fresh();
      const id = randomUUID();
      const r = await a.pushOk([hlUp(id, fp('f'), T)]);
      expect(r.results[0]).toEqual({ index: 0, status: 'applied', seq: '2' }); // stub = 1, highlight = 2
      const p = await a.pullAll();
      expect(p.changes[0]).toMatchObject({
        kind: 'document',
        key: fp('f'),
        deleted: false,
        data: { title: null, pageCount: null, lastPage: null, pageOffset: null, fileBytes: null },
        storage: { state: 'none', bytes: null },
      });
      // Any real upsert is newer than the stub, whatever its clock.
      const real = await a.pushOk([docUp(fp('f'), 1_577_836_800_001, { title: 'Real' })]);
      expect(real.results[0]?.status).toBe('applied');
    });

    it('a highlight for a tombstoned document resurrects it as a stub; a stale highlight creates nothing', async () => {
      await fresh();
      const id = randomUUID();
      await a.pushOk([docUp(fp('5'), T, { title: 'Gone' }), docDel(fp('5'), T + 1)]); // doc seq 2
      const r = await a.pushOk([hlUp(id, fp('5'), T + 2)]);
      expect(r.results[0]?.status).toBe('applied');
      const [d] = await q<{ title: string | null; deleted_at: string | null; cma: string }>(
        sql`SELECT title, deleted_at, (extract(epoch FROM client_modified_at) * 1000)::bigint::text cma
            FROM documents WHERE user_id = ${a.userId}`,
      );
      expect(d).toMatchObject({ title: null, deleted_at: null });
      expect(Number(d?.cma)).toBe(T + 1); // still newer-than-the-delete to win
      // An older real upsert than the delete cannot overwrite the stub; a newer one can.
      expect((await a.pushOk([docUp(fp('5'), T, { title: 'Old' })])).results[0]?.status).toBe(
        'stale',
      );
      expect((await a.pushOk([docUp(fp('5'), T + 3, { title: 'New' })])).results[0]?.status).toBe(
        'applied',
      );
      // Stale highlight (older than the stored one): no stub work, no seq.
      const before = (await userRow(tdb.handle, a.userId)).change_seq;
      const again = await a.pushOk([hlUp(id, fp('5'), T + 2)]);
      expect(again.results[0]?.status).toBe('stale');
      expect((await userRow(tdb.handle, a.userId)).change_seq).toBe(before);
    });

    it('highlight rules: stale, resurrect, fingerprint conflict, unknown-document delete', async () => {
      await fresh();
      const id = randomUUID();
      await a.pushOk([docUp(fp('2'), T), hlUp(id, fp('2'), T)]);
      expect(
        (await a.pushOk([hlUp(id, fp('2'), T, { color: 'yellow', end: 9 })])).results[0]?.status,
      ).toBe('stale');
      expect((await a.pushOk([hlDel(id, fp('2'), T + 1)])).results[0]?.status).toBe('applied');
      expect((await a.pushOk([hlUp(id, fp('2'), T + 2)])).results[0]?.status).toBe('applied');
      expect((await a.pushOk([hlUp(id, fp('3'), T + 3)])).results[0]).toMatchObject({
        status: 'rejected',
        code: 'CONFLICT',
      });
      expect((await a.pushOk([hlDel(randomUUID(), fp('4'), T)])).results[0]).toMatchObject({
        status: 'rejected',
        code: 'NOT_FOUND',
      });
      // A delete for an unknown highlight of a known document leaves a tombstone that beats an older upsert.
      const late = randomUUID();
      expect((await a.pushOk([hlDel(late, fp('2'), T + 5)])).results[0]?.status).toBe('applied');
      expect((await a.pushOk([hlUp(late, fp('2'), T + 4)])).results[0]?.status).toBe('stale');
    });
  });

  describe('live-count limits', () => {
    const seed = (table: string, n: number, userId: string, extra = '') =>
      q(
        sql.raw(
          table === 'saved_words'
            ? `INSERT INTO saved_words (user_id, word_key, text, meaning, source_kind, created_at, client_modified_at, seq)
               SELECT '${userId}', md5(g::text) || md5(g::text || 'x'), 'w' || g, '{}'::jsonb, 'webpage', now(), now(), g
               FROM generate_series(1, ${n}) g`
            : table === 'documents'
              ? `INSERT INTO documents (user_id, fingerprint, client_modified_at, seq)
                 SELECT '${userId}', md5(g::text) || md5(g::text || 'x'), now(), g FROM generate_series(1, ${n}) g`
              : `INSERT INTO highlights (user_id, id, fingerprint, page, start_offset, end_offset, color, created_at, client_modified_at, seq)
                 SELECT '${userId}', gen_random_uuid(), '${extra}', 1, 0, 1, 'yellow', now(), now(), g + 1
                 FROM generate_series(1, ${n}) g`,
        ),
      );

    it('maxWords: a new or resurrected word is rejected at the limit, an update is not', async () => {
      await fresh();
      await seed('saved_words', LIMITS.maxWords, a.userId);
      await q(sql`UPDATE users SET change_seq = ${LIMITS.maxWords} WHERE id = ${a.userId}`);
      const existing = await makeWord('w1', T + 10);
      // md5-based keys differ from wordKey('w1'); so use a real update through a freshly inserted known word.
      const r = await a.pushOk([existing]);
      expect(r.results[0]).toEqual({ index: 0, status: 'rejected', code: 'LIMIT_EXCEEDED' });
      // Free a slot by tombstoning one, then the word fits; resurrecting another then does not.
      await q(
        sql`UPDATE saved_words SET deleted_at = now() WHERE user_id = ${a.userId} AND text = 'w2'`,
      );
      expect((await a.pushOk([existing])).results[0]?.status).toBe('applied');
      expect((await a.pushOk([await makeWord('w3', T)])).results[0]?.code).toBe('LIMIT_EXCEEDED');
      // Updating the word that is already live never counts against the limit.
      expect((await a.pushOk([await makeWord('w1', T + 20)])).results[0]?.status).toBe('applied');
    });

    it('maxMessagesPerWord', async () => {
      await fresh();
      const word = await makeWord('chatty', T);
      await a.pushOk([word]);
      await q(
        sql`INSERT INTO word_chat_messages (id, user_id, word_key, role, content, created_at, seq)
            SELECT gen_random_uuid(), ${a.userId}, ${word.key}, 'user', 'm', now(), g + 1 FROM generate_series(1, ${LIMITS.maxMessagesPerWord}) g`,
      );
      const r = await a.pushOk([chatIns(randomUUID(), word.key, T)]);
      expect(r.results[0]).toEqual({ index: 0, status: 'rejected', code: 'LIMIT_EXCEEDED' });
    });

    it('maxDocuments, including the stub a highlight would create', async () => {
      await fresh();
      await seed('documents', LIMITS.maxDocuments, a.userId);
      const r = await a.pushOk([docUp(fp('9'), T), hlUp(randomUUID(), fp('8'), T)]);
      expect(r.results.map((x) => x.code)).toEqual(['LIMIT_EXCEEDED', 'LIMIT_EXCEEDED']);
      expect((await a.pullAll(String(LIMITS.maxDocuments))).changes).toHaveLength(0); // nothing leaked in
    });

    it('maxHighlightsPerDocument', async () => {
      await fresh();
      await a.pushOk([docUp(fp('7'), T)]);
      await seed('highlights', LIMITS.maxHighlightsPerDocument, a.userId, fp('7'));
      const r = await a.pushOk([hlUp(randomUUID(), fp('7'), T)]);
      expect(r.results[0]).toEqual({ index: 0, status: 'rejected', code: 'LIMIT_EXCEEDED' });
    });
  });

  describe('idempotency', () => {
    it('replays the stored response for the same key and body, without applying again', async () => {
      await fresh();
      const key = randomUUID();
      const body = [await makeWord('idem', T), await makeWord('idem2', T)];
      const first = await a.pushOk(body, key);
      const state = await userRow(tdb.handle, a.userId);
      // Change the world in between: the replay still returns the original answer.
      await a.pushOk([await makeWord('idem', T + 100)]);
      const replay = await a.pushOk(body, key);
      expect(replay).toEqual(first);
      expect((await userRow(tdb.handle, a.userId)).change_seq).toBe(
        String(Number(state.change_seq) + 1),
      );
    });

    it('treats key order inside the body as the same body', async () => {
      await fresh();
      const key = randomUUID();
      const word = await makeWord('idem3', T);
      const reordered = JSON.parse(
        JSON.stringify({
          data: word.data,
          key: word.key,
          clientModifiedAt: word.clientModifiedAt,
          op: 'upsert',
          kind: 'word',
        }),
      );
      await a.pushOk([word], key);
      const r = await a.push([reordered], key);
      expect(r.status).toBe(200);
    });

    it('a different body under the same key is 409 IDEMPOTENCY_MISMATCH and applies nothing', async () => {
      await fresh();
      const key = randomUUID();
      await a.pushOk([await makeWord('idem4', T)], key);
      const r = await a.push([await makeWord('idem5', T)], key);
      expect(r.status).toBe(409);
      expect(((await r.json()) as Err).error.code).toBe('IDEMPOTENCY_MISMATCH');
      expect((await a.pullAll()).changes).toHaveLength(1);
    });

    it('keys are scoped per user', async () => {
      await fresh();
      const other = await w.user();
      const key = randomUUID();
      await a.pushOk([await makeWord('idem6', T)], key);
      expect((await other.push([await makeWord('idem7', T)], key)).status).toBe(200);
    });

    it('stores the idempotency record in the same transaction (concurrent duplicates apply once)', async () => {
      await fresh();
      const key = randomUUID();
      const body = [await makeWord('race1', T), await makeWord('race2', T)];
      const rs = await Promise.all(Array.from({ length: 5 }, () => a.push(body, key)));
      expect(rs.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
      const bodies = await Promise.all(rs.map((r) => r.json()));
      for (const b of bodies) expect(b).toEqual(bodies[0]);
      expect((await userRow(tdb.handle, a.userId)).change_seq).toBe('2');
    });
  });

  describe('internal errors roll everything back', () => {
    it('returns 500, keeps no partial writes, no seq and no idempotency record; a retry then succeeds', async () => {
      await fresh();
      await q(sql`CREATE OR REPLACE FUNCTION fail_boom() RETURNS trigger AS $$
        BEGIN IF NEW.text = 'boom' THEN RAISE EXCEPTION 'injected failure'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`);
      await q(sql`DROP TRIGGER IF EXISTS boom ON saved_words`);
      await q(
        sql`CREATE TRIGGER boom BEFORE INSERT ON saved_words FOR EACH ROW EXECUTE FUNCTION fail_boom()`,
      );
      try {
        const key = randomUUID();
        const body = [
          await makeWord('before-boom', T),
          await makeWord('boom', T),
          await makeWord('after-boom', T),
        ];
        const res = await a.push(body, key);
        expect(res.status).toBe(500);
        expect(((await res.json()) as Err).error.code).toBe('INTERNAL');
        expect((await userRow(tdb.handle, a.userId)).change_seq).toBe('0');
        expect(await q(sql`SELECT 1 FROM saved_words WHERE user_id = ${a.userId}`)).toHaveLength(0);
        expect(
          await q(sql`SELECT 1 FROM idempotency_keys WHERE user_id = ${a.userId}`),
        ).toHaveLength(0);
        await q(sql`DROP TRIGGER boom ON saved_words`);
        const retry = await a.pushOk(body, key);
        expect(retry.results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
        expect(retry.results.map((r) => r.seq)).toEqual(['1', '2', '3']);
      } finally {
        await q(sql`DROP TRIGGER IF EXISTS boom ON saved_words`);
      }
    });
  });

  describe('isolation between users (IDOR)', () => {
    it("a user's push can only create or touch that user's rows", async () => {
      const [alice, bob] = [await w.user(), await w.user()];
      const word = await makeWord('shared-word', T, { meaning: meaning({ title: 'alice' }) });
      const id = randomUUID();
      const msgId = randomUUID();
      await alice.pushOk([
        word,
        chatIns(msgId, word.key, T, { content: 'private' }),
        docUp(fp('a'), T, { title: 'Alice doc' }),
        hlUp(id, fp('a'), T),
      ]);
      // Bob targets Alice's identifiers.
      const r = await bob.pushOk([
        await wordDel('shared-word', T + 100),
        chatIns(randomUUID(), word.key, T), // Alice's word is not Bob's word
        chatIns(msgId, word.key, T, { content: 'hijack' }), // Alice's message id
        docDel(fp('a'), T + 100),
        hlDel(id, fp('a'), T + 100),
        hlUp(id, fp('a'), T + 101, { end: 99 }),
      ]);
      expect(r.results.map((x) => x.status + (x.code ? `/${x.code}` : ''))).toEqual([
        'applied', // Bob's own tombstone for his own (unknown) key
        'rejected/NOT_FOUND',
        'rejected/NOT_FOUND', // same: no word under Bob's account
        'applied', // Bob's own doc tombstone
        'applied', // his own highlight tombstone (document exists as Bob's tombstone)
        'applied', // his own highlight upsert resurrecting his own stub
      ]);
      const aliceState = await alice.pullAll();
      expect(aliceState.changes).toHaveLength(4);
      expect(aliceState.changes.every((c) => !('deleted' in c) || !c.deleted)).toBe(true);
      const [m] = await q<{ content: string }>(
        sql`SELECT content FROM word_chat_messages WHERE user_id = ${alice.userId}`,
      );
      expect(m?.content).toBe('private');
      // Bob's pull contains none of Alice's content.
      const bobText = JSON.stringify(await bob.pullAll());
      expect(bobText).not.toContain('Alice doc');
      expect(bobText).not.toContain('private');
    });
  });
});

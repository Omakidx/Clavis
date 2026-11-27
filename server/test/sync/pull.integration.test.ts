import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import { bearer } from '../auth/harness';
import {
  chatIns,
  docUp,
  fp,
  hlUp,
  makeWord,
  makeWorld,
  rows,
  userRow,
  type World,
} from './helpers';

// Integration files run in parallel against one Postgres; give slow cases headroom.
vi.setConfig({ testTimeout: 30_000 });

type Err = { error: { code: string } };

describe.skipIf(!adminUrl)('GET /v1/sync/pull (real Postgres)', () => {
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

  /** Seeds one record of each kind, in a known seq order: word 1, chat 2, doc 3, highlight 4, word 5. */
  async function seeded() {
    const a = await w.user();
    const word = await makeWord('pull-a', T);
    await a.pushOk([
      word,
      chatIns(randomUUID(), word.key, T),
      docUp(fp('a'), T),
      hlUp(randomUUID(), fp('a'), T),
      await makeWord('pull-b', T),
    ]);
    return a;
  }

  it('returns the union of the four tables ordered by seq, with nextCursor and hasMore', async () => {
    const a = await seeded();
    const p = await a.pullOk();
    expect(p.changes.map((c) => [c.kind, c.seq])).toEqual([
      ['word', '1'],
      ['chat', '2'],
      ['document', '3'],
      ['highlight', '4'],
      ['word', '5'],
    ]);
    expect(p.nextCursor).toBe('5');
    expect(p.hasMore).toBe(false);
  });

  it('pages by limit and resumes from nextCursor without loss or repeats', async () => {
    const a = await seeded();
    const p1 = await a.pullOk('0', 2);
    expect(p1.changes.map((c) => c.seq)).toEqual(['1', '2']);
    expect(p1).toMatchObject({ nextCursor: '2', hasMore: true });
    const p2 = await a.pullOk(p1.nextCursor, 2);
    expect(p2.changes.map((c) => c.seq)).toEqual(['3', '4']);
    expect(p2.hasMore).toBe(true);
    const p3 = await a.pullOk(p2.nextCursor, 2);
    expect(p3.changes.map((c) => c.seq)).toEqual(['5']);
    expect(p3).toMatchObject({ nextCursor: '5', hasMore: false });
    // Exactly `limit` rows left is not "more".
    const exact = await a.pullOk('3', 2);
    expect(exact).toMatchObject({ nextCursor: '5', hasMore: false });
  });

  it('an empty pull keeps the cursor; a cursor past the end is empty', async () => {
    const a = await w.user();
    expect(await a.pullOk()).toEqual({ changes: [], nextCursor: '0', hasMore: false });
    await a.pushOk([await makeWord('only', T)]);
    expect(await a.pullOk('1')).toEqual({ changes: [], nextCursor: '1', hasMore: false });
    expect(await a.pullOk('99')).toEqual({ changes: [], nextCursor: '99', hasMore: false });
  });

  it('defaults to 500 and validates cursor and limit', async () => {
    const a = await w.user();
    const code = async (r: Response) => ((await r.json()) as Err).error.code;
    for (const qs of [
      'limit=0',
      'limit=1001',
      'limit=x',
      'cursor=-1',
      'cursor=abc',
      'cursor=9223372036854775808',
      'nope=1',
    ]) {
      const r = await w.h.app.request(`/v1/sync/pull?${qs}`, { headers: bearer(a.pair) });
      expect([r.status, await code(r)], qs).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(
      (await w.h.app.request('/v1/sync/pull?limit=1000', { headers: bearer(a.pair) })).status,
    ).toBe(200);
    expect(
      (await w.h.app.request('/v1/sync/pull', { headers: bearer(a.pair) })).headers.get(
        'cache-control',
      ),
    ).toBe('no-store');
  });

  it('410 CURSOR_EXPIRED only when 0 < cursor < tombstone_floor_seq', async () => {
    const a = await seeded();
    await rows(tdb.handle, sql`UPDATE users SET tombstone_floor_seq = 4 WHERE id = ${a.userId}`);
    const expired = await a.pull('3');
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as Err).error.code).toBe('CURSOR_EXPIRED');
    expect((await a.pull('4')).status).toBe(200); // cursor == floor: nothing newer was purged
    expect((await a.pull('5')).status).toBe(200);
    const fromStart = await a.pullOk('0'); // a full resync is always allowed
    expect(fromStart.changes).toHaveLength(5);
  });

  it('is Bearer only and scoped to the caller', async () => {
    const a = await seeded();
    const b = await w.user();
    expect((await w.h.app.request('/v1/sync/pull')).status).toBe(401);
    expect(
      (await w.h.app.request('/v1/sync/pull', { headers: { authorization: 'Bearer nope' } }))
        .status,
    ).toBe(401);
    expect(await b.pullOk()).toEqual({ changes: [], nextCursor: '0', hasMore: false });
    expect((await a.pullOk()).changes).toHaveLength(5);
  });

  it('is rate limited at 120/min/user', async () => {
    const lim = await makeWorld(tdb.handle, { limited: true });
    const u = await lim.user();
    for (let i = 0; i < 120; i++) expect((await u.pull()).status).toBe(200);
    const over = await u.pull();
    expect(over.status).toBe(429);
  });

  describe('serialization of concurrent pushes for one user', () => {
    it('allocates strictly increasing, gap-free seqs and a pull never sees a hole', async () => {
      const a = await w.user();
      const PUSHES = 20;
      const PER = 4;
      let pushesDone = false;
      const pushes = Promise.all(
        Array.from({ length: PUSHES }, async (_, i) => {
          const changes = await Promise.all(
            Array.from({ length: PER }, (_, j) => makeWord(`conc-${i}-${j}`, T + i * PER + j)),
          );
          return a.pushOk(changes);
        }),
      ).finally(() => {
        pushesDone = true;
      });

      // A client pulling continuously while the pushes commit: after every page the seqs it holds must be exactly 1..cursor.
      const seen = new Set<number>();
      let cursor = '0';
      for (;;) {
        const finished = pushesDone;
        const p = await a.pullOk(cursor, 7);
        const seqs = p.changes.map((c) => Number(c.seq));
        expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
        for (const s of seqs) {
          expect(seen.has(s)).toBe(false);
          seen.add(s);
        }
        cursor = p.nextCursor;
        expect(seen.size).toBe(Number(cursor));
        expect(Math.max(0, ...seen)).toBe(Number(cursor));
        if (finished && !p.hasMore) break;
      }
      const responses = await pushes;
      const all = responses
        .flatMap((r) => r.results.map((x) => Number(x.seq)))
        .sort((x, y) => x - y);
      expect(all).toEqual(Array.from({ length: PUSHES * PER }, (_, i) => i + 1));
      expect(cursor).toBe(String(PUSHES * PER));
      expect((await userRow(tdb.handle, a.userId)).change_seq).toBe(String(PUSHES * PER));
    });

    it('a REST delete racing pushes also takes the next seq under the same lock', async () => {
      const a = await w.user();
      const word = await makeWord('race-del', T);
      await a.pushOk([word]);
      const del = a.req('DELETE', `/v1/words/${word.key}`);
      const pushes = Promise.all(
        Array.from({ length: 5 }, async (_, i) => a.pushOk([await makeWord(`race-${i}`, T)])),
      );
      const [d] = await Promise.all([del, pushes]);
      expect(d.status).toBe(204);
      const all = await a.pullAll();
      const seqs = all.changes.map((c) => Number(c.seq)).sort((x, y) => x - y);
      expect(seqs).toEqual([2, 3, 4, 5, 6, 7]);
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(Math.max(...seqs)).toBe(Number((await userRow(tdb.handle, a.userId)).change_seq));
    });
  });
});

// Two simulated clients (the §4.1/§4.6 client rules) make random edits and push/pull in random interleavings
// against the real API and database. After a final quiescent sync both clients, a fresh third device and the
// database itself must agree.
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  wordKey,
  type ChatData,
  type DocumentData,
  type HighlightData,
  type PushChange,
  type PushResult,
  type ServerChange,
  type WordData,
} from '../../../shared/api-contract';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import { Api, fp, makeWorld, rows, type World } from './helpers';

// Integration files run in parallel against one Postgres; give slow cases headroom.
vi.setConfig({ testTimeout: 30_000 });

/** mulberry32: deterministic, so a failing seed can be replayed. */
function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T,
    chance: (p: number) => next() < p,
  };
}
type Rng = ReturnType<typeof prng>;

interface Rec<D> {
  cma: number;
  dirty: boolean;
  deleted: boolean;
  data: D | null;
}
interface HRec extends Rec<HighlightData> {
  fp: string;
}
interface MRec {
  data: ChatData;
  dirty: boolean;
}

// Words that carry chat are never deleted: a delete hard-deletes messages without telling clients that already hold
// them once the word is re-saved (design risk, covered separately by targeted tests).
const PLAIN_WORDS = ['alpha', 'bravo', 'charlie', 'delta'] as const;
const CHAT_WORDS = ['echo', 'foxtrot'] as const;
const FPS = [fp('a'), fp('b'), fp('c')] as const;

class Clock {
  tick = 0;
  /** Coarse on purpose: equal clientModifiedAt values across devices must converge too. */
  now(r: Rng, base: number) {
    if (r.chance(0.7)) this.tick += 1;
    return base + this.tick * 5;
  }
}

class Sim {
  words = new Map<string, Rec<WordData>>();
  msgs = new Map<string, MRec>();
  docs = new Map<string, Rec<DocumentData>>();
  hls = new Map<string, HRec>();
  cursor = '0';
  rev = 0;
  constructor(
    readonly api: Api,
    readonly r: Rng,
    readonly clock: Clock,
    readonly base: number,
    readonly name: string,
  ) {}
  private ts() {
    return this.clock.now(this.r, this.base);
  }

  // ---- local edits
  async edit() {
    const r = this.r;
    const op = r.int(10);
    if (op <= 1) return this.saveWord(r.pick([...PLAIN_WORDS, ...CHAT_WORDS]));
    if (op === 2) return this.deleteWord(r.pick(PLAIN_WORDS));
    if (op === 3) return this.addChat();
    if (op === 4) return this.editDoc();
    if (op === 5) return this.deleteDoc();
    if (op <= 7) return this.addHighlight();
    if (op === 8) return this.editHighlight();
    return this.deleteHighlight();
  }
  private async saveWord(text: string) {
    const key = await wordKey(text);
    const prev = this.words.get(key)?.data;
    const cma = this.ts();
    this.words.set(key, {
      cma,
      dirty: true,
      deleted: false,
      data: {
        text,
        meaning: { title: `${this.name}-${++this.rev}`, summary: 's', model: 'm' },
        source: { kind: 'webpage', url: 'https://example.test/x', title: null },
        createdAt: prev?.createdAt ?? cma,
      },
    });
  }
  private async deleteWord(text: string) {
    const key = await wordKey(text);
    const w = this.words.get(key);
    if (!w || w.deleted) return;
    this.words.set(key, { cma: this.ts(), dirty: true, deleted: true, data: null });
  }
  private async addChat() {
    const text = this.r.pick(CHAT_WORDS);
    const key = await wordKey(text);
    const w = this.words.get(key);
    if (!w || w.deleted) return;
    const id = randomUUID();
    const role = this.r.pick(['user', 'assistant'] as const);
    this.msgs.set(id, {
      dirty: true,
      data: {
        wordKey: key,
        role,
        content: `m${++this.rev}`,
        ...(role === 'assistant' ? { model: 'm' } : {}),
        createdAt: this.ts(),
      },
    });
  }
  private editDoc() {
    const f = this.r.pick(FPS);
    const prev = this.docs.get(f);
    if (prev?.deleted && this.r.chance(0.5)) return; // sometimes leave a delete alone
    this.docs.set(f, {
      cma: this.ts(),
      dirty: true,
      deleted: false,
      data: {
        title: this.r.chance(0.8) ? `${this.name}-doc${++this.rev}` : null,
        pageCount: 50,
        lastPage: 1 + this.r.int(50),
        pageOffset: this.r.pick([0, 0.25, 0.5, 1]),
        fileBytes: 1000,
      },
    });
  }
  private deleteDoc() {
    const f = this.r.pick(FPS);
    const d = this.docs.get(f);
    if (!d || d.deleted) return;
    const cma = this.ts();
    this.docs.set(f, { cma, dirty: true, deleted: true, data: null });
    // The highlights become local tombstones too (not silently dropped): if the server then answers `stale` for the
    // document delete (another device edited it later), these pushed deletes are what keep the server in step.
    for (const [id, h] of this.hls) {
      if (h.fp === f && !h.deleted)
        this.hls.set(id, { ...h, cma, dirty: true, deleted: true, data: null });
    }
  }
  private addHighlight() {
    const live = FPS.filter((f) => this.docs.get(f) && !this.docs.get(f)?.deleted);
    if (live.length === 0) return;
    const f = this.r.pick(live);
    const start = this.r.int(100);
    const cma = this.ts();
    this.hls.set(randomUUID(), {
      fp: f,
      cma,
      dirty: true,
      deleted: false,
      data: {
        fingerprint: f,
        page: 1 + this.r.int(5),
        start,
        end: start + 1 + this.r.int(20),
        color: this.r.pick(['yellow', 'green', 'blue', 'pink'] as const),
        createdAt: cma,
      },
    });
  }
  private liveHighlights() {
    return [...this.hls].filter(([, h]) => !h.deleted);
  }
  private editHighlight() {
    const live = this.liveHighlights();
    if (live.length === 0) return;
    const [id, h] = this.r.pick(live);
    this.hls.set(id, {
      ...h,
      cma: this.ts(),
      dirty: true,
      data: {
        ...(h.data as HighlightData),
        color: this.r.pick(['yellow', 'green', 'blue', 'pink'] as const),
      },
    });
  }
  private deleteHighlight() {
    const live = this.liveHighlights();
    if (live.length === 0) return;
    const [id, h] = this.r.pick(live);
    this.hls.set(id, { ...h, cma: this.ts(), dirty: true, deleted: true, data: null });
  }

  // ---- sync
  private dirtyChanges(): {
    change: PushChange;
    done: (res: PushResult) => void;
  }[] {
    const out: {
      change: PushChange;
      done: (res: PushResult) => void;
    }[] = [];
    const settle = (clean: () => void, drop: () => void) => (res: PushResult) => {
      if (res.status === 'applied') clean();
      else if (res.status === 'stale' && res.current) {
        this.applyServer(res.current, true);
      } else if (
        res.status === 'rejected' &&
        (res.code === 'NOT_FOUND' || res.code === 'LIMIT_EXCEEDED')
      )
        drop();
      else throw new Error(`${this.name}: unexpected push result ${JSON.stringify(res)}`);
    };
    for (const [key, w] of this.words) {
      if (!w.dirty) continue;
      out.push({
        change: w.deleted
          ? { kind: 'word', op: 'delete', key, clientModifiedAt: w.cma }
          : { kind: 'word', op: 'upsert', key, clientModifiedAt: w.cma, data: w.data as WordData },
        done: settle(
          () => (w.dirty = false),
          () => this.words.delete(key),
        ),
      });
    }
    for (const [id, m] of this.msgs) {
      if (!m.dirty) continue;
      out.push({
        change: { kind: 'chat', op: 'insert', id, data: m.data },
        done: settle(
          () => (m.dirty = false),
          () => this.msgs.delete(id),
        ),
      });
    }
    for (const [key, d] of this.docs) {
      if (!d.dirty) continue;
      out.push({
        change: d.deleted
          ? { kind: 'document', op: 'delete', key, clientModifiedAt: d.cma }
          : {
              kind: 'document',
              op: 'upsert',
              key,
              clientModifiedAt: d.cma,
              data: d.data as DocumentData,
            },
        done: settle(
          () => (d.dirty = false),
          () => this.docs.delete(key),
        ),
      });
    }
    for (const [id, h] of this.hls) {
      if (!h.dirty) continue;
      out.push({
        change: h.deleted
          ? { kind: 'highlight', op: 'delete', id, fingerprint: h.fp, clientModifiedAt: h.cma }
          : {
              kind: 'highlight',
              op: 'upsert',
              id,
              clientModifiedAt: h.cma,
              data: h.data as HighlightData,
            },
        done: settle(
          () => (h.dirty = false),
          () => this.hls.delete(id),
        ),
      });
    }
    return out;
  }

  async push(maxBatch: number) {
    const dirty = this.dirtyChanges();
    // Shuffle order a little: the server must not depend on the client's batching.
    if (this.r.chance(0.5)) dirty.reverse();
    for (let i = 0; i < dirty.length; i += maxBatch) {
      const batch = dirty.slice(i, i + maxBatch);
      const res = await this.api.pushOk(batch.map((b) => b.change));
      // Replaying the same key + body must return the same answer (a client retry after a lost response).
      expect(res.results).toHaveLength(batch.length);
      for (const r of res.results) batch[r.index]?.done(r);
    }
  }

  applyServer(c: ServerChange, fromStale = false) {
    const newerLocal = (rec: { dirty: boolean; cma: number } | undefined, serverCma: number) =>
      rec !== undefined && rec.dirty && rec.cma > serverCma && !fromStale;
    switch (c.kind) {
      case 'word': {
        if (newerLocal(this.words.get(c.key), c.clientModifiedAt)) return;
        if (c.deleted) {
          this.words.delete(c.key);
          for (const [id, m] of this.msgs) if (m.data.wordKey === c.key) this.msgs.delete(id);
        } else {
          this.words.set(c.key, {
            cma: c.clientModifiedAt,
            dirty: false,
            deleted: false,
            data: c.data,
          });
        }
        return;
      }
      case 'chat':
        this.msgs.set(c.id, { data: c.data, dirty: false });
        return;
      case 'document': {
        if (newerLocal(this.docs.get(c.key), c.clientModifiedAt)) return;
        if (c.deleted) {
          this.docs.delete(c.key);
          for (const [id, h] of this.hls) if (h.fp === c.key) this.hls.delete(id);
        } else {
          this.docs.set(c.key, {
            cma: c.clientModifiedAt,
            dirty: false,
            deleted: false,
            data: c.data,
          });
        }
        return;
      }
      case 'highlight': {
        if (newerLocal(this.hls.get(c.id), c.clientModifiedAt)) return;
        if (c.deleted) this.hls.delete(c.id);
        else
          this.hls.set(c.id, {
            fp: c.fingerprint,
            cma: c.clientModifiedAt,
            dirty: false,
            deleted: false,
            data: c.data,
          });
      }
    }
  }

  /** One pull page (or all pages). */
  async pull(all: boolean, limit: number) {
    for (;;) {
      const p = await this.api.pullOk(this.cursor, limit);
      for (const c of p.changes) this.applyServer(c);
      this.cursor = p.nextCursor;
      if (!all || !p.hasMore) return;
    }
  }

  isClean() {
    return (
      [...this.words.values()].every((x) => !x.dirty) &&
      [...this.msgs.values()].every((x) => !x.dirty) &&
      [...this.docs.values()].every((x) => !x.dirty) &&
      [...this.hls.values()].every((x) => !x.dirty)
    );
  }

  /** Visible state, normalised for comparison. */
  view() {
    const live = <D>(m: Map<string, Rec<D>>) =>
      Object.fromEntries(
        [...m].filter(([, v]) => !v.deleted).map(([k, v]) => [k, v.data]),
      ) as Record<string, D>;
    const sort = <T extends Record<string, unknown>>(o: T) =>
      Object.fromEntries(Object.entries(o).sort(([x], [y]) => (x < y ? -1 : 1)));
    return JSON.stringify({
      words: sort(live(this.words)),
      msgs: sort(Object.fromEntries([...this.msgs].map(([k, v]) => [k, v.data]))),
      docs: sort(live(this.docs)),
      hls: sort(live(this.hls)),
    });
  }
}

describe.skipIf(!adminUrl)('two-client convergence (real Postgres)', () => {
  let tdb: TestDb;
  let w: World;

  beforeAll(async () => {
    tdb = await createTestDb(25);
    w = await makeWorld(tdb.handle);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  async function run(seed: number, steps: number) {
    const r = prng(seed);
    const clock = new Clock();
    const base = w.h.clock.now() - 100_000;
    const a = await w.user();
    const b = await w.device(a);
    const sims = [new Sim(a, r, clock, base, 'A'), new Sim(b, r, clock, base, 'B')] as const;

    for (let i = 0; i < steps; i++) {
      const s = r.pick(sims);
      const op = r.int(10);
      if (op <= 4) await s.edit();
      else if (op <= 6) await s.push(r.pick([1, 3, 200]));
      else if (op === 7) await s.pull(false, r.pick([1, 2, 5, 500]));
      else if (op === 8) await s.pull(true, r.pick([1, 3, 500]));
      else {
        await s.push(r.pick([2, 200]));
        await s.pull(true, 500);
      }
    }

    // Quiesce: sync both until nothing is dirty and a full round changes nothing.
    for (let round = 0; round < 6; round++) {
      for (const s of sims) {
        await s.push(200);
        await s.pull(true, 500);
      }
      if (sims.every((s) => s.isClean())) {
        const before = sims.map((s) => s.view());
        for (const s of sims) await s.pull(true, 500);
        if (sims.every((s, i) => s.view() === before[i])) break;
      }
    }
    expect(
      sims.every((s) => s.isClean()),
      `seed ${seed}: dirty records remain`,
    ).toBe(true);

    // A fresh device's full pull is the server's truth as clients see it.
    const c = await w.device(a);
    const fresh = new Sim(c, r, clock, base, 'C');
    await fresh.pull(true, 500);

    const [va, vb, vc] = [sims[0].view(), sims[1].view(), fresh.view()];
    expect(vb, `seed ${seed}: A and B diverged`).toBe(va);
    expect(vc, `seed ${seed}: fresh device differs from A`).toBe(va);

    // And against the database directly (live row identities).
    const live = async (table: string, col: string) =>
      (
        await rows<Record<string, string>>(
          tdb.handle,
          sql.raw(
            `SELECT ${col} AS k FROM ${table} WHERE user_id = '${a.userId}' AND deleted_at IS NULL ORDER BY 1`,
          ),
        )
      ).map((x) => x.k);
    const parsed = JSON.parse(va) as { words: object; docs: object; hls: object; msgs: object };
    expect(await live('saved_words', 'word_key')).toEqual(Object.keys(parsed.words).sort());
    expect(await live('documents', 'fingerprint')).toEqual(Object.keys(parsed.docs).sort());
    expect(await live('highlights', 'id::text')).toEqual(Object.keys(parsed.hls).sort());
    const dbMsgs = (
      await rows<{ k: string }>(
        tdb.handle,
        sql`SELECT id::text k FROM word_chat_messages WHERE user_id = ${a.userId} ORDER BY 1`,
      )
    ).map((x) => x.k);
    expect(dbMsgs).toEqual(Object.keys(parsed.msgs).sort());
    // Seqs are unique and gap-free per user.
    const seqs = await rows<{ n: string; mx: string; cs: string }>(
      tdb.handle,
      sql`SELECT count(*)::text n, max(seq)::text mx, (SELECT change_seq::text FROM users WHERE id = ${a.userId}) cs
          FROM (SELECT seq FROM saved_words WHERE user_id = ${a.userId} UNION ALL SELECT seq FROM word_chat_messages WHERE user_id = ${a.userId}
                UNION ALL SELECT seq FROM documents WHERE user_id = ${a.userId} UNION ALL SELECT seq FROM highlights WHERE user_id = ${a.userId}) s`,
    );
    expect(Number(seqs[0]?.n)).toBeLessThanOrEqual(Number(seqs[0]?.cs));
    expect(seqs[0]?.mx).toBe(seqs[0]?.cs);
    return parsed;
  }

  // CONVERGENCE_SEEDS=200 widens the search locally; a failing seed is replayable.
  const SEED_COUNT = Number(process.env['CONVERGENCE_SEEDS'] ?? 16);
  it.each(Array.from({ length: SEED_COUNT }, (_, i) => i + 1))(
    'seed %i converges',
    async (seed) => {
      await run(seed, 70);
    },
    60_000,
  );

  it('actually exercises content (the random runs are not vacuous)', async () => {
    let totals = { words: 0, docs: 0, hls: 0, msgs: 0 };
    for (const seed of [101, 102, 103]) {
      const p = await run(seed, 90);
      totals = {
        words: totals.words + Object.keys(p.words).length,
        docs: totals.docs + Object.keys(p.docs).length,
        hls: totals.hls + Object.keys(p.hls).length,
        msgs: totals.msgs + Object.keys(p.msgs).length,
      };
    }
    expect(totals.words).toBeGreaterThan(0);
    expect(totals.docs).toBeGreaterThan(0);
    expect(totals.hls).toBeGreaterThan(0);
    expect(totals.msgs).toBeGreaterThan(0);
  }, 120_000);
});

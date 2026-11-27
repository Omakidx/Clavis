import { describe, expect, it } from 'vitest';
import { FakeServer } from './fake-server';
import { FP, createClient, createClock, visible, type Client } from './client';

// Two devices (separate IndexedDB factories, storage and engines) against an in-memory server that
// implements last-writer-wins on clientModifiedAt (design 4.4). After any sequence of offline edits
// and syncs, running sync on both until quiet must leave both with the same data as the server.

function rng(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const WORDS = ['alpha', 'bravo', 'charlie', 'delta'];
const FPS = [FP, 'e'.repeat(64)];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function settle(clients: Client[]): Promise<void> {
  for (let round = 0; round < 3; round += 1) for (const c of clients) await c.sync();
}

function serverView(server: FakeServer) {
  const user = [...server.users.values()][0]!;
  return {
    words: [...user.words]
      .filter(([, w]) => !w.deleted)
      .map(([k]) => k)
      .sort(),
    chat: [...user.chat.keys()].sort(),
    documents: [...user.documents]
      .filter(([, d]) => !d.deleted)
      .map(([k, d]) => `${k}:${(d.data as { lastPage: number | null }).lastPage}`)
      .sort(),
    highlights: [...user.highlights]
      .filter(([, h]) => !h.deleted)
      .map(([k]) => k)
      .sort(),
  };
}

describe('two clients converge through last-writer-wins', () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`random interleaving, seed ${seed}`, async () => {
      const clock = createClock();
      const server = new FakeServer({ now: clock.now });
      const a = createClient(server, { clock });
      const b = createClient(server, { clock });
      await a.signIn();
      await b.signIn();
      const clients = [a, b];
      const random = rng(seed);
      const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
      let n = 0;
      for (let step = 0; step < 60; step += 1) {
        clock.advance(1_000);
        const c = pick(clients);
        const key = (await import('./fake-server')).wordKey;
        switch (
          pick(['save', 'save', 'delete', 'chat', 'progress', 'highlight', 'rmdoc', 'sync', 'sync'])
        ) {
          case 'save':
            await c.saveWord(pick(WORDS), {
              meaning: { title: 't', summary: `v${step}`, model: 'm' },
            });
            break;
          case 'delete':
            await c.removeWord(await key(pick(WORDS)));
            break;
          case 'chat':
            n += 1;
            await c.chat(await key(pick(WORDS)), uuid(n * 2)).catch(() => undefined);
            break;
          case 'progress':
            await c.progress(pick(FPS), 1 + Math.floor(random() * 9));
            break;
          case 'highlight':
            n += 1;
            await c.highlight(pick(FPS), uuid(1000 + n)).catch(() => undefined);
            break;
          case 'rmdoc':
            await c.removeDocument(pick(FPS));
            break;
          default:
            await c.sync();
        }
      }
      await settle(clients);
      const [da, db] = [visible(await a.dump()), visible(await b.dump())];
      const sv = serverView(server);
      expect(da.words).toEqual(sv.words);
      expect(db.words).toEqual(sv.words);
      expect(da.documents).toEqual(sv.documents);
      expect(db.documents).toEqual(sv.documents);
      expect(da.highlights).toEqual(sv.highlights);
      expect(db.highlights).toEqual(sv.highlights);
      expect(da.chat).toEqual(sv.chat);
      expect(db.chat).toEqual(sv.chat);
      // Nothing is left waiting.
      for (const c of clients) {
        const dump = await c.dump();
        expect(
          [...dump.words, ...dump.chat, ...dump.documents, ...dump.highlights].filter(
            (r) => r['dirty'] === 1,
          ),
        ).toEqual([]);
      }
    });
  }

  it('the same word saved offline on two devices converges on the newest meaning', async () => {
    const clock = createClock();
    const server = new FakeServer({ now: clock.now });
    const a = createClient(server, { clock });
    const b = createClient(server, { clock });
    await a.signIn();
    await b.signIn();
    const key = await a.saveWord('bank', {
      meaning: { title: 'bank', summary: 'from A', model: 'm' },
    });
    clock.advance(5_000);
    await b.saveWord('bank', { meaning: { title: 'bank', summary: 'from B', model: 'm' } });
    await settle([a, b, a]);
    for (const c of [a, b]) {
      const word = (await c.dump()).words.find((w) => w['wordKey'] === key)!;
      expect((word['meaning'] as { summary: string }).summary).toBe('from B');
    }
  });

  it('a word the server refuses with LIMIT_EXCEEDED stays on its device only and never disturbs the others', async () => {
    const clock = createClock();
    const server = new FakeServer({ now: clock.now, maxWords: 2 });
    const a = createClient(server, { clock });
    const b = createClient(server, { clock });
    await a.signIn();
    await b.signIn();
    const k1 = await a.saveWord('alpha');
    const k2 = await a.saveWord('bravo');
    clock.advance(1_000);
    const k3 = await b.saveWord('charlie'); // B's third word overall is refused once A's two are in
    await settle([a, b, a, b]);
    const onServer = serverView(server).words;
    expect(onServer).toHaveLength(2);
    const dumpB = visible(await b.dump());
    // B holds the two synced words plus its own refused one; A never sees the refused one.
    expect(dumpB.words).toEqual([...onServer, ...(onServer.includes(k3) ? [] : [k3])].sort());
    expect(visible(await a.dump()).words).toEqual(onServer);
    expect([k1, k2, k3]).toHaveLength(3);
    const refused = (await b.dump()).words.filter((w) => w['dirty'] === 0 && w['seq'] === null);
    expect(refused.length).toBe(onServer.includes(k3) ? 0 : 1);
  });
});

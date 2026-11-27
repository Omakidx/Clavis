import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bearer } from '../auth/harness';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import { chatIns, docUp, hlUp, makeWord, makeWorld, type World } from '../sync/helpers';
import { FakeStorage, makePdf } from '../storage/support';

vi.setConfig({ testTimeout: 30_000 });

// Regression: correlated count subqueries must be scoped to the row's own user, never across users.
describe.skipIf(!adminUrl)('per-row counts never leak across users (real Postgres)', () => {
  let tdb: TestDb;
  let w: World;
  beforeAll(async () => {
    tdb = await createTestDb(10);
    w = await makeWorld(tdb.handle, { storage: new FakeStorage() });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it('highlightCount counts only the caller own highlights on a shared fingerprint', async () => {
    const a = await w.user();
    const b = await w.user();
    const T = w.h.clock.now();
    const { bytes, fp } = makePdf(3000, 'shared');
    await a.pushOk([
      docUp(fp, T),
      ...[1, 2, 3, 4, 5].map((i) => hlUp(randomUUID(), fp, T + i, { start: i, end: i + 3 })),
    ]);
    await b.pushOk([docUp(fp, T), hlUp(randomUUID(), fp, T + 1)]);

    const list = (await (await b.req('GET', '/v1/documents')).json()) as {
      items: { fingerprint: string; highlightCount: number }[];
    };
    expect(list.items.find((d) => d.fingerprint === fp)?.highlightCount).toBe(1);
    const alist = (await (await a.req('GET', '/v1/documents')).json()) as typeof list;
    expect(alist.items.find((d) => d.fingerprint === fp)?.highlightCount).toBe(5);

    const detail = (await (await b.req('GET', `/v1/documents/${fp}`)).json()) as {
      document: { highlightCount: number };
      highlights: unknown[];
    };
    expect(detail.document.highlightCount).toBe(1);
    expect(detail.highlights).toHaveLength(1);

    // The upload response uses the same view.
    const up = await w.h.app.request(`/v1/documents/${fp}/file`, {
      method: 'PUT',
      headers: {
        ...bearer(b.pair),
        'content-type': 'application/pdf',
        'content-length': String(bytes.length),
      },
      body: new Uint8Array(bytes),
    });
    expect(up.status).toBe(200);
    expect(
      ((await up.json()) as { document: { highlightCount: number } }).document.highlightCount,
    ).toBe(1);
  });

  it('messageCount counts only the caller own messages on a shared word key', async () => {
    const a = await w.user();
    const b = await w.user();
    const T = w.h.clock.now();
    const word = await makeWord('shared-word', T);
    await a.pushOk([word, ...[0, 1, 2, 3].map((i) => chatIns(randomUUID(), word.key, T + i))]);
    await b.pushOk([word, chatIns(randomUUID(), word.key, T)]);

    const list = (await (await b.req('GET', '/v1/words')).json()) as {
      items: { key: string; messageCount: number }[];
    };
    expect(list.items.find((i) => i.key === word.key)?.messageCount).toBe(1);
    const alist = (await (await a.req('GET', '/v1/words')).json()) as typeof list;
    expect(alist.items.find((i) => i.key === word.key)?.messageCount).toBe(4);
    const detail = (await (await b.req('GET', `/v1/words/${word.key}`)).json()) as {
      messages: unknown[];
    };
    expect(detail.messages).toHaveLength(1);
  });
});

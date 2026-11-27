import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Writable } from 'node:stream';
import { createLogger } from '../../src/logger';
import { LOCK_IDS, sweepOrphans, withAdvisoryLock } from '../../src/jobs';
import { bearer } from '../auth/harness';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import { Api, docDel, makeWorld, rows } from '../sync/helpers';
import { FakeStorage, makePdf } from './support';

vi.setConfig({ testTimeout: 60_000 });

class Counting extends FakeStorage {
  gets = 0;
  stall = false;
  override async getStream(key: string) {
    this.gets += 1;
    return super.getStream(key);
  }
  override async delete(key: string): Promise<void> {
    if (this.stall) return new Promise<void>(() => undefined); // never settles
    return super.delete(key);
  }
}

describe.skipIf(!adminUrl)('review follow-ups (real Postgres)', () => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await createTestDb(15);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  const put = (a: Api, fp: string, bytes: Buffer) =>
    a.h.app.request(`/v1/documents/${fp}/file`, {
      method: 'PUT',
      headers: {
        ...bearer(a.pair),
        'content-type': 'application/pdf',
        'content-length': String(bytes.length),
      },
      body: new Uint8Array(bytes),
    });
  const queueRows = async (userId: string) =>
    (
      await rows(
        tdb.handle,
        sql`SELECT 1 FROM object_deletions WHERE object_key LIKE ${`u/${userId}/%`}`,
      )
    ).length;

  it('HEAD answers from the row: headers only, no bucket read, no download charge', async () => {
    const store = new Counting();
    const w = await makeWorld(tdb.handle, { storage: store, limited: true });
    const a = await w.user();
    const { bytes, fp } = makePdf(4000, 'head');
    expect((await put(a, fp, bytes)).status).toBe(200);
    for (let i = 0; i < 130; i++) {
      const res = await a.req('HEAD', `/v1/documents/${fp}/file`);
      if (i < 120) {
        expect(res.status).toBe(200);
        expect(res.headers.get('content-length')).toBe('4000');
        expect(res.headers.get('content-type')).toBe('application/pdf');
        expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
        expect(await res.text()).toBe('');
      } else {
        expect(res.status).toBe(429); // its own, generous limit
      }
    }
    expect(store.gets).toBe(0);
    // Downloads were not charged by the HEADs: a GET still works and reads the bucket once.
    expect((await a.req('GET', `/v1/documents/${fp}/file`)).status).toBe(200);
    expect(store.gets).toBe(1);
    // Unknown document and another user's document: 404.
    const b = await w.user();
    expect((await b.req('HEAD', `/v1/documents/${fp}/file`)).status).toBe(404);
    expect((await b.req('HEAD', `/v1/documents/${'3'.repeat(64)}/file`)).status).toBe(404);
  });

  it('a stalled bucket does not hold up push, document delete or file delete beyond the inline deadline', async () => {
    const store = new Counting();
    const w = await makeWorld(tdb.handle, { storage: store });
    const a = await w.user();
    const files = [1, 2, 3].map((i) => makePdf(2000, `stall${i}`));
    for (const f of files) expect((await put(a, f.fp, f.bytes)).status).toBe(200);
    store.stall = true;
    const T = w.h.clock.now();

    let t0 = Date.now();
    const push = await a.push([docDel(files[0]!.fp, T), docDel(files[1]!.fp, T)]);
    expect(push.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(6000);

    t0 = Date.now();
    expect((await a.req('DELETE', `/v1/documents/${files[2]!.fp}/file`)).status).toBe(204);
    expect(Date.now() - t0).toBeLessThan(6000);
    // Quota is already refunded and the rows stay queued for the job.
    const [u] = await rows<{ used: string }>(
      tdb.handle,
      sql`SELECT storage_used_bytes::text AS used FROM users WHERE id = ${a.userId}`,
    );
    expect(u?.used).toBe('0');
    expect(await queueRows(a.userId)).toBe(3);

    const g = makePdf(1500, 'stall4');
    store.stall = false;
    expect((await put(a, g.fp, g.bytes)).status).toBe(200);
    store.stall = true;
    t0 = Date.now();
    expect((await a.req('DELETE', `/v1/documents/${g.fp}`)).status).toBe(204);
    expect(Date.now() - t0).toBeLessThan(6000);
  });

  it('withAdvisoryLock rethrows fn errors without discarding a healthy connection', async () => {
    const before = tdb.handle.pool.totalCount;
    await expect(
      withAdvisoryLock(tdb.handle.pool, LOCK_IDS.purge, async () => {
        throw new Error('job bug');
      }),
    ).rejects.toThrow('job bug');
    expect(tdb.handle.pool.totalCount).toBeGreaterThanOrEqual(Math.min(before, 1));
    // The lock was released and the same connection is reusable.
    expect(await withAdvisoryLock(tdb.handle.pool, LOCK_IDS.purge, async () => 1)).toEqual({
      ran: true,
      value: 1,
    });
    expect(tdb.handle.pool.totalCount).toBe(Math.max(before, tdb.handle.pool.totalCount));
  });

  it('orphan sweep carries on after a failing delete, counts it and still raises the storage alert', async () => {
    const lines: string[] = [];
    const logger = createLogger(
      'debug',
      new Writable({
        write(chunk: Buffer, _e, cb) {
          lines.push(chunk.toString());
          cb();
        },
      }),
    );
    class Flaky extends FakeStorage {
      override async delete(key: string) {
        if (key.endsWith('/bad.pdf')) throw new Error('nope');
        return super.delete(key);
      }
    }
    const fake = new Flaky();
    const uid = '11111111-1111-4111-8111-111111111111';
    for (const n of ['a', 'bad', 'c'])
      fake.objects.set(`u/${uid}/${n}.pdf`, { bytes: Buffer.alloc(100), lastModified: new Date() });
    const r = await sweepOrphans(tdb.handle.db, fake, logger, {
      prefix: `u/${uid}/`,
      nowMs: Date.now() + 48 * 3_600_000,
      alertBytes: 50,
    });
    expect(r).toMatchObject({ listed: 3, deleted: 2, errors: 1, totalBytes: 300 });
    expect([...fake.objects.keys()]).toEqual([`u/${uid}/bad.pdf`]);
    expect(lines.join('')).toContain('bucket usage is above the alert threshold');
  });
});

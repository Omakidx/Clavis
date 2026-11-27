import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/logger';
import {
  LOCK_IDS,
  expireUploads,
  runObjectDeletions,
  runPurge,
  startJobs,
  sweepOrphans,
  withAdvisoryLock,
} from '../../src/jobs';
import { bearer } from '../auth/harness';
import { adminUrl, createTestDb, insertUser, type TestDb } from '../db/helpers';
import { makeWorld, rows } from '../sync/helpers';
import { FakeStorage, makePdf, realStorage, s3Configured } from './support';

vi.setConfig({ testTimeout: 60_000 });

function capture() {
  const lines: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _e, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, logger: createLogger('debug', sink) };
}

describe.skipIf(!adminUrl)('background jobs (real Postgres)', () => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await createTestDb(20);
  });
  afterAll(async () => {
    await tdb.drop();
  });
  const q = <T = Record<string, unknown>>(s: ReturnType<typeof sql>) => rows<T>(tdb.handle, s);
  // Each case counts the queue's work exactly, so start from an empty queue.
  beforeEach(async () => {
    await tdb.handle.db.execute(sql`DELETE FROM object_deletions`);
  });

  it('expire-uploads releases reservations and queues the keys; live reservations stay', async () => {
    const { logger } = capture();
    const u = await insertUser(tdb.handle);
    const fp1 = 'a'.repeat(64);
    const fp2 = 'b'.repeat(64);
    const k1 = `u/${u}/${randomUUID()}.pdf`;
    const k2 = `u/${u}/${randomUUID()}.pdf`;
    await q(sql`UPDATE users SET storage_reserved_bytes = 3000 WHERE id = ${u}`);
    await q(sql`INSERT INTO uploads (user_id, fingerprint, reserved_bytes, object_key, status, expires_at)
      VALUES (${u}, ${fp1}, 1000, ${k1}, 'pending', now() - interval '1 minute'),
             (${u}, ${fp2}, 2000, ${k2}, 'pending', now() + interval '10 minutes')`);
    expect(await expireUploads(tdb.handle.db, logger)).toBe(1);
    const [usr] = await q<{ r: string }>(
      sql`SELECT storage_reserved_bytes::text AS r FROM users WHERE id = ${u}`,
    );
    expect(usr?.r).toBe('2000');
    const st = await q<{ fingerprint: string; status: string }>(
      sql`SELECT fingerprint, status FROM uploads WHERE user_id = ${u} ORDER BY fingerprint`,
    );
    expect(st.map((r) => r.status)).toEqual(['expired', 'pending']);
    const del = await q<{ object_key: string }>(
      sql`SELECT object_key FROM object_deletions WHERE object_key = ${k1}`,
    );
    expect(del).toHaveLength(1);
    expect(await expireUploads(tdb.handle.db, logger)).toBe(0);
  });

  it('object deletions retry with exponential backoff and alert after 10 attempts', async () => {
    const { logger, lines } = capture();
    const fake = new FakeStorage();
    const key = `u/${randomUUID()}/${randomUUID()}.pdf`;
    fake.objects.set(key, { bytes: Buffer.from('x'), lastModified: new Date() });
    await q(sql`INSERT INTO object_deletions (object_key) VALUES (${key})`);

    fake.failDelete = true;
    expect(await runObjectDeletions(tdb.handle.db, fake, logger)).toMatchObject({
      attempted: 1,
      deleted: 0,
    });
    let [row] = await q<{ attempts: number; secs: string }>(
      sql`SELECT attempts, extract(epoch FROM next_attempt_at - now())::text AS secs FROM object_deletions WHERE object_key = ${key}`,
    );
    expect(row?.attempts).toBe(1);
    expect(Number(row?.secs)).toBeGreaterThan(50);
    expect(Number(row?.secs)).toBeLessThanOrEqual(60);
    // Not due yet: the next run does not even try.
    expect(await runObjectDeletions(tdb.handle.db, fake, logger)).toMatchObject({ attempted: 0 });

    // Second failure doubles the delay.
    await q(sql`UPDATE object_deletions SET next_attempt_at = now() WHERE object_key = ${key}`);
    await runObjectDeletions(tdb.handle.db, fake, logger);
    [row] = await q(
      sql`SELECT attempts, extract(epoch FROM next_attempt_at - now())::text AS secs FROM object_deletions WHERE object_key = ${key}`,
    );
    expect(row?.attempts).toBe(2);
    expect(Number(row?.secs)).toBeGreaterThan(110);
    expect(Number(row?.secs)).toBeLessThanOrEqual(120);

    // The 10th failed attempt logs an error; the delay is capped at 24 h.
    await q(
      sql`UPDATE object_deletions SET attempts = 9, next_attempt_at = now() WHERE object_key = ${key}`,
    );
    lines.length = 0;
    await runObjectDeletions(tdb.handle.db, fake, logger);
    expect(lines.join('')).toContain('"level":"error"');
    expect(lines.join('')).toContain('object deletion keeps failing');
    expect(lines.join('')).not.toContain(key);
    await q(
      sql`UPDATE object_deletions SET attempts = 30, next_attempt_at = now() WHERE object_key = ${key}`,
    );
    await runObjectDeletions(tdb.handle.db, fake, logger);
    [row] = await q(
      sql`SELECT extract(epoch FROM next_attempt_at - now())::text AS secs FROM object_deletions WHERE object_key = ${key}`,
    );
    expect(Number(row?.secs)).toBeLessThanOrEqual(86_400);
    expect(Number(row?.secs)).toBeGreaterThan(86_000);

    // Recovery: the object goes and the row with it.
    fake.failDelete = false;
    await q(sql`UPDATE object_deletions SET next_attempt_at = now() WHERE object_key = ${key}`);
    expect(await runObjectDeletions(tdb.handle.db, fake, logger)).toMatchObject({
      attempted: 1,
      deleted: 1,
    });
    expect(fake.objects.has(key)).toBe(false);
    expect(await q(sql`SELECT 1 FROM object_deletions WHERE object_key = ${key}`)).toHaveLength(0);
  });

  it('prefix deletions remove every object under the prefix', async () => {
    const { logger } = capture();
    const fake = new FakeStorage();
    const uid = randomUUID();
    for (const n of [1, 2, 3])
      fake.objects.set(`u/${uid}/${n}.pdf`, { bytes: Buffer.from('x'), lastModified: new Date() });
    fake.objects.set(`u/${randomUUID()}/other.pdf`, {
      bytes: Buffer.from('x'),
      lastModified: new Date(),
    });
    await q(sql`INSERT INTO object_deletions (object_prefix) VALUES (${`u/${uid}/`})`);
    await runObjectDeletions(tdb.handle.db, fake, logger);
    expect([...fake.objects.keys()].filter((k) => k.startsWith(`u/${uid}/`))).toHaveLength(0);
    expect(fake.objects.size).toBe(1);
  });

  it('orphan sweep deletes only old objects that nothing references', async () => {
    const { logger } = capture();
    const fake = new FakeStorage();
    const w = await makeWorld(tdb.handle, { storage: fake });
    const a = await w.user();
    const { bytes, fp } = makePdf(3000, 'sweep');
    const up = await w.h.app.request(`/v1/documents/${fp}/file`, {
      method: 'PUT',
      headers: { ...bearer(a.pair), 'content-type': 'application/pdf', 'content-length': '3000' },
      body: new Uint8Array(bytes),
    });
    expect(up.status).toBe(200);
    const referenced = [...fake.objects.keys()][0] as string;
    const pendingKey = `u/${a.userId}/${randomUUID()}.pdf`;
    const orphan = `u/${a.userId}/${randomUUID()}.pdf`;
    await q(sql`INSERT INTO uploads (user_id, fingerprint, reserved_bytes, object_key, status, expires_at)
      VALUES (${a.userId}, ${'9'.repeat(64)}, 10, ${pendingKey}, 'pending', now() + interval '10 minutes')`);
    for (const k of [pendingKey, orphan])
      fake.objects.set(k, { bytes: Buffer.from('x'), lastModified: new Date() });
    const prefix = `u/${a.userId}/`;

    // Everything is younger than 24 h: nothing is deleted.
    expect(await sweepOrphans(tdb.handle.db, fake, logger, { prefix })).toMatchObject({
      listed: 3,
      deleted: 0,
    });
    // Two days later the unreferenced object goes; the document's object and the pending upload's stay.
    const later = Date.now() + 48 * 3_600_000;
    expect(await sweepOrphans(tdb.handle.db, fake, logger, { prefix, nowMs: later })).toMatchObject(
      { deleted: 1 },
    );
    expect([...fake.objects.keys()].sort()).toEqual([pendingKey, referenced].sort());
  });

  it('orphan sweep logs an alert when the listed bytes exceed STORAGE_ALERT_BYTES', async () => {
    const { logger, lines } = capture();
    const fake = new FakeStorage();
    const uid = randomUUID();
    fake.objects.set(`u/${uid}/a.pdf`, { bytes: Buffer.alloc(500), lastModified: new Date() });
    await sweepOrphans(tdb.handle.db, fake, logger, { prefix: `u/${uid}/`, alertBytes: 100 });
    expect(lines.join('')).toContain('bucket usage is above the alert threshold');
  });

  it('purge removes finished uploads older than 7 days and expired tombstones', async () => {
    const { logger } = capture();
    const u = await insertUser(tdb.handle);
    await q(sql`INSERT INTO uploads (user_id, fingerprint, reserved_bytes, object_key, status, created_at, expires_at)
      VALUES (${u}, ${'1'.repeat(64)}, 10, ${`u/${u}/x.pdf`}, 'aborted', now() - interval '8 days', now() - interval '8 days')`);
    await q(sql`INSERT INTO documents (user_id, fingerprint, client_modified_at, seq, deleted_at)
      VALUES (${u}, ${'2'.repeat(64)}, now(), 5, now() - interval '91 days')`);
    const r = await runPurge(tdb.handle.db, logger);
    expect(r.uploads).toBeGreaterThanOrEqual(1);
    expect(r.tombstones.documents).toBeGreaterThanOrEqual(1);
    expect(await q(sql`SELECT 1 FROM uploads WHERE user_id = ${u}`)).toHaveLength(0);
    expect(await q(sql`SELECT 1 FROM documents WHERE user_id = ${u}`)).toHaveLength(0);
  });

  it('advisory locks make a second runner skip', async () => {
    let inner: Awaited<ReturnType<typeof withAdvisoryLock>> | undefined;
    const outer = await withAdvisoryLock(tdb.handle.pool, LOCK_IDS.purge, async () => {
      inner = await withAdvisoryLock(tdb.handle.pool, LOCK_IDS.purge, async () => 'second');
      return 'first';
    });
    expect(outer).toEqual({ ran: true, value: 'first' });
    expect(inner).toEqual({ ran: false });
    // Released afterwards.
    expect(await withAdvisoryLock(tdb.handle.pool, LOCK_IDS.purge, async () => 1)).toEqual({
      ran: true,
      value: 1,
    });
  });

  it('startJobs runs the deletion job on its schedule and stop() waits for it', async () => {
    const { logger } = capture();
    const fake = new FakeStorage();
    const key = `u/${randomUUID()}/${randomUUID()}.pdf`;
    fake.objects.set(key, { bytes: Buffer.from('x'), lastModified: new Date() });
    await q(sql`INSERT INTO object_deletions (object_key) VALUES (${key})`);
    // Scale 0.0001: the 10 s initial delay becomes 1 ms.
    const jobs = startJobs({ handle: tdb.handle, storage: fake, logger, scale: 0.0001 });
    await vi.waitFor(() => expect(fake.objects.has(key)).toBe(false), { timeout: 10_000 });
    await jobs.stop();
  });
});

describe.skipIf(!adminUrl || !s3Configured)('orphan sweep and deletions on MinIO', () => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await createTestDb(10);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  it('lists with lastModified, deletes by key and by prefix', async () => {
    const s = realStorage();
    const { logger } = capture();
    const u = await insertUser(tdb.handle);
    const keys = [1, 2, 3].map((n) => `u/${u}/${n}-${randomUUID()}.pdf`);
    for (const k of keys) {
      const { Readable } = await import('node:stream');
      await s.putStream(k, Readable.from([makePdf(100).bytes]), { contentType: 'application/pdf' });
    }
    const listed: { key: string; lastModified: Date }[] = [];
    for await (const o of s.list(`u/${u}/`)) listed.push(o);
    expect(listed.map((o) => o.key).sort()).toEqual([...keys].sort());
    expect(Math.abs(Date.now() - (listed[0]?.lastModified.getTime() ?? 0))).toBeLessThan(120_000);

    await s.delete(keys[0] as string);
    await s.delete(keys[0] as string); // idempotent
    expect(await s.getStream(keys[0] as string)).toBeNull();
    await tdb.handle.db.execute(
      sql`INSERT INTO object_deletions (object_prefix) VALUES (${`u/${u}/`})`,
    );
    await runObjectDeletions(tdb.handle.db, s, logger);
    const left: string[] = [];
    for await (const o of s.list(`u/${u}/`)) left.push(o.key);
    expect(left).toEqual([]);
  });
});

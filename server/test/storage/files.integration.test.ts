import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AccountResponse, FileUploadResponse, LIMITS } from '../../../shared/api-contract';
import { bearer } from '../auth/harness';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import { Api, docDel, makeWorld, rows, type World } from '../sync/helpers';
import { commitUpload, failUpload, reserveUpload } from '../../src/documents/file-service';
import { deleteAccount } from '../../src/db/queries';
import { createLogger } from '../../src/logger';
import { S3Storage } from '../../src/storage/s3';
import { processObjectDeletions } from '../../src/storage/deletions';
import { FakeStorage, makePdf, realStorage, s3Configured, s3Env, sha256 } from './support';

const MiB = 1024 * 1024;

vi.setConfig({ testTimeout: 60_000 });

type Err = { error: { code: string } };
const code = async (r: Response) => ((await r.json()) as Err).error.code;

describe.skipIf(!adminUrl || !s3Configured)('PDF file endpoints (real Postgres + MinIO)', () => {
  let tdb: TestDb;
  let w: World;
  let storage: ReturnType<typeof realStorage>;

  beforeAll(async () => {
    tdb = await createTestDb(30);
    storage = realStorage();
    w = await makeWorld(tdb.handle, { storage, env: { MAX_CONCURRENT_UPLOADS: '100' } });
  });
  afterAll(async () => {
    await tdb.drop();
  });

  const put = (
    a: Api,
    fp: string,
    body: Uint8Array | null,
    over: { headers?: Record<string, string>; length?: number | null } = {},
  ) => {
    const length = over.length === undefined ? (body?.length ?? 0) : over.length;
    return a.h.app.request(`/v1/documents/${fp}/file`, {
      method: 'PUT',
      headers: {
        ...bearer(a.pair),
        'content-type': 'application/pdf',
        ...(length === null ? {} : { 'content-length': String(length) }),
        ...over.headers,
      },
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  };
  const get = (a: Api, fp: string) => a.req('GET', `/v1/documents/${fp}/file`);
  const usage = async (id: string) => {
    const r = (
      await rows<{ used: string; reserved: string }>(
        tdb.handle,
        sql`SELECT storage_used_bytes AS used, storage_reserved_bytes AS reserved FROM users WHERE id = ${id}`,
      )
    )[0] as { used: string; reserved: string };
    return { used: Number(r.used), reserved: Number(r.reserved) };
  };
  const keysOf = async (userId: string) => {
    const out: string[] = [];
    for await (const o of storage.list(`u/${userId}/`)) out.push(o.key);
    return out;
  };
  const queued = async (userId: string) =>
    Number(
      (
        await rows<{ n: string }>(
          tdb.handle,
          sql`SELECT count(*)::text AS n FROM object_deletions WHERE object_key LIKE ${`u/${userId}/%`}`,
        )
      )[0]?.n,
    );
  const setQuota = (id: string, q: number) =>
    tdb.handle.db.execute(sql`UPDATE users SET storage_quota_bytes = ${q} WHERE id = ${id}`);

  it('round-trips a PDF with byte equality, headers, account usage and seq bump', async () => {
    const a = await w.user();
    const { bytes, fp } = makePdf(1_000_000, 'roundtrip'); // above the 512 KiB JSON body limit
    const title = 'Secret Título ÄÖ';
    const res = await put(a, fp, bytes, {
      headers: { 'x-clavis-title': encodeURIComponent(title) },
    });
    expect(res.status).toBe(200);
    const body = FileUploadResponse.parse(await res.json());
    expect(body.document).toMatchObject({
      fingerprint: fp,
      title,
      storage: { state: 'stored', bytes: bytes.length },
    });
    expect(body.document.storage.storedAt).toBeTypeOf('number');
    expect(await usage(a.userId)).toEqual({ used: bytes.length, reserved: 0 });
    expect(await keysOf(a.userId)).toHaveLength(1);

    const dl = await get(a, fp);
    expect(dl.status).toBe(200);
    expect(dl.headers.get('content-type')).toBe('application/pdf');
    expect(dl.headers.get('content-length')).toBe(String(bytes.length));
    expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
    expect(dl.headers.get('cache-control')).toBe('private, no-store');
    expect(dl.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    const cd = dl.headers.get('content-disposition') as string;
    expect(cd).toMatch(/^attachment; filename="[\x20-\x7e]+\.pdf"/);
    expect(cd).not.toContain('/');
    expect(cd).toContain("filename*=UTF-8''");
    expect(Buffer.from(await dl.arrayBuffer()).equals(bytes)).toBe(true);

    const acct = AccountResponse.parse(await (await a.req('GET', '/v1/account')).json());
    expect(acct.usage.storageUsedBytes).toBe(bytes.length);
    // The stored state reaches other devices through pull.
    const pulled = await a.pullAll();
    const doc = pulled.changes.find((c) => c.kind === 'document');
    expect(doc).toMatchObject({
      kind: 'document',
      storage: { state: 'stored', bytes: bytes.length },
    });
  });

  it('works over a real HTTP socket: upload, early refusal of a large non-PDF, chunked upload gets 411', async () => {
    const a = await w.user();
    const server = serve({ fetch: a.h.app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const { bytes, fp } = makePdf(2_000_000, 'http');
      const ok = await fetch(`${base}/v1/documents/${fp}/file`, {
        method: 'PUT',
        headers: { ...bearer(a.pair), 'content-type': 'application/pdf' },
        body: new Uint8Array(bytes),
      });
      expect(ok.status).toBe(200);
      const dl = await fetch(`${base}/v1/documents/${fp}/file`, { headers: bearer(a.pair) });
      expect(Buffer.from(await dl.arrayBuffer()).equals(bytes)).toBe(true);

      const junk = Buffer.alloc(3_000_000, 0x41);
      const refused = await fetch(`${base}/v1/documents/${'1'.repeat(64)}/file`, {
        method: 'PUT',
        headers: { ...bearer(a.pair), 'content-type': 'application/pdf' },
        body: new Uint8Array(junk),
      });
      expect(await code(refused)).toBe('NOT_A_PDF');

      const chunked = await fetch(`${base}/v1/documents/${'2'.repeat(64)}/file`, {
        method: 'PUT',
        headers: { ...bearer(a.pair), 'content-type': 'application/pdf' },
        body: new ReadableStream({
          start(ctl) {
            ctl.enqueue(new Uint8Array(10));
            ctl.close();
          },
        }),
        duplex: 'half',
      } as RequestInit);
      expect(chunked.status).toBe(411);
      expect(await usage(a.userId)).toEqual({ used: 2_000_000, reserved: 0 });
    } finally {
      server.close();
      (server as import('node:http').Server).closeAllConnections();
    }
  });

  it('uploads a multi-part (> 5 MiB) object and downloads it identically', async () => {
    const a = await w.user();
    const { bytes, fp } = makePdf(LIMITS.maxFileBytes - 1000, 'big');
    const res = await put(a, fp, bytes);
    expect(res.status).toBe(200);
    const dl = await get(a, fp);
    expect(sha256(Buffer.from(await dl.arrayBuffer()))).toBe(fp);
  });

  it('answers 200 for an already stored file, drains the body and stores nothing twice', async () => {
    const a = await w.user();
    const { bytes, fp } = makePdf(5000, 'dedupe');
    expect((await put(a, fp, bytes)).status).toBe(200);
    const again = await put(a, fp, bytes);
    expect(again.status).toBe(200);
    expect(FileUploadResponse.parse(await again.json()).document.storage.state).toBe('stored');
    expect(await usage(a.userId)).toEqual({ used: 5000, reserved: 0 });
    expect(await keysOf(a.userId)).toHaveLength(1);
  });

  it('409 UPLOAD_IN_PROGRESS while a live reservation exists, and an expired one is replaced', async () => {
    const a = await w.user();
    const { bytes, fp } = makePdf(4000, 'pending');
    const id = randomUUID();
    await tdb.handle.db.execute(sql`
      UPDATE users SET storage_reserved_bytes = 4000 WHERE id = ${a.userId}`);
    await tdb.handle.db.execute(sql`
      INSERT INTO uploads (id, user_id, fingerprint, reserved_bytes, object_key, status, expires_at)
      VALUES (${id}, ${a.userId}, ${fp}, 4000, ${`u/${a.userId}/${id}.pdf`}, 'pending', now() + interval '10 minutes')`);
    const busy = await put(a, fp, bytes);
    expect(busy.status).toBe(409);
    expect(await code(busy)).toBe('UPLOAD_IN_PROGRESS');
    expect(await usage(a.userId)).toEqual({ used: 0, reserved: 4000 });

    await tdb.handle.db.execute(
      sql`UPDATE uploads SET expires_at = now() - interval '1 minute' WHERE id = ${id}`,
    );
    const ok = await put(a, fp, bytes);
    expect(ok.status).toBe(200);
    expect(await usage(a.userId)).toEqual({ used: 4000, reserved: 0 });
    const [st] = await rows<{ status: string }>(
      tdb.handle,
      sql`SELECT status FROM uploads WHERE id = ${id}`,
    );
    expect(st?.status).toBe('expired');
  });

  it('rejects non-PDF content with NOT_A_PDF and releases the reservation', async () => {
    const a = await w.user();
    for (const size of [50, 5000]) {
      const junk = Buffer.alloc(size, 0x41);
      const res = await put(a, 'b'.repeat(64), junk);
      expect(res.status).toBe(422);
      expect(await code(res)).toBe('NOT_A_PDF');
      expect(await usage(a.userId)).toEqual({ used: 0, reserved: 0 });
    }
    expect(await keysOf(a.userId)).toHaveLength(0);
    expect(await queued(a.userId)).toBe(0); // inline delete consumed the queue rows
  });

  it('accepts %PDF- anywhere in the first 1024 bytes but not after', async () => {
    const a = await w.user();
    const late = Buffer.concat([
      Buffer.alloc(1100, 0x20),
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(100),
    ]);
    const r1 = await put(a, sha256(late), late);
    expect(await code(r1)).toBe('NOT_A_PDF');
    const early = Buffer.concat([
      Buffer.alloc(900, 0x20),
      Buffer.from('%PDF-1.4\n'),
      Buffer.alloc(100),
    ]);
    expect((await put(a, sha256(early), early)).status).toBe(200);
  });

  it('rejects a fingerprint mismatch and cleans up', async () => {
    const a = await w.user();
    const { bytes } = makePdf(6000, 'mismatch');
    const res = await put(a, 'c'.repeat(64), bytes);
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('FINGERPRINT_MISMATCH');
    expect(await usage(a.userId)).toEqual({ used: 0, reserved: 0 });
    expect(await keysOf(a.userId)).toHaveLength(0);
    expect(await queued(a.userId)).toBe(0);
    const docs = await rows(tdb.handle, sql`SELECT 1 FROM documents WHERE user_id = ${a.userId}`);
    expect(docs).toHaveLength(0);
  });

  it('rejects a body shorter or longer than Content-Length with 400', async () => {
    const a = await w.user();
    const { bytes, fp } = makePdf(3000, 'length');
    const short = await put(a, fp, bytes.subarray(0, 2000), { length: 3000 });
    expect(short.status).toBe(400);
    expect(await code(short)).toBe('VALIDATION_FAILED');
    const long = await put(a, fp, bytes, { length: 2000 });
    expect(long.status).toBe(400);
    expect(await code(long)).toBe('VALIDATION_FAILED');
    expect(await usage(a.userId)).toEqual({ used: 0, reserved: 0 });
    expect(await keysOf(a.userId)).toHaveLength(0);
  });

  it('pre-checks: 415, 411, 413 and invalid titles are refused before any reservation', async () => {
    const a = await w.user();
    const { bytes, fp } = makePdf(2000, 'pre');
    const wrongType = await put(a, fp, bytes, { headers: { 'content-type': 'text/plain' } });
    expect(wrongType.status).toBe(415);
    const noLength = await put(a, fp, bytes, { length: null });
    expect(noLength.status).toBe(411);
    expect(await code(noLength)).toBe('VALIDATION_FAILED');
    const tooBig = await put(a, fp, bytes, { length: LIMITS.maxFileBytes + 1 });
    expect(tooBig.status).toBe(413);
    expect(await code(tooBig)).toBe('FILE_TOO_LARGE');
    const zero = await put(a, fp, new Uint8Array(0), { length: 0 });
    expect(zero.status).toBe(413);
    const badTitle = await put(a, fp, bytes, { headers: { 'x-clavis-title': '%E0%A4%A' } });
    expect(badTitle.status).toBe(400);
    const longTitle = await put(a, fp, bytes, { headers: { 'x-clavis-title': 'a'.repeat(301) } });
    expect(longTitle.status).toBe(400);
    const nul = await put(a, fp, bytes, { headers: { 'x-clavis-title': 'a%00b' } });
    expect(nul.status).toBe(400);
    expect(await usage(a.userId)).toEqual({ used: 0, reserved: 0 });
    const none = await a.h.app.request(`/v1/documents/${fp}/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf', 'content-length': '10' },
      body: new Uint8Array(10),
    });
    expect(none.status).toBe(401);
    const badFp = await put(a, 'xyz', bytes);
    expect(badFp.status).toBe(404);
  });

  it('QUOTA_EXCEEDED when the file does not fit', async () => {
    const a = await w.user();
    await setQuota(a.userId, 5000);
    const { bytes, fp } = makePdf(6000, 'quota');
    const res = await put(a, fp, bytes);
    expect(res.status).toBe(422);
    expect(await code(res)).toBe('QUOTA_EXCEEDED');
    expect(await usage(a.userId)).toEqual({ used: 0, reserved: 0 });
  });

  it('quota race: 20 parallel uploads above the quota admit exactly the fitting subset', async () => {
    const a = await w.user();
    const quota = 1_000_000;
    await setQuota(a.userId, quota);
    const files = Array.from({ length: 20 }, (_, i) => makePdf(150_000, `race${i}`));
    const results = await Promise.all(files.map((f) => put(a, f.fp, f.bytes)));
    const ok = results.filter((r) => r.status === 200).length;
    const over = results.filter((r) => r.status === 422);
    expect(ok).toBe(6); // floor(1_000_000 / 150_000)
    expect(over).toHaveLength(14);
    for (const r of over) expect(await code(r)).toBe('QUOTA_EXCEEDED');
    expect(await usage(a.userId)).toEqual({ used: 6 * 150_000, reserved: 0 });
    expect(await keysOf(a.userId)).toHaveLength(6);
    const [n] = await rows<{ n: string }>(
      tdb.handle,
      sql`SELECT count(*)::text AS n FROM documents WHERE user_id = ${a.userId} AND storage_state = 'stored'`,
    );
    expect(n?.n).toBe('6');
  });

  it('quota race with mixed sizes never over-commits and settles to reserved = 0', async () => {
    const a = await w.user();
    const quota = 700_000;
    await setQuota(a.userId, quota);
    const sizes = [
      300_000, 250_000, 200_000, 180_000, 120_000, 90_000, 60_000, 400_000, 150_000, 80_000,
    ];
    const files = sizes.map((s, i) => makePdf(s, `mix${i}`));
    const results = await Promise.all(files.map((f) => put(a, f.fp, f.bytes)));
    const stored = files.filter((_, i) => results[i]?.status === 200);
    const total = stored.reduce((n, f) => n + f.bytes.length, 0);
    expect(total).toBeLessThanOrEqual(quota);
    expect(await usage(a.userId)).toEqual({ used: total, reserved: 0 });
    for (const [i, r] of results.entries()) {
      if (r.status !== 200) expect(await code(r)).toBe('QUOTA_EXCEEDED');
      expect([200, 422]).toContain(results[i]?.status);
    }
  });

  it("IDOR: user B cannot see, download or delete user A's file", async () => {
    const a = await w.user();
    const b = await w.user();
    const { bytes, fp } = makePdf(3000, 'idor');
    expect((await put(a, fp, bytes)).status).toBe(200);

    expect((await get(b, fp)).status).toBe(404);
    expect((await b.req('DELETE', `/v1/documents/${fp}/file`)).status).toBe(404);
    expect((await b.req('DELETE', `/v1/documents/${fp}`)).status).toBe(404);
    expect((await b.req('GET', `/v1/documents/${fp}`)).status).toBe(404);
    // B uploading the same bytes gets B's own document and quota; A is untouched.
    const own = await put(b, fp, bytes);
    expect(own.status).toBe(200);
    expect(await usage(b.userId)).toEqual({ used: 3000, reserved: 0 });
    expect(await usage(a.userId)).toEqual({ used: 3000, reserved: 0 });
    expect((await keysOf(a.userId)).length).toBe(1);
    expect((await keysOf(b.userId)).length).toBe(1);
    expect((await get(a, fp)).status).toBe(200);
    // B removing its own copy never touches A's object.
    expect((await b.req('DELETE', `/v1/documents/${fp}/file`)).status).toBe(204);
    expect((await get(a, fp)).status).toBe(200);
  });

  it('DELETE .../file removes the object, refunds quota, keeps the document and bumps seq', async () => {
    const a = await w.user();
    const { bytes, fp } = makePdf(8000, 'rmfile');
    await put(a, fp, bytes, { headers: { 'x-clavis-title': 'Keep me' } });
    const before = await a.pullAll();
    const res = await a.req('DELETE', `/v1/documents/${fp}/file`);
    expect(res.status).toBe(204);
    expect(await usage(a.userId)).toEqual({ used: 0, reserved: 0 });
    expect(await keysOf(a.userId)).toHaveLength(0);
    expect(await queued(a.userId)).toBe(0);
    expect((await get(a, fp)).status).toBe(404);
    const detail = (await (await a.req('GET', `/v1/documents/${fp}`)).json()) as {
      document: { title: string; storage: { state: string; bytes: number | null } };
    };
    expect(detail.document).toMatchObject({
      title: 'Keep me',
      storage: { state: 'none', bytes: null, storedAt: null },
    });
    const after = await a.pullAll(before.nextCursor);
    expect(after.changes).toHaveLength(1);
    // Idempotent for a document that has no file; 404 for an unknown document.
    expect((await a.req('DELETE', `/v1/documents/${fp}/file`)).status).toBe(204);
    expect((await a.req('DELETE', `/v1/documents/${'d'.repeat(64)}/file`)).status).toBe(404);
    // The file can be uploaded again.
    expect((await put(a, fp, bytes)).status).toBe(200);
    expect(await usage(a.userId)).toEqual({ used: 8000, reserved: 0 });
  });

  it('document DELETE refunds quota and deletes the object', async () => {
    const a = await w.user();
    const { bytes, fp } = makePdf(7000, 'docdel');
    await put(a, fp, bytes);
    expect((await a.req('DELETE', `/v1/documents/${fp}`)).status).toBe(204);
    expect(await usage(a.userId)).toEqual({ used: 0, reserved: 0 });
    expect(await keysOf(a.userId)).toHaveLength(0);
    expect(await queued(a.userId)).toBe(0);
    expect((await get(a, fp)).status).toBe(404);
  });

  it('a sync document tombstone refunds quota and deletes the object', async () => {
    const a = await w.user();
    const { bytes, fp } = makePdf(9000, 'tomb');
    await put(a, fp, bytes);
    const T = w.h.clock.now();
    const out = await a.pushOk([docDel(fp, T)]);
    expect(out.results[0]?.status).toBe('applied');
    expect(await usage(a.userId)).toEqual({ used: 0, reserved: 0 });
    expect(await keysOf(a.userId)).toHaveLength(0);
    expect(await queued(a.userId)).toBe(0);
    // Uploading again after the tombstone resurrects the document as a stub and stores the file.
    expect((await put(a, fp, bytes)).status).toBe(200);
    expect(await usage(a.userId)).toEqual({ used: 9000, reserved: 0 });
  });

  it('logs route templates and byte counts only: no titles, emails, fingerprints or paths', async () => {
    const a = await w.user();
    const { bytes, fp } = makePdf(2500, 'logs');
    w.h.logs.length = 0;
    await put(a, fp, bytes, {
      headers: { 'x-clavis-title': encodeURIComponent('Confidential Memo 42') },
    });
    await get(a, fp);
    await a.req('DELETE', `/v1/documents/${fp}/file`);
    await put(a, 'e'.repeat(64), Buffer.alloc(200, 0x41)); // an error path
    const text = w.h.logs.join('');
    expect(text).toContain('/v1/documents/:fp/file');
    expect(text).not.toContain('Confidential');
    expect(text).not.toContain('example.test');
    expect(text).not.toContain(fp);
    expect(text).not.toContain('e'.repeat(64));
    expect(text).not.toContain('u/');
    expect(text).not.toMatch(/Bearer|authorization/i);
  });
});

describe.skipIf(!adminUrl)('PDF file endpoints with a fake store (real Postgres)', () => {
  let tdb: TestDb;

  beforeAll(async () => {
    tdb = await createTestDb(20);
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
  const usage = async (id: string) =>
    (
      await rows<{ used: string; reserved: string }>(
        tdb.handle,
        sql`SELECT storage_used_bytes::text AS used, storage_reserved_bytes::text AS reserved FROM users WHERE id = ${id}`,
      )
    )[0];

  it('answers 503 UNAVAILABLE when S3 is not configured, while document delete still works', async () => {
    const w = await makeWorld(tdb.handle); // no storage
    const a = await w.user();
    const { bytes, fp } = makePdf(2000, 'nos3');
    const up = await put(a, fp, bytes);
    expect(up.status).toBe(503);
    expect(await code(up)).toBe('UNAVAILABLE');
    const dl = await a.req('GET', `/v1/documents/${fp}/file`);
    expect(dl.status).toBe(503);
    await a.pushOk([
      {
        kind: 'document',
        op: 'upsert',
        key: fp,
        clientModifiedAt: w.h.clock.now(),
        data: { title: 'x', pageCount: 1, lastPage: 1, pageOffset: 0, fileBytes: 10 },
      },
    ]);
    expect((await a.req('DELETE', `/v1/documents/${fp}`)).status).toBe(204);
    expect((await a.req('GET', '/v1/account')).status).toBe(200);
  });

  it('a storage failure releases the reservation, queues the key and answers 503', async () => {
    const fake = new FakeStorage();
    fake.failPut = true;
    const w = await makeWorld(tdb.handle, { storage: fake });
    const a = await w.user();
    const { bytes, fp } = makePdf(4000, 'putfail');
    const res = await put(a, fp, bytes);
    expect(res.status).toBe(503);
    expect(await usage(a.userId)).toEqual({ used: '0', reserved: '0' });
    const [u] = await rows<{ status: string }>(
      tdb.handle,
      sql`SELECT status FROM uploads WHERE user_id = ${a.userId}`,
    );
    expect(u?.status).toBe('aborted');
    expect(fake.objects.size).toBe(0);
  });

  it('enforces 20 uploads per hour and the 300 MiB daily byte budget', async () => {
    const fake = new FakeStorage();
    const w = await makeWorld(tdb.handle, { storage: fake, limited: true });
    const a = await w.user();
    // Count limit: the 21st attempt in the window is refused (invalid body keeps this cheap).
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++)
      statuses.push((await put(a, 'f'.repeat(64), Buffer.alloc(100, 0x41))).status);
    expect(statuses.slice(0, 20).every((s) => s === 422)).toBe(true);
    expect(statuses[20]).toBe(429);
    // Byte budget: 20 x 15 MiB would be 300 MiB; a fresh user is refused once the budget is used up.
    const b = await w.user();
    const bytesRule = w.h.limiter.take(
      `user:file-up-bytes:${b.userId}`,
      { limit: 300 * 1024 * 1024, windowMs: 86_400_000 },
      300 * 1024 * 1024,
    );
    expect(bytesRule).toBe(0);
    const { bytes, fp } = makePdf(2000, 'budget');
    const res = await put(b, fp, bytes);
    expect(res.status).toBe(429);
  });
});

describe.skipIf(!adminUrl || !s3Configured)(
  'storage review regressions (real Postgres + MinIO)',
  () => {
    let tdb: TestDb;
    beforeAll(async () => {
      tdb = await createTestDb(20);
    });
    afterAll(async () => {
      await tdb.drop();
    });
    const usage = async (id: string) => {
      const r = (
        await rows<{ used: string; reserved: string }>(
          tdb.handle,
          sql`SELECT storage_used_bytes::text AS used, storage_reserved_bytes::text AS reserved FROM users WHERE id = ${id}`,
        )
      )[0] as { used: string; reserved: string };
      return { used: Number(r.used), reserved: Number(r.reserved) };
    };
    const queueFor = async (key: string) =>
      (await rows(tdb.handle, sql`SELECT 1 FROM object_deletions WHERE object_key = ${key}`))
        .length;
    const listKeys = async (s: ReturnType<typeof realStorage>, userId: string) => {
      const out: string[] = [];
      for await (const o of s.list(`u/${userId}/`)) out.push(o.key);
      return out;
    };
    const pdfPut = (a: Api, fp: string, bytes: Buffer) =>
      a.h.app.request(`/v1/documents/${fp}/file`, {
        method: 'PUT',
        headers: {
          ...bearer(a.pair),
          'content-type': 'application/pdf',
          'content-length': String(bytes.length),
        },
        body: new Uint8Array(bytes),
      });

    it('M1: a download slower than the call timeout still delivers every byte', async () => {
      const slow = new S3Storage(
        {
          endpoint: s3Env.endpoint as string,
          region: 'us-east-1',
          bucket: s3Env.bucket as string,
          accessKeyId: s3Env.accessKeyId as string,
          secretAccessKey: s3Env.secretAccessKey as string,
          forcePathStyle: true,
        },
        { callTimeoutMs: 400 },
      );
      const { bytes } = makePdf(8 * 1024 * 1024, 'slowread');
      const key = `u/${randomUUID()}/${randomUUID()}.pdf`;
      await slow.putStream(key, Readable.from([bytes]), { contentType: 'application/pdf' });
      try {
        const obj = await slow.getStream(key);
        expect(obj?.contentLength).toBe(bytes.length);
        const reader = (obj as NonNullable<typeof obj>).stream.getReader();
        const parts: Buffer[] = [];
        const started = Date.now();
        let n = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(Buffer.from(value));
          // Stall well past the call timeout while the body is still arriving.
          if (++n % 20 === 0) await new Promise((r) => setTimeout(r, 120));
        }
        expect(Date.now() - started).toBeGreaterThan(500);
        expect(Buffer.concat(parts).equals(bytes)).toBe(true);
      } finally {
        await slow.delete(key);
      }
    });

    it('M1: a missing object is null', async () => {
      const s = realStorage();
      expect(await s.getStream(`u/${randomUUID()}/none.pdf`)).toBeNull();
    });

    it('L1: a file uploaded while the account is deleted is queued and removed', async () => {
      const storage = realStorage();
      const w = await makeWorld(tdb.handle, { storage });
      const a = await w.user();
      const { bytes, fp } = makePdf(5000, 'l1');
      const r = await reserveUpload(tdb.handle.db, {
        userId: a.userId,
        fingerprint: fp,
        bytes: bytes.length,
      });
      if (r.kind !== 'reserved') throw new Error('expected a reservation');
      await storage.putStream(r.objectKey, Readable.from([bytes]), {
        contentType: 'application/pdf',
      });
      await deleteAccount(tdb.handle.db, a.userId);
      await processObjectDeletions(tdb.handle.db, storage, createLogger('silent'));
      // The upload finishes after the account (and its uploads row) are gone.
      const out = await commitUpload(tdb.handle.db, {
        userId: a.userId,
        fingerprint: fp,
        uploadId: r.uploadId,
        objectKey: r.objectKey,
        bytes: bytes.length,
        title: null,
      });
      expect(out).toBe('expired');
      await processObjectDeletions(tdb.handle.db, storage, createLogger('silent'));
      expect(await listKeys(storage, a.userId)).toEqual([]);

      // The failure path behaves the same way.
      const b = await w.user();
      const r2 = await reserveUpload(tdb.handle.db, {
        userId: b.userId,
        fingerprint: fp,
        bytes: bytes.length,
      });
      if (r2.kind !== 'reserved') throw new Error('expected a reservation');
      await storage.putStream(r2.objectKey, Readable.from([bytes]), {
        contentType: 'application/pdf',
      });
      await deleteAccount(tdb.handle.db, b.userId);
      await failUpload(tdb.handle.db, {
        userId: b.userId,
        uploadId: r2.uploadId,
        objectKey: r2.objectKey,
        bytes: bytes.length,
      });
      await processObjectDeletions(tdb.handle.db, storage, createLogger('silent'));
      expect(await listKeys(storage, b.userId)).toEqual([]);
    });

    it('L2: failUpload after a successful commit leaves the stored file alone', async () => {
      const storage = realStorage();
      const w = await makeWorld(tdb.handle, { storage });
      const a = await w.user();
      const { bytes, fp } = makePdf(6000, 'l2');
      const r = await reserveUpload(tdb.handle.db, {
        userId: a.userId,
        fingerprint: fp,
        bytes: bytes.length,
      });
      if (r.kind !== 'reserved') throw new Error('expected a reservation');
      await storage.putStream(r.objectKey, Readable.from([bytes]), {
        contentType: 'application/pdf',
      });
      const args = {
        userId: a.userId,
        uploadId: r.uploadId,
        objectKey: r.objectKey,
        bytes: bytes.length,
      };
      expect(await commitUpload(tdb.handle.db, { ...args, fingerprint: fp, title: null })).toBe(
        'committed',
      );
      await failUpload(tdb.handle.db, args);
      expect(await queueFor(r.objectKey)).toBe(0);
      expect(await usage(a.userId)).toEqual({ used: bytes.length, reserved: 0 });
      expect(await listKeys(storage, a.userId)).toEqual([r.objectKey]);
    });

    it('L3: commit re-checks the document limit, releases the reservation and queues the key', async () => {
      const storage = realStorage();
      const w = await makeWorld(tdb.handle, { storage });
      const a = await w.user();
      const { bytes, fp } = makePdf(3000, 'l3');
      const r = await reserveUpload(tdb.handle.db, {
        userId: a.userId,
        fingerprint: fp,
        bytes: bytes.length,
      });
      if (r.kind !== 'reserved') throw new Error('expected a reservation');
      await storage.putStream(r.objectKey, Readable.from([bytes]), {
        contentType: 'application/pdf',
      });
      await tdb.handle.db.execute(sql`
      INSERT INTO documents (user_id, fingerprint, client_modified_at, seq)
      SELECT ${a.userId}, lpad(to_hex(g), 64, '0'), now(), g FROM generate_series(1, ${LIMITS.maxDocuments}) g`);
      const out = await commitUpload(tdb.handle.db, {
        userId: a.userId,
        fingerprint: fp,
        uploadId: r.uploadId,
        objectKey: r.objectKey,
        bytes: bytes.length,
        title: null,
      });
      expect(out).toBe('limit-exceeded');
      expect(await usage(a.userId)).toEqual({ used: 0, reserved: 0 });
      expect(await queueFor(r.objectKey)).toBe(1);
      expect(
        await rows(
          tdb.handle,
          sql`SELECT 1 FROM documents WHERE user_id = ${a.userId} AND fingerprint = ${fp}`,
        ),
      ).toHaveLength(0);
    });

    it('L4: the daily byte budget is charged only for uploads that run', async () => {
      const storage = realStorage();
      const w = await makeWorld(tdb.handle, { storage, limited: true });
      const a = await w.user();
      const { bytes, fp } = makePdf(2000, 'l4');
      expect((await pdfPut(a, fp, bytes)).status).toBe(200);
      // Dedupes and quota refusals charge nothing.
      for (let i = 0; i < 5; i++) expect((await pdfPut(a, fp, bytes)).status).toBe(200); // dedupe
      expect((await pdfPut(a, 'f'.repeat(64), Buffer.alloc(500, 0x41))).status).toBe(422); // NOT_A_PDF
      await tdb.handle.db.execute(
        sql`UPDATE users SET storage_quota_bytes = 2500 WHERE id = ${a.userId}`,
      );
      expect((await pdfPut(a, '1'.repeat(64), makePdf(3000, 'q').bytes)).status).toBe(422); // QUOTA_EXCEEDED
      // The budget still affords 300 MiB - 2000 bytes.
      expect(
        w.h.limiter.take(
          `user:file-up-bytes:${a.userId}`,
          { limit: 300 * MiB, windowMs: 86_400_000 },
          300 * MiB - 2500,
        ),
      ).toBe(0); // 2000 stored + 500 that reached the stream (NOT_A_PDF)
      // An over-budget upload releases its reservation.
      await tdb.handle.db.execute(
        sql`UPDATE users SET storage_quota_bytes = 104857600 WHERE id = ${a.userId}`,
      );
      const c = makePdf(4000, 'l4b');
      expect((await pdfPut(a, c.fp, c.bytes)).status).toBe(429);
      expect(await usage(a.userId)).toEqual({ used: 2000, reserved: 0 });
    });

    it('I1: uploads above the process-wide cap get 503 before reserving anything', async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      class Gated extends FakeStorage {
        override async putStream(key: string, body: NodeJS.ReadableStream) {
          await gate;
          return super.putStream(key, body);
        }
      }
      const w = await makeWorld(tdb.handle, {
        storage: new Gated(),
        env: { MAX_CONCURRENT_UPLOADS: '1' },
      });
      const a = await w.user();
      const one = makePdf(2000, 'i1a');
      const two = makePdf(2000, 'i1b');
      const first = pdfPut(a, one.fp, one.bytes);
      await vi.waitFor(async () => expect((await usage(a.userId)).reserved).toBe(2000));
      const second = await pdfPut(a, two.fp, two.bytes);
      expect(second.status).toBe(503);
      expect(await code(second)).toBe('UNAVAILABLE');
      expect(second.headers.get('retry-after')).toBeTruthy();
      expect((await usage(a.userId)).reserved).toBe(2000);
      release();
      expect((await first).status).toBe(200);
      expect(await usage(a.userId)).toEqual({ used: 2000, reserved: 0 });
      expect((await pdfPut(a, two.fp, two.bytes)).status).toBe(200); // the slot is free again
    });

    it('I3: a bucket read error on download is a 503 UNAVAILABLE', async () => {
      class Broken extends FakeStorage {
        override async getStream(): Promise<never> {
          throw new Error('boom');
        }
      }
      const fake = new Broken();
      const w = await makeWorld(tdb.handle, { storage: fake });
      const a = await w.user();
      const { bytes, fp } = makePdf(2500, 'i3');
      expect((await pdfPut(a, fp, bytes)).status).toBe(200);
      const res = await a.req('GET', `/v1/documents/${fp}/file`);
      expect(res.status).toBe(503);
      expect(await code(res)).toBe('UNAVAILABLE');
      expect(res.headers.get('retry-after')).toBeTruthy();
    });
  },
);

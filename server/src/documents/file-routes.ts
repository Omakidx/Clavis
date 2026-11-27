// PDF file endpoints (docs/clavis-sync-design.md §5.4, §6.2-§6.4):
//   PUT    /v1/documents/:fp/file   `B`    streamed upload, race-free quota, SHA-256 must equal :fp
//   GET    /v1/documents/:fp/file   `B|C`  streamed download
//   DELETE /v1/documents/:fp/file   `B|C`  remove the file, refund quota
// The server never parses a PDF: it checks the magic bytes and the hash only.
import { createHash } from 'node:crypto';
import { Readable, Transform, pipeline, type TransformCallback } from 'node:stream';
import { and, eq, isNull } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import {
  FILE_TITLE_HEADER,
  FileTitleHeader,
  Hex64,
  LIMITS,
  type DocumentView,
} from '../../../shared/api-contract';
import { requireBearer, requireBearerOrCookie } from '../auth/middleware';
import type { AuthRuntime } from '../auth/runtime';
import type { Database } from '../db/client';
import { documents } from '../db/schema';
import { ApiException } from '../http/errors';
import { enforce, perDay, perHour, perMinute } from '../http/rate-limit';
import type { AppEnv } from '../http/types';
import type { Logger } from '../logger';
import { deleteQueuedKeys } from '../storage/deletions';
import type { ObjectStorage } from '../storage/types';
import { commitUpload, failUpload, removeFile, reserveUpload } from './file-service';
import { loadDocumentView } from './view';

export const UPLOAD_TIMEOUT_MS = 120_000;
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/** Counts and hashes the stream, requires `%PDF-` in the first 1024 bytes, and enforces the declared length. */
export class UploadGuard extends Transform {
  bytes = 0;
  digest = '';
  /** The reason the stream was refused (S3 failures leave this unset). */
  failure: ApiException | undefined;
  private readonly hash = createHash('sha256');
  private head: Buffer[] = [];
  private headLen = 0;
  private magic = false;

  constructor(private readonly expected: number) {
    super();
  }

  private refuse(err: ApiException, cb: TransformCallback) {
    this.failure ??= err;
    cb(err);
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.bytes += chunk.length;
    if (this.bytes > this.expected) {
      return this.refuse(
        new ApiException('VALIDATION_FAILED', 'Body is longer than Content-Length'),
        cb,
      );
    }
    this.hash.update(chunk);
    if (!this.magic) {
      const room = 1024 - this.headLen;
      if (room > 0) {
        const part = chunk.subarray(0, room);
        this.head.push(part);
        this.headLen += part.length;
      }
      const head = Buffer.concat(this.head);
      if (head.includes('%PDF-')) {
        this.magic = true;
        this.head = [];
      } else if (this.headLen >= 1024) {
        return this.refuse(new ApiException('NOT_A_PDF', 'File is not a PDF'), cb);
      }
    }
    cb(null, chunk);
  }

  override _flush(cb: TransformCallback) {
    if (!this.magic) return this.refuse(new ApiException('NOT_A_PDF', 'File is not a PDF'), cb);
    if (this.bytes !== this.expected) {
      return this.refuse(
        new ApiException('VALIDATION_FAILED', 'Body is shorter than Content-Length'),
        cb,
      );
    }
    this.digest = this.hash.digest('hex');
    cb();
  }
}

/** Read and discard a request body, never more than `cap` bytes and never longer than the upload timeout. */
async function drain(body: ReadableStream<Uint8Array> | null, cap: number): Promise<void> {
  if (!body) return;
  const reader = body.getReader();
  const timer = setTimeout(() => void reader.cancel().catch(() => undefined), UPLOAD_TIMEOUT_MS);
  try {
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      n += value.length;
      if (n > cap) {
        await reader.cancel();
        return;
      }
    }
  } catch {
    // A broken client connection while draining is not an error for the caller.
  } finally {
    clearTimeout(timer);
  }
}

/** ASCII-safe attachment filename: the title with everything outside a conservative set replaced. */
export function attachmentName(title: string | null, fingerprint: string): string {
  const base = (title ?? '')
    .normalize('NFKD')
    .replace(/\.pdf$/i, '')
    .replace(/[^A-Za-z0-9 ._-]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[ .]+|[ .]+$/g, '')
    .slice(0, 100)
    .trim();
  return `${base.replace(/^_+$/, '') || fingerprint}.pdf`;
}

function contentDisposition(title: string | null, fingerprint: string): string {
  const ascii = attachmentName(title, fingerprint);
  const clean = (title ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\/:*?<>|]+/g, '_')
    .replace(/\.pdf$/i, '')
    .trim()
    .slice(0, 100);
  const out = `attachment; filename="${ascii}"`;
  if (!clean || /^[\x20-\x7e]*$/.test(clean)) return out;
  const enc = encodeURIComponent(`${clean}.pdf`).replace(
    /['()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `${out}; filename*=UTF-8''${enc}`;
}

export function fileRoutes(
  rt: AuthRuntime,
  db: Database,
  logger: Logger,
  storage: ObjectStorage | undefined,
  opts: { maxConcurrentUploads?: number } = {},
): Hono<AppEnv> {
  const maxConcurrent = opts.maxConcurrentUploads ?? 8;
  let activeUploads = 0;
  const app = new Hono<AppEnv>();
  const bearerOnly = requireBearer(rt);
  const either = requireBearerOrCookie(rt);

  const userId = (c: { get(k: 'auth'): { userId: string } | undefined }): string => {
    const a = c.get('auth');
    if (!a) throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    return a.userId;
  };
  const fpParam = (raw: string | undefined): string => {
    const k = Hex64.safeParse(raw);
    if (!k.success) throw new ApiException('NOT_FOUND', 'Not found');
    return k.data;
  };
  const needStorage = (): ObjectStorage => {
    if (!storage) throw new ApiException('UNAVAILABLE', 'File storage is not configured');
    return storage;
  };

  app.put('/v1/documents/:fp/file', bearerOnly, async (c) => {
    const uid = userId(c);
    const fp = fpParam(c.req.param('fp'));
    const store = needStorage();
    enforce(rt.limiter, `user:file-up:${uid}`, perHour(20));

    // 1. Pre-checks (§6.2): everything that can be refused without reading the body.
    const type = (c.req.header('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
    if (type !== 'application/pdf') {
      throw new ApiException('UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/pdf');
    }
    const rawLength = c.req.header('content-length');
    if (rawLength === undefined) {
      throw new ApiException('VALIDATION_FAILED', 'Content-Length is required', {}, 411);
    }
    const length = /^\d{1,12}$/.test(rawLength) ? Number(rawLength) : 0;
    if (length < 1 || length > LIMITS.maxFileBytes) {
      throw new ApiException('FILE_TOO_LARGE', 'File is larger than 15 MiB', {
        details: { limit: LIMITS.maxFileBytes },
      });
    }
    const rawTitle = c.req.header(FILE_TITLE_HEADER);
    let title: string | null = null;
    if (rawTitle !== undefined) {
      const t = FileTitleHeader.safeParse(rawTitle);
      if (!t.success || t.data.includes('\u0000')) {
        throw new ApiException('VALIDATION_FAILED', 'X-Clavis-Title is invalid', {
          details: { field: FILE_TITLE_HEADER },
        });
      }
      title = t.data.trim() === '' ? null : t.data;
    }
    // Process-wide cap (each upload buffers up to two 5 MiB parts): refuse before reserving anything.
    if (activeUploads >= maxConcurrent) {
      throw new ApiException('UNAVAILABLE', 'Too many uploads in progress', { retryAfterMs: 5000 });
    }
    activeUploads += 1;
    try {
      return await upload(c, { uid, fp, store, length, title });
    } finally {
      activeUploads -= 1;
    }
  });

  const upload = async (
    c: Context<AppEnv>,
    {
      uid,
      fp,
      store,
      length,
      title,
    }: {
      uid: string;
      fp: string;
      store: ObjectStorage;
      length: number;
      title: string | null;
    },
  ): Promise<Response> => {
    // 2. Reserve (transaction A).
    const reservation = await reserveUpload(db, { userId: uid, fingerprint: fp, bytes: length });
    const respond = async (): Promise<Response> => {
      const document = await loadDocumentView(db, uid, fp);
      if (!document) throw new ApiException('NOT_FOUND', 'Not found');
      const body: { document: DocumentView } = { document };
      return c.json(body);
    };
    if (reservation.kind === 'stored') {
      await drain(c.req.raw.body, length);
      return respond();
    }
    const { uploadId, objectKey } = reservation;
    // The daily byte budget is charged only for uploads that will actually run (not dedupes or early refusals).
    try {
      enforce(rt.limiter, `user:file-up-bytes:${uid}`, perDay(300 * MiB), length);
    } catch (err) {
      await failUpload(db, { userId: uid, uploadId, objectKey, bytes: length });
      throw err;
    }

    // 3. Stream into the bucket, counting, hashing and checking the magic bytes on the way.
    const body = c.req.raw.body;
    const guard = new UploadGuard(length);
    const abort = new AbortController();
    let timedOut = false;
    const source = body ? Readable.fromWeb(body as never) : Readable.from([]);
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
      source.destroy(new Error('upload timed out'));
    }, UPLOAD_TIMEOUT_MS);
    pipeline(source, guard, () => undefined);

    const fail = async (reason: ApiException | undefined, err: unknown): Promise<never> => {
      source.destroy();
      guard.destroy();
      try {
        // 6. Release the reservation and queue the (possibly partial) object for deletion.
        await failUpload(db, { userId: uid, uploadId, objectKey, bytes: length });
      } catch (dbErr) {
        // The expiry sweeper (§6.5) releases the reservation and queues the key.
        logger.error({ name: (dbErr as Error).name }, 'failed to release upload reservation');
      }
      await deleteQueuedKeys(db, store, logger, [objectKey]);
      if (reason) throw reason;
      if (timedOut) {
        throw new ApiException('UNAVAILABLE', 'Upload timed out', { retryAfterMs: 5000 });
      }
      logger.warn({ name: (err as Error).name }, 'file upload failed');
      throw new ApiException('UNAVAILABLE', 'File storage is unavailable', { retryAfterMs: 5000 });
    };

    try {
      await store.putStream(objectKey, guard, {
        contentType: 'application/pdf',
        signal: abort.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      return fail(guard.failure, err);
    }
    clearTimeout(timer);

    // 4. Verify: length was checked in the guard's flush; now the hash.
    if (guard.bytes !== length) {
      return fail(
        new ApiException('VALIDATION_FAILED', 'Body length differs from Content-Length'),
        null,
      );
    }
    if (guard.digest !== fp) {
      return fail(
        new ApiException('FINGERPRINT_MISMATCH', 'File hash does not match fingerprint'),
        null,
      );
    }

    // 5. Commit (transaction B).
    let outcome;
    try {
      outcome = await commitUpload(db, {
        userId: uid,
        fingerprint: fp,
        uploadId,
        objectKey,
        bytes: length,
        title,
      });
    } catch (err) {
      return fail(undefined, err);
    }
    if (outcome === 'expired') {
      await deleteQueuedKeys(db, store, logger, [objectKey]);
      throw new ApiException('CONFLICT', 'Upload expired before it finished');
    }
    if (outcome === 'limit-exceeded') {
      await deleteQueuedKeys(db, store, logger, [objectKey]);
      throw new ApiException('LIMIT_EXCEEDED', 'Document limit reached');
    }
    if (outcome === 'already-stored') await deleteQueuedKeys(db, store, logger, [objectKey]);
    logger.info({ route: 'documents/file/put', bytes: length, outcome }, 'file stored');
    return respond();
  };

  app.get('/v1/documents/:fp/file', either, async (c) => {
    // Hono runs this handler for HEAD too (it rewrites HEAD to GET before routing). HEAD answers from the database
    // row alone: no bucket read, and neither the download count nor the byte budget is charged.
    if (c.req.method === 'HEAD') {
      const uid = userId(c);
      const fp = fpParam(c.req.param('fp'));
      enforce(rt.limiter, `user:file-head:${uid}`, perMinute(120));
      const [doc] = await db
        .select({
          title: documents.title,
          bytes: documents.storedBytes,
          state: documents.storageState,
        })
        .from(documents)
        .where(
          and(
            eq(documents.userId, uid),
            eq(documents.fingerprint, fp),
            isNull(documents.deletedAt),
          ),
        )
        .limit(1);
      if (!doc || doc.state !== 'stored' || doc.bytes === null) {
        throw new ApiException('NOT_FOUND', 'Not found');
      }
      return c.body(null, 200, {
        'Content-Type': 'application/pdf',
        'Content-Length': String(doc.bytes),
        'Content-Disposition': contentDisposition(doc.title, fp),
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'private, no-store',
        'Content-Security-Policy': "sandbox; default-src 'none'",
      });
    }
    const uid = userId(c);
    const fp = fpParam(c.req.param('fp'));
    const store = needStorage();
    enforce(rt.limiter, `user:file-dl:${uid}`, perHour(100));
    const [doc] = await db
      .select({
        title: documents.title,
        key: documents.objectKey,
        bytes: documents.storedBytes,
        state: documents.storageState,
      })
      .from(documents)
      .where(
        and(eq(documents.userId, uid), eq(documents.fingerprint, fp), isNull(documents.deletedAt)),
      )
      .limit(1);
    if (!doc || doc.state !== 'stored' || doc.key === null || doc.bytes === null) {
      throw new ApiException('NOT_FOUND', 'Not found');
    }
    enforce(rt.limiter, `user:file-dl-bytes:${uid}`, perDay(GiB), Number(doc.bytes));
    let object;
    try {
      object = await store.getStream(doc.key);
    } catch (err) {
      logger.warn({ route: 'documents/file/get', name: (err as Error).name }, 'bucket read failed');
      throw new ApiException('UNAVAILABLE', 'File storage is unavailable', { retryAfterMs: 5000 });
    }
    if (!object) {
      logger.error({ route: 'documents/file/get' }, 'stored object is missing from the bucket');
      throw new ApiException('NOT_FOUND', 'Not found');
    }
    return c.body(object.stream, 200, {
      'Content-Type': 'application/pdf',
      'Content-Length': String(object.contentLength),
      'Content-Disposition': contentDisposition(doc.title, fp),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
      'Content-Security-Policy': "sandbox; default-src 'none'",
    });
  });

  app.delete('/v1/documents/:fp/file', either, async (c) => {
    const uid = userId(c);
    const fp = fpParam(c.req.param('fp'));
    enforce(rt.limiter, `user:file-rm:${uid}`, perHour(60));
    const r = await removeFile(db, {
      userId: uid,
      fingerprint: fp,
      warn: (msg) => logger.warn({ route: 'documents/file/delete' }, msg),
    });
    if (r.kind === 'not-found') throw new ApiException('NOT_FOUND', 'Not found');
    if (r.kind === 'removed') await deleteQueuedKeys(db, storage, logger, [r.objectKey]);
    return c.body(null, 204);
  });

  return app;
}

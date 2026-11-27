// Account export (docs/clavis-sync-design.md §8.5): a ZIP streamed with yazl, never buffered whole.
//
//   clavis-export.json   built page by page inside ONE read-only REPEATABLE READ transaction, so words, chat,
//                        documents and highlights agree. Memory is bounded by one page: WORD_PAGE words with their
//                        messages (<= 20 x 200 x 4,000 chars) or DOC_PAGE documents with their highlights.
//   pdfs/<fp>.pdf        one object at a time, piped from the bucket; the next is requested only after the previous
//                        ended. An object that has vanished is skipped (never an abort).
//   README.txt
// Entry order: README, PDFs, then the JSON LAST, so `documents[].file` is non-null only for PDFs really written.
//
// Failure model: everything that can fail BEFORE the first byte (listing the bucket, the stored-document read) maps
// to a normal error response (503 UNAVAILABLE). After headers are sent the only honest signal is to abort the
// connection, so any later failure destroys the stream; no error text is ever written into the ZIP.
// Logs carry codes and counts only (§8.6).
import { PassThrough, Readable, Transform, type TransformCallback } from 'node:stream';
import type { ReadableStream as NodeWebStream } from 'node:stream/web';
import { and, asc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { ZipFile } from 'yazl';
import {
  exportPdfPath,
  type ChatView,
  type ExportDocument,
  type ExportWord,
} from '../../../shared/api-contract';
import type { Database } from '../db/client';
import { documents, highlights, savedWords, users, wordChatMessages } from '../db/schema';
import { ApiException } from '../http/errors';
import type { Logger } from '../logger';
import { documentView } from '../documents/view';
import { highlightData, wordData } from '../sync/records';
import type { ObjectStorage } from '../storage/types';

export const WORD_PAGE = 20;
export const DOC_PAGE = 50;
/** Deadline for the JSON phase alone (the snapshot transaction); PDF transfer is bounded by the stall timeout. */
export const JSON_PHASE_DEADLINE_MS = 5 * 60_000;
/** No byte leaving the stream for this long aborts it, so a slow but progressing download is never cut off. */
export const STALL_TIMEOUT_MS = 60_000;
/** Postgres kills the snapshot transaction if it sits idle (a stalled client) for this long. */
const IDLE_IN_TRANSACTION = '60s';
/** Bound on each bucket call that precedes data transfer (list, get). */
export const STORAGE_CALL_MS = 15_000;

const README = `Clavis export
=============

This archive holds everything Clavis Sync stores for your account at the time shown in "exportedAt".
Deleted items are not included.

clavis-export.json
  format, version   Always "clavis-export" and 1.
  exportedAt        ISO 8601 time of the export.
  account           Your email, display name and the time the account was created (epoch milliseconds).
  savedWords        Saved words. Each has its text, language, meaning (title, summary, definition, examples),
                    surrounding context, source (web page or PDF), createdAt and clientModifiedAt (epoch
                    milliseconds), and "messages": the chat you had about that word, oldest first.
  documents         PDF documents. Each has its title, page counts, reading position (lastPage, pageOffset),
                    "highlights" (page, start and end character offsets, color), storage details, and "file":
                    the path of the stored PDF inside this archive, or null when no file is stored.

pdfs/<fingerprint>.pdf
  The stored PDF files. The fingerprint in the name is the SHA-256 of the file's bytes.
`;

class ByteCounter extends Transform {
  bytes = 0;
  constructor(private readonly onProgress: () => void) {
    super();
  }
  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
    this.bytes += chunk.length;
    this.onProgress();
    cb(null, chunk);
  }
}

/**
 * Reject after `ms` so a hung bucket maps to UNAVAILABLE instead of hanging the request. When `p` settles after the
 * deadline already won, `onLate` receives its value so the caller can release it (cancel a stream).
 */
export async function withDeadline<T>(
  p: Promise<T>,
  ms: number,
  onLate?: (value: T) => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  p.then(
    (v) => {
      if (timedOut) onLate?.(v);
    },
    () => undefined, // the loser of the race must not become an unhandled rejection
  );
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error('deadline'));
        }, ms);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export interface StoredPdf {
  fingerprint: string;
  key: string;
}

export interface ExportPlan {
  /** Stored documents whose object exists in the bucket, in fingerprint order. */
  pdfs: StoredPdf[];
  /** Stored documents whose object is gone: exported with `file: null`. */
  missing: number;
}

/**
 * Pre-flight, before any response byte: which stored PDFs exist. One database read plus one bucket listing
 * (a user has at most 2,000 documents), so a missing object is known up front and a bucket outage is a clean 503.
 */
export async function planExport(
  db: Database,
  storage: ObjectStorage | undefined,
  logger: Logger,
  userId: string,
): Promise<ExportPlan> {
  const stored = await db
    .select({ fingerprint: documents.fingerprint, key: documents.objectKey })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        isNull(documents.deletedAt),
        eq(documents.storageState, 'stored'),
      ),
    )
    .orderBy(asc(documents.fingerprint));
  if (stored.length === 0) return { pdfs: [], missing: 0 };
  const unavailable = () =>
    new ApiException('UNAVAILABLE', 'File storage is unavailable', { retryAfterMs: 5000 });
  if (!storage) throw unavailable();
  const present = new Set<string>();
  let stopListing = false; // set when the deadline wins: the iterator stops after its current page
  try {
    await withDeadline(
      (async () => {
        for await (const o of storage.list(`u/${userId}/`)) {
          if (stopListing) break; // leaving the loop closes the iterator
          present.add(o.key);
        }
      })(),
      STORAGE_CALL_MS,
    );
  } catch (err) {
    stopListing = true;
    logger.warn({ route: 'account/export', name: (err as Error).name }, 'bucket listing failed');
    throw unavailable();
  }
  const plan: ExportPlan = { pdfs: [], missing: 0 };
  for (const d of stored) {
    if (d.key !== null && present.has(d.key))
      plan.pdfs.push({ fingerprint: d.fingerprint, key: d.key });
    else {
      plan.missing += 1;
      logger.warn(
        { route: 'account/export', code: 'EXPORT_OBJECT_MISSING' },
        'stored object is missing',
      );
    }
  }
  return plan;
}

/** Write `chunk` to `pt`, waiting for drain; rejects when the stream is closed (client gone, deadline). */
function writer(pt: PassThrough) {
  return async (chunk: string): Promise<void> => {
    if (pt.destroyed) throw new Error('export stream closed');
    if (pt.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const done = (err?: Error) => {
        pt.off('drain', onDrain);
        pt.off('close', onClose);
        if (err) reject(err);
        else resolve();
      };
      const onDrain = () => done();
      const onClose = () => done(new Error('export stream closed'));
      pt.once('drain', onDrain);
      pt.once('close', onClose);
    });
  };
}

/** The JSON body, written incrementally from a consistent snapshot. */
async function writeExportJson(
  db: Database,
  userId: string,
  exportedAt: string,
  included: ReadonlySet<string>,
  write: (chunk: string) => Promise<void>,
): Promise<{ words: number; documents: number }> {
  const counts = { words: 0, documents: 0 };
  await db.transaction(
    async (tx) => {
      // A client that stops reading must not pin this snapshot (and its connection) open.
      await tx.execute(
        sql`SET LOCAL idle_in_transaction_session_timeout = ${sql.raw(`'${IDLE_IN_TRANSACTION}'`)}`,
      );
      const [user] = await tx.select().from(users).where(eq(users.id, userId));
      if (!user) throw new Error('account no longer exists');
      const account = {
        email: user.email,
        displayName: user.displayName,
        createdAt: user.createdAt.getTime(),
      };
      await write(
        `{"format":"clavis-export","version":1,"exportedAt":${JSON.stringify(exportedAt)},` +
          `"account":${JSON.stringify(account)},"savedWords":[`,
      );

      let after = '';
      for (;;) {
        const page = await tx
          .select()
          .from(savedWords)
          .where(
            and(
              eq(savedWords.userId, userId),
              isNull(savedWords.deletedAt),
              ...(after ? [gt(savedWords.wordKey, after)] : []),
            ),
          )
          .orderBy(asc(savedWords.wordKey))
          .limit(WORD_PAGE);
        if (page.length === 0) break;
        const msgs = await tx
          .select()
          .from(wordChatMessages)
          .where(
            and(
              eq(wordChatMessages.userId, userId),
              inArray(
                wordChatMessages.wordKey,
                page.map((w) => w.wordKey),
              ),
            ),
          )
          .orderBy(
            asc(wordChatMessages.wordKey),
            asc(wordChatMessages.createdAt),
            asc(wordChatMessages.id),
          );
        const byWord = new Map<string, ChatView[]>();
        for (const m of msgs) {
          const list = byWord.get(m.wordKey) ?? [];
          list.push({
            id: m.id,
            role: m.role as ChatView['role'],
            content: m.content,
            model: m.model,
            createdAt: m.createdAt.getTime(),
          });
          byWord.set(m.wordKey, list);
        }
        const items = page.map((w): ExportWord => ({
          ...wordData(w),
          key: w.wordKey,
          clientModifiedAt: w.clientModifiedAt.getTime(),
          messages: byWord.get(w.wordKey) ?? [],
        }));
        await write((counts.words > 0 ? ',' : '') + items.map((i) => JSON.stringify(i)).join(','));
        counts.words += page.length;
        after = (page.at(-1) as { wordKey: string }).wordKey;
      }

      await write('],"documents":[');
      after = '';
      for (;;) {
        const page = await tx
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.userId, userId),
              isNull(documents.deletedAt),
              ...(after ? [gt(documents.fingerprint, after)] : []),
            ),
          )
          .orderBy(asc(documents.fingerprint))
          .limit(DOC_PAGE);
        if (page.length === 0) break;
        const hl = await tx
          .select()
          .from(highlights)
          .where(
            and(
              eq(highlights.userId, userId),
              isNull(highlights.deletedAt),
              inArray(
                highlights.fingerprint,
                page.map((d) => d.fingerprint),
              ),
            ),
          )
          .orderBy(asc(highlights.fingerprint), asc(highlights.createdAt), asc(highlights.id));
        const byDoc = new Map<string, ExportDocument['highlights']>();
        for (const h of hl) {
          const list = byDoc.get(h.fingerprint) ?? [];
          list.push({ ...highlightData(h), id: h.id });
          byDoc.set(h.fingerprint, list);
        }
        const items = page.map((d): ExportDocument => {
          const own = byDoc.get(d.fingerprint) ?? [];
          return {
            ...documentView(d, own.length),
            highlights: own,
            file:
              d.storageState === 'stored' && included.has(d.fingerprint)
                ? exportPdfPath(d.fingerprint)
                : null,
          };
        });
        await write(
          (counts.documents > 0 ? ',' : '') + items.map((i) => JSON.stringify(i)).join(','),
        );
        counts.documents += page.length;
        after = (page.at(-1) as { fingerprint: string }).fingerprint;
      }
      await write(']}');
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
  return counts;
}

export interface ExportStream {
  body: ReadableStream<Uint8Array>;
  /** Abort the response (account deleted, shutdown). Idempotent. */
  abort(reason: string): void;
}

/**
 * Start the ZIP. `onClose` runs exactly once when the stream ends for any reason (complete, error, client gone,
 * stall, abort) so the caller can release its in-flight slot.
 */
export function startExport(a: {
  db: Database;
  storage: ObjectStorage | undefined;
  logger: Logger;
  userId: string;
  nowMs: number;
  plan: ExportPlan;
  onClose: () => void;
  stallMs?: number;
  jsonDeadlineMs?: number;
}): ExportStream {
  const { db, storage, logger, userId, plan } = a;
  const mtime = new Date(a.nowMs);
  const zip = new ZipFile();
  const sources = new Set<Readable>();
  let closed = false;
  let completed = false;
  let lastProgress = Date.now();
  let counts = { words: 0, documents: 0 };
  let written = 0;
  let skipped = 0;

  const counter = new ByteCounter(() => {
    lastProgress = Date.now();
  });

  const stallMs = a.stallMs ?? STALL_TIMEOUT_MS;
  const watchdog = setInterval(
    () => {
      if (Date.now() - lastProgress > stallMs) fail(new Error('stalled'), 'EXPORT_STALLED');
    },
    Math.max(10, Math.min(5000, Math.floor(stallMs / 4))),
  );
  watchdog.unref();

  function fail(err: Error, code = 'EXPORT_ABORTED'): void {
    if (closed) return;
    // The response has started: abort it. The reason is logged as a class name or fixed code only.
    logger.warn({ route: 'account/export', code, name: err.name }, 'export aborted');
    counter.destroy(err);
  }
  // yazl and its output are plain streams: an unhandled 'error' would crash the process.
  zip.on('error', (err: Error) => fail(err));
  zip.outputStream.on('error', (err: Error) => fail(err));
  zip.outputStream.once('end', () => {
    completed = true;
  });
  zip.outputStream.pipe(counter);
  counter.on('close', () => {
    closed = true;
    clearInterval(watchdog);
    for (const s of sources) s.destroy();
    (zip.outputStream as PassThrough).destroy();
    logger.info(
      {
        route: 'account/export',
        outcome: completed ? 'complete' : 'aborted',
        bytes: counter.bytes,
        words: counts.words,
        documents: counts.documents,
        pdfs: written,
        missing: plan.missing + skipped,
      },
      'export finished',
    );
    a.onClose();
  });

  /** Resolves when `s` has been fully read by yazl; rejects on a source error or when the export closes. */
  const drained = (s: Readable) =>
    new Promise<void>((resolve, reject) => {
      s.once('end', resolve);
      s.once('error', reject);
      s.once('close', () => (closed ? reject(new Error('closed')) : resolve()));
    });

  const run = async (): Promise<void> => {
    zip.addBuffer(Buffer.from(README), 'README.txt', { mtime });

    // PDFs first, one at a time. An object that vanished since the listing is skipped, never an abort.
    const included = new Set<string>();
    for (const pdf of plan.pdfs) {
      if (closed) return;
      if (!storage) throw new Error('storage missing');
      const object = await withDeadline(storage.getStream(pdf.key), STORAGE_CALL_MS, (late) => {
        void late?.stream.cancel().catch(() => undefined);
      });
      if (!object) {
        skipped += 1;
        logger.warn({ route: 'account/export', code: 'EXPORT_OBJECT_MISSING' }, 'object vanished');
        continue;
      }
      if (closed) {
        void object.stream.cancel().catch(() => undefined);
        return;
      }
      const rs = Readable.fromWeb(object.stream as unknown as NodeWebStream);
      sources.add(rs);
      const done = drained(rs);
      zip.addReadStream(rs, exportPdfPath(pdf.fingerprint), { mtime, compress: false });
      await done;
      sources.delete(rs);
      included.add(pdf.fingerprint);
      written += 1;
    }

    // The JSON last: `file` is set only for PDFs actually in the archive.
    const pt = new PassThrough();
    sources.add(pt);
    zip.addReadStream(pt, 'clavis-export.json', { mtime, compress: true });
    const deadline = setTimeout(
      () => fail(new Error('json deadline'), 'EXPORT_JSON_DEADLINE'),
      a.jsonDeadlineMs ?? JSON_PHASE_DEADLINE_MS,
    );
    deadline.unref();
    try {
      counts = await writeExportJson(db, userId, mtime.toISOString(), included, writer(pt));
    } finally {
      clearTimeout(deadline);
    }
    pt.end();
    zip.end();
  };

  run().catch((err: Error) => fail(err));

  return {
    body: Readable.toWeb(counter) as unknown as ReadableStream<Uint8Array>,
    abort: (reason) => fail(new Error(reason), 'EXPORT_ABORTED'),
  };
}

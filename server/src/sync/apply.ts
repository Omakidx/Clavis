// Applies one push change inside the caller's transaction (docs/clavis-sync-design.md §4.3-§4.5).
//
// Preconditions (the caller guarantees them): the user row is locked (lockUserForSeq), so live-count checks and
// seq allocation are serialised per user, and `ctx.tx` is a savepoint-capable transaction. Every statement is scoped
// by `ctx.userId`, which comes from the access token, never from the client.
//
// Rules implemented here
//   - LWW on clientModifiedAt (clamped to now + 60 s); equal or older is `stale` and carries the server record.
//   - A tombstone wins only when newer; a newer upsert resurrects it.
//   - Soft delete nulls the content columns. Columns that are NOT NULL in the schema hold neutral placeholders
//     (word: text '-', meaning {}; highlight: page 1, range 0..1, yellow) that are never served: a tombstone is
//     delivered as `deleted: true, data: null`.
//   - Word delete hard-deletes the word's messages. Document delete tombstones every live highlight (one seq each)
//     and removes a stored file (quota refunded, object deletion queued) per §6.4.
//   - A highlight upsert for an unknown or tombstoned document creates or resurrects a stub with `title = null`.
//   - Live-count limits are checked here, under the user lock.
import { and, count, eq, isNull, sql } from 'drizzle-orm';
import {
  LIMITS,
  wordKey as computeWordKey,
  type PushChange,
  type PushResult,
  type ServerChange,
  type WordData,
} from '../../../shared/api-contract';
import { documents, highlights, savedWords, wordChatMessages } from '../db/schema';
import {
  enqueueObjectDeletion,
  releaseStoredBytes,
  type SeqAllocator,
  type Tx,
} from '../db/queries';
import {
  documentChange,
  highlightChange,
  wordChange,
  type DocumentRow,
  type HighlightRow,
  type WordRow,
} from './records';

export const FUTURE_SKEW_MS = 60_000;
/** Lowest accepted clientModifiedAt (2020-01-01); also the `clientModifiedAt` of a created document stub. */
export const MIN_CLIENT_MS = 1_577_836_800_000;

export interface ResettableSeq extends SeqAllocator {
  /** Give back seqs allocated after `to` (an item rolled back to its savepoint). */
  reset(to: bigint): void;
}

export function createResettableSeq(current: bigint): ResettableSeq {
  let last = current;
  return {
    next() {
      last += 1n;
      return last;
    },
    last: () => last,
    used: () => last > current,
    reset(to) {
      last = to;
    },
  };
}

export interface ApplyCtx {
  tx: Tx;
  userId: string;
  seq: ResettableSeq;
  nowMs: number;
  warn?: ((msg: string) => void) | undefined;
  /** Receives the object key of every stored file a tombstone removed (for the inline delete after commit). */
  removedKeys?: string[] | undefined;
}

export type Outcome =
  | { status: 'applied'; seq: bigint }
  | { status: 'stale'; current: ServerChange }
  | { status: 'rejected'; code: NonNullable<PushResult['code']> };

const applied = (seq: bigint): Outcome => ({ status: 'applied', seq });
const stale = (current: ServerChange): Outcome => ({ status: 'stale', current });
const rejected = (code: NonNullable<PushResult['code']>): Outcome => ({ status: 'rejected', code });

/** drizzle expands a JS array into a row constructor, so build typed ARRAY[...] literals explicitly. */
const uuidArray = (v: string[]) =>
  sql`ARRAY[${sql.join(
    v.map((x) => sql`${x}::uuid`),
    sql`, `,
  )}]::uuid[]`;
const bigintArray = (v: string[]) =>
  sql`ARRAY[${sql.join(
    v.map((x) => sql`${x}::bigint`),
    sql`, `,
  )}]::bigint[]`;

const clamp = (ctx: ApplyCtx, ms: number) => Math.min(ms, ctx.nowMs + FUTURE_SKEW_MS);

async function countRows(q: Promise<{ n: number }[]>): Promise<number> {
  return Number((await q)[0]?.n ?? 0);
}

// ---------------------------------------------------------------- words

/** `origin + path` of an http(s) URL (schema comment: no query, no fragment); undefined for anything else. */
export function sanitizeSourceUrl(raw: string): string | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return `${u.origin}${u.pathname}`;
  } catch {
    return undefined;
  }
}

function wordValues(d: WordData, cma: Date, seq: bigint, sourceUrl: string | null) {
  const pdf = d.source.kind === 'pdf' ? d.source : undefined;
  return {
    text: d.text,
    language: d.language ?? null,
    meaning: d.meaning,
    contextBefore: d.contextBefore ?? null,
    contextAfter: d.contextAfter ?? null,
    sourceKind: d.source.kind,
    sourceUrl,
    sourceTitle: d.source.title,
    pdfFingerprint: pdf ? pdf.fingerprint : null,
    pdfPage: pdf ? pdf.page : null,
    createdAt: new Date(d.createdAt),
    clientModifiedAt: cma,
    serverModifiedAt: sql`now()`,
    seq,
    deletedAt: null,
  };
}

const getWord = async (ctx: ApplyCtx, key: string): Promise<WordRow | undefined> =>
  (
    await ctx.tx
      .select()
      .from(savedWords)
      .where(and(eq(savedWords.userId, ctx.userId), eq(savedWords.wordKey, key)))
      .limit(1)
  )[0];

async function upsertWord(
  ctx: ApplyCtx,
  c: Extract<PushChange, { kind: 'word'; op: 'upsert' }>,
): Promise<Outcome> {
  if ((await computeWordKey(c.data.text)) !== c.key) return rejected('VALIDATION_FAILED');
  let sourceUrl: string | null = null;
  if (c.data.source.kind === 'webpage' && c.data.source.url !== null) {
    const clean = sanitizeSourceUrl(c.data.source.url);
    if (clean === undefined) return rejected('VALIDATION_FAILED');
    sourceUrl = clean;
  }
  const cma = clamp(ctx, c.clientModifiedAt);
  const row = await getWord(ctx, c.key);
  if (row && cma <= row.clientModifiedAt.getTime()) return stale(wordChange(row));
  if (!row || row.deletedAt) {
    const n = await countRows(
      ctx.tx
        .select({ n: count() })
        .from(savedWords)
        .where(and(eq(savedWords.userId, ctx.userId), isNull(savedWords.deletedAt))),
    );
    if (n >= LIMITS.maxWords) return rejected('LIMIT_EXCEEDED');
  }
  const seq = ctx.seq.next();
  const values = wordValues(c.data, new Date(cma), seq, sourceUrl);
  if (row) {
    await ctx.tx
      .update(savedWords)
      .set(values)
      .where(and(eq(savedWords.userId, ctx.userId), eq(savedWords.wordKey, c.key)));
  } else {
    await ctx.tx.insert(savedWords).values({ userId: ctx.userId, wordKey: c.key, ...values });
  }
  return applied(seq);
}

/** Tombstone a word (insert one when it was never seen) and hard-delete its messages. */
export async function writeWordTombstone(
  ctx: ApplyCtx,
  key: string,
  cma: number,
  exists: boolean,
): Promise<bigint> {
  const seq = ctx.seq.next();
  const nulled = {
    text: '-',
    language: null,
    meaning: {},
    contextBefore: null,
    contextAfter: null,
    sourceKind: 'webpage',
    sourceUrl: null,
    sourceTitle: null,
    pdfFingerprint: null,
    pdfPage: null,
    clientModifiedAt: new Date(cma),
    serverModifiedAt: sql`now()`,
    seq,
    deletedAt: new Date(ctx.nowMs),
  };
  if (exists) {
    await ctx.tx
      .update(savedWords)
      .set(nulled)
      .where(and(eq(savedWords.userId, ctx.userId), eq(savedWords.wordKey, key)));
  } else {
    await ctx.tx
      .insert(savedWords)
      .values({ userId: ctx.userId, wordKey: key, createdAt: new Date(cma), ...nulled });
  }
  await ctx.tx
    .delete(wordChatMessages)
    .where(and(eq(wordChatMessages.userId, ctx.userId), eq(wordChatMessages.wordKey, key)));
  return seq;
}

async function deleteWord(
  ctx: ApplyCtx,
  c: Extract<PushChange, { kind: 'word'; op: 'delete' }>,
): Promise<Outcome> {
  const cma = clamp(ctx, c.clientModifiedAt);
  const row = await getWord(ctx, c.key);
  if (row && cma <= row.clientModifiedAt.getTime()) return stale(wordChange(row));
  return applied(await writeWordTombstone(ctx, c.key, cma, row !== undefined));
}

// ---------------------------------------------------------------- chat

async function insertChat(
  ctx: ApplyCtx,
  c: Extract<PushChange, { kind: 'chat' }>,
): Promise<Outcome> {
  const [existing] = await ctx.tx
    .select()
    .from(wordChatMessages)
    .where(and(eq(wordChatMessages.userId, ctx.userId), eq(wordChatMessages.id, c.id)))
    .limit(1);
  if (existing) {
    const d = c.data;
    const same =
      existing.wordKey === d.wordKey &&
      existing.role === d.role &&
      existing.content === d.content &&
      (existing.model ?? null) === (d.model ?? null) &&
      existing.createdAt.getTime() === d.createdAt;
    return same ? applied(existing.seq) : rejected('CONFLICT');
  }
  const word = await getWord(ctx, c.data.wordKey);
  if (!word || word.deletedAt) return rejected('NOT_FOUND');
  const n = await countRows(
    ctx.tx
      .select({ n: count() })
      .from(wordChatMessages)
      .where(
        and(eq(wordChatMessages.userId, ctx.userId), eq(wordChatMessages.wordKey, c.data.wordKey)),
      ),
  );
  if (n >= LIMITS.maxMessagesPerWord) return rejected('LIMIT_EXCEEDED');
  const seq = ctx.seq.next();
  await ctx.tx.insert(wordChatMessages).values({
    id: c.id,
    userId: ctx.userId,
    wordKey: c.data.wordKey,
    role: c.data.role,
    content: c.data.content,
    model: c.data.model ?? null,
    createdAt: new Date(c.data.createdAt),
    seq,
  });
  return applied(seq);
}

// ---------------------------------------------------------------- documents

const getDocument = async (ctx: ApplyCtx, fp: string): Promise<DocumentRow | undefined> =>
  (
    await ctx.tx
      .select()
      .from(documents)
      .where(and(eq(documents.userId, ctx.userId), eq(documents.fingerprint, fp)))
      .limit(1)
  )[0];

const liveDocumentCount = (ctx: ApplyCtx) =>
  countRows(
    ctx.tx
      .select({ n: count() })
      .from(documents)
      .where(and(eq(documents.userId, ctx.userId), isNull(documents.deletedAt))),
  );

async function upsertDocument(
  ctx: ApplyCtx,
  c: Extract<PushChange, { kind: 'document'; op: 'upsert' }>,
): Promise<Outcome> {
  const cma = clamp(ctx, c.clientModifiedAt);
  const row = await getDocument(ctx, c.key);
  if (row && cma <= row.clientModifiedAt.getTime()) return stale(documentChange(row));
  if ((!row || row.deletedAt) && (await liveDocumentCount(ctx)) >= LIMITS.maxDocuments) {
    return rejected('LIMIT_EXCEEDED');
  }
  const seq = ctx.seq.next();
  // Storage columns are server-owned: never part of this write.
  const values = {
    title: c.data.title,
    pageCount: c.data.pageCount,
    lastPage: c.data.lastPage,
    pageOffset: c.data.pageOffset,
    fileBytes: c.data.fileBytes === null ? null : BigInt(c.data.fileBytes),
    clientModifiedAt: new Date(cma),
    serverModifiedAt: sql`now()`,
    seq,
    deletedAt: null,
  };
  if (row) {
    await ctx.tx
      .update(documents)
      .set(values)
      .where(and(eq(documents.userId, ctx.userId), eq(documents.fingerprint, c.key)));
  } else {
    await ctx.tx.insert(documents).values({ userId: ctx.userId, fingerprint: c.key, ...values });
  }
  return applied(seq);
}

/** Tombstone a document and its live highlights, and remove a stored file (§6.4). */
export async function writeDocumentTombstone(
  ctx: ApplyCtx,
  fp: string,
  cma: number,
  row: DocumentRow | undefined,
): Promise<bigint> {
  const live = await ctx.tx
    .select({ id: highlights.id })
    .from(highlights)
    .where(
      and(
        eq(highlights.userId, ctx.userId),
        eq(highlights.fingerprint, fp),
        isNull(highlights.deletedAt),
      ),
    )
    .orderBy(highlights.id);
  if (live.length > 0) {
    const ids = live.map((h) => h.id);
    const seqs = ids.map(() => ctx.seq.next().toString());
    await ctx.tx.execute(sql`
      UPDATE highlights h
      SET seq = v.seq, deleted_at = ${new Date(ctx.nowMs)},
          client_modified_at = GREATEST(h.client_modified_at, ${new Date(cma)}),
          server_modified_at = now()
      FROM unnest(${uuidArray(ids)}, ${bigintArray(seqs)}) AS v(id, seq)
      WHERE h.user_id = ${ctx.userId} AND h.id = v.id`);
  }
  if (row && row.storageState === 'stored' && row.objectKey !== null && row.storedBytes !== null) {
    if (!(await releaseStoredBytes(ctx.tx, ctx.userId, row.storedBytes))) {
      // Accounting drift: used bytes were lower than this file's size. The delete still proceeds.
      ctx.warn?.('quota refund skipped: storage_used_bytes below stored file size');
    }
    await enqueueObjectDeletion(ctx.tx, { key: row.objectKey });
    ctx.removedKeys?.push(row.objectKey);
  }
  const seq = ctx.seq.next();
  const nulled = {
    title: null,
    pageCount: null,
    lastPage: null,
    pageOffset: null,
    fileBytes: null,
    clientModifiedAt: new Date(cma),
    serverModifiedAt: sql`now()`,
    seq,
    deletedAt: new Date(ctx.nowMs),
    storageState: 'none',
    objectKey: null,
    storedBytes: null,
    storedAt: null,
  };
  if (row) {
    await ctx.tx
      .update(documents)
      .set(nulled)
      .where(and(eq(documents.userId, ctx.userId), eq(documents.fingerprint, fp)));
  } else {
    await ctx.tx.insert(documents).values({ userId: ctx.userId, fingerprint: fp, ...nulled });
  }
  return seq;
}

async function deleteDocument(
  ctx: ApplyCtx,
  c: Extract<PushChange, { kind: 'document'; op: 'delete' }>,
): Promise<Outcome> {
  const cma = clamp(ctx, c.clientModifiedAt);
  const row = await getDocument(ctx, c.key);
  if (row && cma <= row.clientModifiedAt.getTime()) return stale(documentChange(row));
  return applied(await writeDocumentTombstone(ctx, c.key, cma, row));
}

// ---------------------------------------------------------------- highlights

const getHighlight = async (ctx: ApplyCtx, id: string): Promise<HighlightRow | undefined> =>
  (
    await ctx.tx
      .select()
      .from(highlights)
      .where(and(eq(highlights.userId, ctx.userId), eq(highlights.id, id)))
      .limit(1)
  )[0];

/** Make sure the document is live, creating or resurrecting a title-less stub. false = document limit. */
async function ensureLiveDocument(ctx: ApplyCtx, fp: string): Promise<boolean> {
  const doc = await getDocument(ctx, fp);
  if (doc && !doc.deletedAt) return true;
  if ((await liveDocumentCount(ctx)) >= LIMITS.maxDocuments) return false;
  const seq = ctx.seq.next();
  const stub = {
    title: null,
    pageCount: null,
    lastPage: null,
    pageOffset: null,
    fileBytes: null,
    serverModifiedAt: sql`now()`,
    seq,
    deletedAt: null,
  };
  if (doc) {
    // The tombstone's clientModifiedAt stays, so a real upsert must still be newer than the delete.
    await ctx.tx
      .update(documents)
      .set(stub)
      .where(and(eq(documents.userId, ctx.userId), eq(documents.fingerprint, fp)));
  } else {
    // The lowest valid time: any real document upsert (always newer) fills the stub in.
    await ctx.tx.insert(documents).values({
      userId: ctx.userId,
      fingerprint: fp,
      clientModifiedAt: new Date(MIN_CLIENT_MS),
      ...stub,
    });
  }
  return true;
}

async function upsertHighlight(
  ctx: ApplyCtx,
  c: Extract<PushChange, { kind: 'highlight'; op: 'upsert' }>,
): Promise<Outcome> {
  const cma = clamp(ctx, c.clientModifiedAt);
  const row = await getHighlight(ctx, c.id);
  if (row && row.fingerprint !== c.data.fingerprint) return rejected('CONFLICT');
  if (row && cma <= row.clientModifiedAt.getTime()) return stale(highlightChange(row));
  if (!row || row.deletedAt) {
    const n = await countRows(
      ctx.tx
        .select({ n: count() })
        .from(highlights)
        .where(
          and(
            eq(highlights.userId, ctx.userId),
            eq(highlights.fingerprint, c.data.fingerprint),
            isNull(highlights.deletedAt),
          ),
        ),
    );
    if (n >= LIMITS.maxHighlightsPerDocument) return rejected('LIMIT_EXCEEDED');
  }
  if (!(await ensureLiveDocument(ctx, c.data.fingerprint))) return rejected('LIMIT_EXCEEDED');
  const seq = ctx.seq.next();
  const values = {
    fingerprint: c.data.fingerprint,
    page: c.data.page,
    startOffset: c.data.start,
    endOffset: c.data.end,
    color: c.data.color,
    createdAt: new Date(c.data.createdAt),
    clientModifiedAt: new Date(cma),
    serverModifiedAt: sql`now()`,
    seq,
    deletedAt: null,
  };
  if (row) {
    await ctx.tx
      .update(highlights)
      .set(values)
      .where(and(eq(highlights.userId, ctx.userId), eq(highlights.id, c.id)));
  } else {
    await ctx.tx.insert(highlights).values({ userId: ctx.userId, id: c.id, ...values });
  }
  return applied(seq);
}

async function deleteHighlight(
  ctx: ApplyCtx,
  c: Extract<PushChange, { kind: 'highlight'; op: 'delete' }>,
): Promise<Outcome> {
  const cma = clamp(ctx, c.clientModifiedAt);
  const row = await getHighlight(ctx, c.id);
  if (row && row.fingerprint !== c.fingerprint) return rejected('CONFLICT');
  if (row && cma <= row.clientModifiedAt.getTime()) return stale(highlightChange(row));
  // The composite FK needs the document row. A delete for a highlight of a document the server never saw has
  // nothing to tombstone against.
  if (!row && !(await getDocument(ctx, c.fingerprint))) return rejected('NOT_FOUND');
  const seq = ctx.seq.next();
  const nulled = {
    clientModifiedAt: new Date(cma),
    serverModifiedAt: sql`now()`,
    seq,
    deletedAt: new Date(ctx.nowMs),
  };
  if (row) {
    await ctx.tx
      .update(highlights)
      .set(nulled)
      .where(and(eq(highlights.userId, ctx.userId), eq(highlights.id, c.id)));
  } else {
    await ctx.tx.insert(highlights).values({
      userId: ctx.userId,
      id: c.id,
      fingerprint: c.fingerprint,
      // Neutral placeholders (NOT NULL columns); a tombstone is served without data.
      page: 1,
      startOffset: 0,
      endOffset: 1,
      color: 'yellow',
      createdAt: new Date(cma),
      ...nulled,
    });
  }
  return applied(seq);
}

// ---------------------------------------------------------------- dispatch

export function applyChange(ctx: ApplyCtx, c: PushChange): Promise<Outcome> {
  switch (c.kind) {
    case 'word':
      return c.op === 'upsert' ? upsertWord(ctx, c) : deleteWord(ctx, c);
    case 'chat':
      return insertChat(ctx, c);
    case 'document':
      return c.op === 'upsert' ? upsertDocument(ctx, c) : deleteDocument(ctx, c);
    case 'highlight':
      return c.op === 'upsert' ? upsertHighlight(ctx, c) : deleteHighlight(ctx, c);
  }
}

export { getDocument, getWord };

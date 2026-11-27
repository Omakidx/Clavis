import type { PushChange, PushResult, ServerChange } from '../../shared/api-contract/sync';
import {
  STORE,
  getAll,
  request,
  transact,
  type LocalChatMessage,
  type LocalDocument,
  type LocalHighlight,
  type LocalWord,
  type StoreName,
  type SyncFields,
} from '../data/db';
import type { Candidate, SyncKind } from './payload';

/**
 * The sync engine's view of IndexedDB (docs/clavis-sync-design.md 4.6, 4.7): collecting dirty
 * records, applying push results and pulled changes, and the first sign-in / sign-out conversions.
 * Every function is one transaction (or a few), so a page's concurrent edit either lands before
 * (and is seen) or after (and bumps `rev`, which keeps its `dirty`).
 */

const STORE_OF: Record<SyncKind, StoreName> = {
  document: STORE.documents,
  highlight: STORE.highlights,
  word: STORE.words,
  chat: STORE.chat,
};
const KEY_OF = {
  document: (r: LocalDocument) => r.fingerprint,
  highlight: (r: LocalHighlight) => r.id,
  word: (r: LocalWord) => r.wordKey,
  chat: (r: LocalChatMessage) => r.id,
} as const;
/** Push order: parents before children (documents, highlights, words, chat). */
const ORDER: readonly SyncKind[] = ['document', 'highlight', 'word', 'chat'];
const SYNCED_STORES = [STORE.documents, STORE.highlights, STORE.words, STORE.chat] as const;

type AnyRecord = SyncFields & Record<string, unknown>;

/** How many records wait for a push. */
export async function countPending(): Promise<number> {
  return transact(SYNCED_STORES, 'readonly', async (tx) => {
    let total = 0;
    for (const name of SYNCED_STORES) {
      total += await request(tx.objectStore(name).index('byDirty').count(1));
    }
    return total;
  });
}

/** Up to `max` dirty records, documents first, then highlights, words and chat. */
export async function collectBatch(max: number): Promise<Candidate[]> {
  return transact(SYNCED_STORES, 'readonly', async (tx) => {
    const out: Candidate[] = [];
    for (const kind of ORDER) {
      if (out.length >= max) break;
      const rows = await request(
        tx
          .objectStore(STORE_OF[kind])
          .index('byDirty')
          .getAll(1, max - out.length),
      );
      for (const record of rows as AnyRecord[]) {
        out.push({
          kind,
          key: (KEY_OF[kind] as (r: never) => string)(record as never),
          rev: record.rev,
          record,
        } as unknown as Candidate);
      }
    }
    return out;
  });
}

export interface PushOutcome {
  /** Records whose state changed (applied, adopted, dropped or refused). */
  progress: number;
  /** Refused for good and kept locally. */
  rejected: number;
}

async function readRecord(tx: IDBTransaction, kind: SyncKind, key: string) {
  return request<AnyRecord | undefined>(tx.objectStore(STORE_OF[kind]).get(key) as IDBRequest);
}

/**
 * Apply the server's answers to a pushed batch. `candidates[i]` is `changes[i]`'s record.
 * `dirty` is cleared only if `rev` is unchanged since the batch was collected (design 4.1).
 */
export async function applyPushResults(
  candidates: readonly Candidate[],
  results: readonly PushResult[],
  touched: Set<StoreName>,
): Promise<PushOutcome> {
  const byIndex = new Map(results.map((r) => [r.index, r]));
  const outcome: PushOutcome = { progress: 0, rejected: 0 };
  await transact(SYNCED_STORES, 'readwrite', async (tx) => {
    for (const [index, candidate] of candidates.entries()) {
      const result = byIndex.get(index);
      if (result === undefined) continue;
      const name = STORE_OF[candidate.kind];
      const store = tx.objectStore(name);
      const record = await readRecord(tx, candidate.kind, candidate.key);
      if (record === undefined) {
        outcome.progress += 1;
        continue;
      }
      const unchanged = record.rev === candidate.rev;
      if (result.status === 'applied') {
        const seq = result.seq === undefined ? record.seq : Number(result.seq);
        if (!unchanged) await request(store.put({ ...record, seq }));
        else if (record.deleted === 1) await request(store.delete(candidate.key));
        else await request(store.put({ ...record, seq, dirty: 0 }));
        outcome.progress += 1;
      } else if (result.status === 'stale') {
        if (result.current === undefined || result.current.kind !== candidate.kind) {
          if (unchanged) {
            await request(store.put({ ...record, dirty: 0 }));
            outcome.rejected += 1;
            outcome.progress += 1;
          }
        } else if (unchanged) {
          await applyServerChange(tx, result.current, newPullContext(), true);
          touched.add(name);
          outcome.progress += 1;
        }
        // Edited since the push: leave it dirty, the next push lets last-writer-wins decide.
      } else if (unchanged) {
        if (result.code === 'NOT_FOUND') {
          // The server never had it (a message whose word is gone): drop it.
          await request(store.delete(candidate.key));
        } else {
          // Refused for good, LIMIT_EXCEEDED included: keep it on this device only, so a user over
          // a limit never loses saved data. `seq` stays as it was (null), and a later edit marks it
          // dirty again and retries.
          await request(store.put({ ...record, dirty: 0 }));
          outcome.rejected += 1;
        }
        touched.add(name);
        outcome.progress += 1;
      }
    }
  });
  return outcome;
}

/** Keep a record the schema refuses (it can never be pushed): clear `dirty` and count it. */
export async function markUnpushable(candidates: readonly Candidate[]): Promise<void> {
  await transact(SYNCED_STORES, 'readwrite', async (tx) => {
    for (const candidate of candidates) {
      const record = await readRecord(tx, candidate.kind, candidate.key);
      if (record !== undefined && record.rev === candidate.rev) {
        await request(tx.objectStore(STORE_OF[candidate.kind]).put({ ...record, dirty: 0 }));
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Pull
// ---------------------------------------------------------------------------

export interface PullContext {
  touched: Set<StoreName>;
  /** Keys the server listed (full resync step 2). */
  seen: Record<SyncKind, Set<string>>;
  seenChat: Set<string>;
  /** Live words that came back where the device knew none: wordKey -> word seq. */
  resurrected: Map<string, number>;
  sawChildren: boolean;
}

export function newPullContext(): PullContext {
  return {
    touched: new Set(),
    seen: { document: new Set(), highlight: new Set(), word: new Set(), chat: new Set() },
    seenChat: new Set(),
    resurrected: new Map(),
    sawChildren: false,
  };
}

const wordRange = (key: string): IDBKeyRange =>
  IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]);

/** Local newer-and-dirty wins until it is pushed (design 4.6). `force` is a `stale` answer. */
const keepsLocal = (local: SyncFields | undefined, theirs: number, force: boolean): boolean =>
  !force && local !== undefined && local.dirty === 1 && local.clientModifiedAt > theirs;

async function applyServerChange(
  tx: IDBTransaction,
  change: ServerChange,
  ctx: PullContext,
  force = false,
): Promise<void> {
  const seq = Number(change.seq);
  switch (change.kind) {
    case 'chat': {
      ctx.seen.chat.add(change.id);
      ctx.seenChat.add(change.id);
      ctx.sawChildren = true;
      // Children may arrive before their word: never dropped here (design 4.6).
      const record: LocalChatMessage = {
        ...change.data,
        id: change.id,
        clientModifiedAt: change.data.createdAt,
        seq,
        dirty: 0,
        rev: 1,
        deleted: 0,
      };
      const store = tx.objectStore(STORE.chat);
      const local = await request<LocalChatMessage | undefined>(store.get(change.id));
      await request(store.put({ ...record, rev: (local?.rev ?? 0) + 1 }));
      ctx.touched.add(STORE.chat);
      return;
    }
    case 'word': {
      ctx.seen.word.add(change.key);
      const words = tx.objectStore(STORE.words);
      const local = await request<LocalWord | undefined>(words.get(change.key));
      if (keepsLocal(local, change.clientModifiedAt, force)) return;
      if (change.deleted || change.data === null) {
        if (local !== undefined) await request(words.delete(change.key));
        // The server removed the word's messages with it.
        const chat = tx.objectStore(STORE.chat);
        const ids = await request(chat.index('byWord').getAllKeys(wordRange(change.key)));
        await Promise.all(ids.map((id) => request(chat.delete(id))));
        ctx.touched.add(STORE.words).add(STORE.chat);
        return;
      }
      if (local === undefined || local.deleted === 1) ctx.resurrected.set(change.key, seq);
      await request(
        words.put({
          ...change.data,
          wordKey: change.key,
          clientModifiedAt: change.clientModifiedAt,
          seq,
          dirty: 0,
          rev: (local?.rev ?? 0) + 1,
          deleted: 0,
        } satisfies LocalWord),
      );
      ctx.touched.add(STORE.words);
      return;
    }
    case 'document': {
      ctx.seen.document.add(change.key);
      const documents = tx.objectStore(STORE.documents);
      const local = await request<LocalDocument | undefined>(documents.get(change.key));
      if (keepsLocal(local, change.clientModifiedAt, force)) return;
      if (change.deleted || change.data === null) {
        if (local !== undefined) await request(documents.delete(change.key));
        const marks = tx.objectStore(STORE.highlights);
        const all = await getAll<LocalHighlight>(marks.index('byDoc'), change.key);
        // Marks edited here since stay: they push and bring the document back (design 4.4).
        for (const mark of all) if (mark.dirty === 0) await request(marks.delete(mark.id));
        ctx.touched.add(STORE.documents).add(STORE.highlights);
        return;
      }
      await request(
        documents.put({
          ...change.data,
          fingerprint: change.key,
          storageState: change.storage.state,
          clientModifiedAt: change.clientModifiedAt,
          seq,
          dirty: 0,
          rev: (local?.rev ?? 0) + 1,
          deleted: 0,
        } satisfies LocalDocument),
      );
      ctx.touched.add(STORE.documents);
      return;
    }
    case 'highlight': {
      ctx.seen.highlight.add(change.id);
      ctx.sawChildren = true;
      const marks = tx.objectStore(STORE.highlights);
      const local = await request<LocalHighlight | undefined>(marks.get(change.id));
      if (keepsLocal(local, change.clientModifiedAt, force)) return;
      if (change.deleted || change.data === null) {
        if (local !== undefined) await request(marks.delete(change.id));
        ctx.touched.add(STORE.highlights);
        return;
      }
      await request(
        marks.put({
          ...change.data,
          id: change.id,
          clientModifiedAt: change.clientModifiedAt,
          seq,
          dirty: 0,
          rev: (local?.rev ?? 0) + 1,
          deleted: 0,
        } satisfies LocalHighlight),
      );
      ctx.touched.add(STORE.highlights);
      return;
    }
  }
}

/** Apply one page of a pull in one transaction, in the server's order. */
export async function applyPulled(
  changes: readonly ServerChange[],
  ctx: PullContext,
): Promise<void> {
  await transact(SYNCED_STORES, 'readwrite', async (tx) => {
    for (const change of changes) await applyServerChange(tx, change, ctx);
  });
}

/**
 * After the LAST page of a pull (`hasMore = false`), never before: messages and marks whose parent
 * has not arrived are kept until then (design 4.6).
 */
export async function reconcile(ctx: PullContext): Promise<void> {
  if (!ctx.sawChildren && ctx.resurrected.size === 0) return;
  await transact(SYNCED_STORES, 'readwrite', async (tx) => {
    const words = tx.objectStore(STORE.words);
    const chat = tx.objectStore(STORE.chat);
    // A word that came back (deleted and saved again elsewhere): its old messages are gone on the
    // server, which does not say so. Drop those not seen in this pull.
    for (const [key, wordSeq] of ctx.resurrected) {
      const messages = await getAll<LocalChatMessage>(chat.index('byWord'), wordRange(key));
      for (const m of messages) {
        if (m.dirty === 0 && m.seq !== null && m.seq <= wordSeq && !ctx.seenChat.has(m.id)) {
          await request(chat.delete(m.id));
          ctx.touched.add(STORE.chat);
        }
      }
    }
    // Messages without any word row cannot be shown or pushed.
    const wordKeys = new Set((await request(words.getAllKeys())) as string[]);
    for (const m of await getAll<LocalChatMessage>(chat)) {
      if (m.dirty === 0 && !wordKeys.has(m.wordKey)) {
        await request(chat.delete(m.id));
        ctx.touched.add(STORE.chat);
      }
    }
    // Marks without a document row get a stub so the library lists them.
    const documents = tx.objectStore(STORE.documents);
    const docKeys = new Set((await request(documents.getAllKeys())) as string[]);
    const newest = new Map<string, number>();
    for (const h of await getAll<LocalHighlight>(tx.objectStore(STORE.highlights))) {
      if (!docKeys.has(h.fingerprint) && h.deleted !== 1) {
        newest.set(h.fingerprint, Math.max(newest.get(h.fingerprint) ?? 0, h.clientModifiedAt));
      }
    }
    for (const [fingerprint, at] of newest) {
      await request(
        documents.put({
          fingerprint,
          title: null,
          pageCount: null,
          lastPage: null,
          pageOffset: null,
          fileBytes: null,
          storageState: 'none',
          clientModifiedAt: at,
          seq: null,
          dirty: 0,
          rev: 1,
          deleted: 0,
        } satisfies LocalDocument),
      );
      ctx.touched.add(STORE.documents);
    }
  });
}

/** Full resync step 2: drop records that were synced before, are clean, and the server no longer lists. */
export async function sweepUnseen(ctx: PullContext): Promise<void> {
  await transact(SYNCED_STORES, 'readwrite', async (tx) => {
    for (const kind of ORDER) {
      const store = tx.objectStore(STORE_OF[kind]);
      for (const record of await getAll<AnyRecord>(store)) {
        const key = (KEY_OF[kind] as (r: never) => string)(record as never);
        if (record.dirty === 0 && record.seq !== null && !ctx.seen[kind].has(key)) {
          await request(store.delete(key));
          ctx.touched.add(STORE_OF[kind]);
        }
      }
    }
  });
}

// ---------------------------------------------------------------------------
// Sign-in and sign-out conversions (design 4.7)
// ---------------------------------------------------------------------------

/** First sign-in: every record is new to the account. Keeps `clientModifiedAt`. */
export async function markAllDirty(): Promise<void> {
  await transact(SYNCED_STORES, 'readwrite', async (tx) => {
    for (const name of SYNCED_STORES) {
      const store = tx.objectStore(name);
      for (const record of await getAll<AnyRecord>(store)) {
        if (record.deleted === 1) continue;
        await request(store.put({ ...record, dirty: 1, seq: null, rev: record.rev + 1 }));
      }
    }
  });
}

/** Sign out, keeping a copy: unbound local data. Tombstones go, nothing is dirty. */
export async function detachForKeep(): Promise<void> {
  await transact(SYNCED_STORES, 'readwrite', async (tx) => {
    for (const name of SYNCED_STORES) {
      const store = tx.objectStore(name);
      for (const record of await getAll<AnyRecord>(store)) {
        const key = store.keyPath as string;
        if (record.deleted === 1) await request(store.delete(record[key] as string));
        else await request(store.put({ ...record, dirty: 0, seq: null }));
      }
    }
  });
}

/** Sign out without a copy: every local record goes (the cloud copy stays). */
export async function wipeLocal(): Promise<void> {
  await transact([...SYNCED_STORES, STORE.fileHandoff], 'readwrite', async (tx) => {
    for (const name of [...SYNCED_STORES, STORE.fileHandoff])
      await request(tx.objectStore(name).clear());
  });
}

export type { PushChange };

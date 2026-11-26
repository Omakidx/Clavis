import type {
  ChatData,
  DocumentData,
  HighlightData,
  WordData,
} from '../../shared/api-contract/records';

/**
 * The local user-data database (docs/clavis-sync-design.md section 4.1). A hand-written wrapper
 * (no `idb` dependency) so the reader keeps its bundle budget.
 *
 * It lives on the extension origin: only extension pages and the background open it. A content
 * script runs in the page's origin and gets its own, empty IndexedDB, so it can never read these
 * stores (the IDB counterpart of the storage lockdown, architecture section 9). The Groq key is
 * never stored here (S-09): no record shape has a field that could carry it.
 */

export const DB_NAME = 'clavis-data';
export const DB_VERSION = 1;

export const STORE = {
  words: 'words',
  chat: 'chat',
  documents: 'documents',
  highlights: 'highlights',
  fileHandoff: 'fileHandoff',
} as const;
export type StoreName = (typeof STORE)[keyof typeof STORE];
export const STORE_NAMES: readonly StoreName[] = Object.values(STORE);

/** Sync bookkeeping carried by every record of the four synced stores (design 4.1). */
export interface SyncFields {
  /** ms epoch, set on every local edit. */
  clientModifiedAt: number;
  /** Last server seq seen for this record; null = never synced. */
  seq: number | null;
  /** 1 = needs push. Only maintained while signed in (design 4.7). */
  dirty: 0 | 1;
  /** Increments on each local edit; a push clears `dirty` only if `rev` is unchanged. */
  rev: number;
  /** Local tombstone awaiting push. Signed out, records are deleted directly. */
  deleted: 0 | 1;
}

/** Records are the shared API shapes plus their key and the sync fields, so a push can strip them unchanged. */
export type LocalWord = WordData & SyncFields & { wordKey: string };
export type LocalChatMessage = ChatData & SyncFields & { id: string };
export type LocalDocument = DocumentData &
  SyncFields & {
    fingerprint: string;
    /** Server-owned and read-only locally (P3). */
    storageState: 'none' | 'stored';
  };
export type LocalHighlight = HighlightData & SyncFields & { id: string };
export interface FileHandoff {
  fingerprint: string;
  blob: Blob;
  direction: 'upload' | 'download';
  createdAt: number;
}

function createSchema(db: IDBDatabase): void {
  const words = db.createObjectStore(STORE.words, { keyPath: 'wordKey' });
  words.createIndex('byCreated', 'createdAt');
  words.createIndex('byDirty', 'dirty');

  const chat = db.createObjectStore(STORE.chat, { keyPath: 'id' });
  chat.createIndex('byWord', ['wordKey', 'createdAt']);
  chat.createIndex('byDirty', 'dirty');

  const documents = db.createObjectStore(STORE.documents, { keyPath: 'fingerprint' });
  documents.createIndex('byRecent', 'clientModifiedAt');
  documents.createIndex('byDirty', 'dirty');

  const highlights = db.createObjectStore(STORE.highlights, { keyPath: 'id' });
  highlights.createIndex('byDoc', 'fingerprint');
  highlights.createIndex('byDirty', 'dirty');

  db.createObjectStore(STORE.fileHandoff, { keyPath: 'fingerprint' });
}

let cached: { factory: IDBFactory; db: Promise<IDBDatabase> } | null = null;

/** Open (once per page) the database. Re-opens after the database was closed or deleted. */
export function openDb(): Promise<IDBDatabase> {
  const factory = globalThis.indexedDB as IDBFactory | undefined;
  if (factory === undefined) return Promise.reject(new Error('indexeddb-unavailable'));
  if (cached?.factory === factory) return cached.db;
  const db = new Promise<IDBDatabase>((resolve, reject) => {
    const open = factory.open(DB_NAME, DB_VERSION);
    open.onupgradeneeded = () => createSchema(open.result);
    open.onerror = () => reject(open.error ?? new Error('idb-open-failed'));
    open.onsuccess = () => {
      const connection = open.result;
      const forget = (): void => {
        if (cached?.db === db) cached = null;
      };
      // Another page upgrades or deletes the database (Clear all data): let it through.
      connection.onversionchange = () => {
        connection.close();
        forget();
      };
      connection.onclose = forget;
      resolve(connection);
    };
  });
  cached = { factory, db };
  db.catch(() => {
    if (cached?.db === db) cached = null;
  });
  return db;
}

/** Close this page's connection (it re-opens on the next use). */
export async function closeDb(): Promise<void> {
  const current = cached;
  cached = null;
  if (current === null) return;
  try {
    (await current.db).close();
  } catch {
    // It never opened: nothing to close.
  }
}

/** FR-078: delete the whole database. Other pages' connections close on `versionchange`. */
export async function deleteDatabase(): Promise<void> {
  await closeDb();
  const factory = globalThis.indexedDB as IDBFactory | undefined;
  if (factory === undefined) return;
  await new Promise<void>((resolve, reject) => {
    const request = factory.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('idb-delete-failed'));
    // `onblocked` only means another connection is still closing: the delete completes after it.
  });
}

/** An IDB request as a promise. Await only these inside a transaction (any other await commits it). */
export function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error('idb-request-failed'));
  });
}

/**
 * Run `work` in one transaction. The promise settles when the transaction has committed; if
 * `work` throws, the transaction is aborted (nothing is written) and the error is passed on.
 */
export async function transact<T>(
  stores: readonly StoreName[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T> | T,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    let result: T;
    const tx = db.transaction([...stores], mode);
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error ?? new Error('idb-aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('idb-failed'));
    const fail = (error: unknown): void => {
      reject(error);
      try {
        tx.abort();
      } catch {
        // Already finished.
      }
    };
    try {
      Promise.resolve(work(tx)).then((value) => {
        result = value;
      }, fail);
    } catch (error) {
      fail(error);
    }
  });
}

/** Every record of a store (or an index range). */
export function getAll<T>(
  source: IDBObjectStore | IDBIndex,
  range?: IDBKeyRange | IDBValidKey,
): Promise<T[]> {
  return request(source.getAll(range) as IDBRequest<T[]>);
}

/** Fields for the next version of a record (design 4.1): bumps `rev`, stamps the edit time. */
export function nextSync(
  previous: SyncFields | undefined,
  signedIn: boolean,
  now: number,
): SyncFields {
  return {
    clientModifiedAt: Math.max(now, (previous?.clientModifiedAt ?? 0) + 1),
    seq: previous?.seq ?? null,
    dirty: signedIn ? 1 : 0,
    rev: (previous?.rev ?? 0) + 1,
    deleted: 0,
  };
}

/** What a delete writes while signed in: a tombstone awaiting push. */
export function tombstoneOf<T extends SyncFields>(record: T, now: number): T {
  return {
    ...record,
    ...nextSync(record, true, now),
    deleted: 1,
  };
}

export const isLive = (record: { deleted: 0 | 1 }): boolean => record.deleted !== 1;

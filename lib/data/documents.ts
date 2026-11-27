import { notifyDataChanged } from './channel';
import {
  STORE,
  getAll,
  isLive,
  nextSync,
  request,
  tombstoneOf,
  transact,
  type LocalDocument,
  type LocalHighlight,
} from './db';
import type { WriteDeps } from './words';
import { isSignedIn } from './sync-flag';

/** Most documents the local data keeps (design 7.3: 30 before the move to IndexedDB). */
export const MAX_DOCUMENTS = 2000;
/** Position changes smaller than this (a fraction of a page) are not worth a write. */
const OFFSET_EPSILON = 0.01;

export interface ProgressInput {
  title: string | null;
  pageCount: number | null;
  fileBytes: number | null;
  lastPage: number;
  pageOffset: number;
}

const stub = (fingerprint: string): Omit<LocalDocument, keyof ReturnType<typeof nextSync>> => ({
  fingerprint,
  title: null,
  pageCount: null,
  lastPage: null,
  pageOffset: null,
  fileBytes: null,
  storageState: 'none',
});

/** The document record with a fingerprint, or undefined. */
export async function getDocument(fingerprint: string): Promise<LocalDocument | undefined> {
  const record = await transact([STORE.documents], 'readonly', (tx) =>
    request<LocalDocument | undefined>(tx.objectStore(STORE.documents).get(fingerprint)),
  );
  return record !== undefined && isLive(record) ? record : undefined;
}

/** Documents, most recently read first (the `byRecent` index, newest edit first). */
export async function listDocuments(limit = MAX_DOCUMENTS): Promise<LocalDocument[]> {
  const all = await transact([STORE.documents], 'readonly', (tx) =>
    getAll<LocalDocument>(tx.objectStore(STORE.documents).index('byRecent')),
  );
  return all.filter(isLive).reverse().slice(0, limit);
}

/** How many live highlights each document has. */
export async function countHighlightsByDocument(): Promise<Map<string, number>> {
  const all = await transact([STORE.highlights], 'readonly', (tx) =>
    getAll<LocalHighlight>(tx.objectStore(STORE.highlights)),
  );
  const counts = new Map<string, number>();
  for (const mark of all) {
    if (isLive(mark)) counts.set(mark.fingerprint, (counts.get(mark.fingerprint) ?? 0) + 1);
  }
  return counts;
}

/**
 * Record where the reader is in a document (design 7.3). Creates the document the first time it
 * is read. Returns false when nothing was written (the position did not change, or the 2,000
 * document limit is reached: progress is best effort and never evicts anything).
 */
export async function saveProgress(
  fingerprint: string,
  input: ProgressInput,
  deps: WriteDeps = {},
): Promise<boolean> {
  const signedIn = await (deps.signedIn ?? isSignedIn)();
  const now = (deps.now ?? Date.now)();
  const wrote = await transact([STORE.documents], 'readwrite', async (tx) => {
    const documents = tx.objectStore(STORE.documents);
    const previous = await request<LocalDocument | undefined>(documents.get(fingerprint));
    const live = previous !== undefined && isLive(previous);
    if (
      live &&
      previous.lastPage === input.lastPage &&
      Math.abs((previous.pageOffset ?? 0) - input.pageOffset) < OFFSET_EPSILON &&
      previous.title === input.title &&
      previous.pageCount === input.pageCount &&
      previous.fileBytes === input.fileBytes
    ) {
      return false;
    }
    if (!live && previous === undefined && (await request(documents.count())) >= MAX_DOCUMENTS) {
      return false;
    }
    const base = live ? previous : { ...stub(fingerprint), storageState: 'none' as const };
    await request(
      documents.put({
        ...base,
        title: input.title,
        pageCount: input.pageCount,
        fileBytes: input.fileBytes,
        lastPage: input.lastPage,
        pageOffset: input.pageOffset,
        ...nextSync(previous, signedIn, now),
      }),
    );
    return true;
  });
  if (wrote) notifyDataChanged(['documents']);
  return wrote;
}

/**
 * Forget a document: its progress, its highlights and any file handed off. Signed in, the
 * document and its marks stay as tombstones until the push (design 4.7). True if it existed.
 */
export async function deleteDocument(fingerprint: string, deps: WriteDeps = {}): Promise<boolean> {
  const signedIn = await (deps.signedIn ?? isSignedIn)();
  const now = (deps.now ?? Date.now)();
  const existed = await transact(
    [STORE.documents, STORE.highlights, STORE.fileHandoff],
    'readwrite',
    async (tx) => {
      const documents = tx.objectStore(STORE.documents);
      const previous = await request<LocalDocument | undefined>(documents.get(fingerprint));
      const marks = tx.objectStore(STORE.highlights);
      const all = await getAll<LocalHighlight>(marks.index('byDoc'), fingerprint);
      if ((previous === undefined || !isLive(previous)) && all.length === 0) return false;
      if (previous !== undefined) {
        if (signedIn) await request(documents.put(tombstoneOf(previous, now)));
        else await request(documents.delete(fingerprint));
      }
      for (const mark of all) {
        if (signedIn) await request(marks.put(tombstoneOf(mark, now)));
        else await request(marks.delete(mark.id));
      }
      await request(tx.objectStore(STORE.fileHandoff).delete(fingerprint));
      return true;
    },
  );
  if (existed) notifyDataChanged(['documents', 'highlights']);
  return existed;
}

/**
 * Record whether the account holds the document's file (the server's answer to an upload or a
 * removal). `storageState` is server-owned: no dirty flag, no rev bump, so it is never pushed. A
 * document that is not recorded here yet gets nothing: the next pull brings it. True if written.
 */
export async function setStorageState(
  fingerprint: string,
  state: LocalDocument['storageState'],
): Promise<boolean> {
  const wrote = await transact([STORE.documents], 'readwrite', async (tx) => {
    const documents = tx.objectStore(STORE.documents);
    const previous = await request<LocalDocument | undefined>(documents.get(fingerprint));
    if (previous === undefined || !isLive(previous) || previous.storageState === state) {
      return false;
    }
    await request(documents.put({ ...previous, storageState: state }));
    return true;
  });
  if (wrote) notifyDataChanged(['documents']);
  return wrote;
}

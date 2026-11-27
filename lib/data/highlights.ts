import type { HighlightStore, ReaderHighlight } from '../pdf/highlights';
import {
  MAX_HIGHLIGHT_DOCUMENTS,
  MAX_HIGHLIGHTS_PER_DOCUMENT,
  assertDocumentId,
  parseHighlight,
} from '../pdf/highlights';
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
  type SyncFields,
} from './db';
import { isSignedIn } from './sync-flag';
import type { WriteDeps } from './words';

const publicMark = ({
  id,
  page,
  start,
  end,
  color,
  createdAt,
}: LocalHighlight): ReaderHighlight => ({
  id,
  page,
  start,
  end,
  color,
  createdAt,
});

const inOrder = (a: LocalHighlight, b: LocalHighlight): number =>
  a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1);

/**
 * The reader's `HighlightStore` over IndexedDB (design 7.3). Every mutation is one transaction,
 * so the per-document and total limits hold across reader tabs without a lock, and other tabs
 * hear about it on the `clavis-data` channel.
 */
export function createIdbHighlightStore(deps: WriteDeps = {}): HighlightStore {
  const list = async (documentId: string): Promise<ReaderHighlight[]> => {
    assertDocumentId(documentId);
    const all = await transact([STORE.highlights], 'readonly', (tx) =>
      getAll<LocalHighlight>(tx.objectStore(STORE.highlights).index('byDoc'), documentId),
    );
    return all.filter(isLive).sort(inOrder).map(publicMark);
  };

  async function mutate(
    documentId: string,
    change: (
      marks: IDBObjectStore,
      live: LocalHighlight[],
      signedIn: boolean,
      now: number,
    ) => Promise<void>,
    ensureDocument = false,
  ): Promise<ReaderHighlight[]> {
    assertDocumentId(documentId);
    const signedIn = await (deps.signedIn ?? isSignedIn)();
    const now = (deps.now ?? Date.now)();
    await transact([STORE.highlights, STORE.documents], 'readwrite', async (tx) => {
      const marks = tx.objectStore(STORE.highlights);
      const live = (await getAll<LocalHighlight>(marks.index('byDoc'), documentId)).filter(isLive);
      await change(marks, live, signedIn, now);
      // A document with marks has a live record (the library lists it): created on the first mark,
      // or brought back when the document was deleted while signed in (design 4.4).
      const documents = tx.objectStore(STORE.documents);
      const known = ensureDocument
        ? await request<LocalDocument | undefined>(documents.get(documentId))
        : undefined;
      if (ensureDocument && (known === undefined || !isLive(known))) {
        if (known === undefined && (await request(documents.count())) >= MAX_HIGHLIGHT_DOCUMENTS) {
          throw new Error('highlight-limit');
        }
        const base: Omit<LocalDocument, keyof SyncFields> = known ?? {
          fingerprint: documentId,
          title: null,
          pageCount: null,
          lastPage: null,
          pageOffset: null,
          fileBytes: null,
          storageState: 'none',
        };
        await request(documents.put({ ...base, ...nextSync(known, signedIn, now) }));
      }
    });
    notifyDataChanged(['highlights', 'documents']);
    return list(documentId);
  }

  return {
    list,
    add: (documentId, marks) =>
      mutate(
        documentId,
        async (store, live, signedIn, now) => {
          const parsed = marks.map((mark) => {
            const valid = parseHighlight(mark);
            if (!valid) throw new Error('invalid-highlight');
            return valid;
          });
          if (live.length + parsed.length > MAX_HIGHLIGHTS_PER_DOCUMENT) {
            throw new Error('highlight-limit');
          }
          for (const mark of parsed) {
            const record: LocalHighlight = {
              ...mark,
              fingerprint: documentId,
              ...nextSync(undefined, signedIn, now),
              clientModifiedAt: Math.max(mark.createdAt, now),
            };
            await request(store.put(record));
          }
        },
        true,
      ),
    remove: (documentId, id) =>
      mutate(documentId, async (store, live, signedIn, now) => {
        const mark = live.find((candidate) => candidate.id === id);
        if (mark === undefined) return;
        if (signedIn) await request(store.put(tombstoneOf(mark, now)));
        else await request(store.delete(id));
      }),
    async clear(documentId) {
      await mutate(documentId, async (store, live, signedIn, now) => {
        for (const mark of live) {
          if (signedIn) await request(store.put(tombstoneOf(mark, now)));
          else await request(store.delete(mark.id));
        }
      });
    },
  };
}

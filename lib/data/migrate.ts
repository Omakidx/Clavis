import { browser } from 'wxt/browser';
import { parseHighlightDocuments, withHighlightStorageLock } from '../pdf/highlights';
import type { StorageAreaLike } from '../storage/area';
import { STORAGE_KEYS } from '../storage/keys';
import { notifyDataChanged } from './channel';
import { STORE, nextSync, request, transact, type LocalDocument, type LocalHighlight } from './db';
import { isSignedIn } from './sync-flag';

/** The earliest time the shared record schemas accept (2020-01-01). */
const MIN_EPOCH_MS = 1_577_836_800_000;

export interface MigrationDeps {
  area?: StorageAreaLike;
  signedIn?: () => Promise<boolean>;
  now?: () => number;
}

/**
 * One-time move of the marks in `clavis.reader-highlights` into IndexedDB (design 7.3). Runs at
 * background startup. Idempotent by highlight id: a run that stops half way (or a second run)
 * writes nothing twice, and the old key is removed only after the data is committed. A failure
 * leaves the old key in place and the next start tries again. Resolves to how many marks were
 * written.
 */
export async function migrateLegacyHighlights(deps: MigrationDeps = {}): Promise<number> {
  const area = deps.area ?? browser.storage.local;
  const signedIn = await (deps.signedIn ?? isSignedIn)();
  const now = (deps.now ?? Date.now)();
  return withHighlightStorageLock(async () => {
    const raw = (await area.get(STORAGE_KEYS.readerHighlights))[STORAGE_KEYS.readerHighlights];
    if (raw === undefined) return 0;
    const documents = parseHighlightDocuments(raw);
    let written = 0;
    await transact([STORE.highlights, STORE.documents], 'readwrite', async (tx) => {
      const marks = tx.objectStore(STORE.highlights);
      const records = tx.objectStore(STORE.documents);
      for (const [fingerprint, list] of Object.entries(documents)) {
        let newest = 0;
        for (const mark of list) {
          const createdAt = Math.max(mark.createdAt, MIN_EPOCH_MS);
          newest = Math.max(newest, createdAt);
          if ((await request(marks.getKey(mark.id))) !== undefined) continue;
          const record: LocalHighlight = {
            ...mark,
            createdAt,
            fingerprint,
            ...nextSync(undefined, signedIn, now),
            clientModifiedAt: createdAt,
          };
          await request(marks.put(record));
          written += 1;
        }
        if (list.length > 0 && (await request(records.getKey(fingerprint))) === undefined) {
          const document: LocalDocument = {
            fingerprint,
            title: null,
            pageCount: null,
            lastPage: null,
            pageOffset: null,
            fileBytes: null,
            storageState: 'none',
            ...nextSync(undefined, signedIn, now),
            clientModifiedAt: newest,
          };
          await request(records.put(document));
        }
      }
    });
    await area.remove(STORAGE_KEYS.readerHighlights);
    if (written > 0) notifyDataChanged(['highlights', 'documents']);
    return written;
  });
}

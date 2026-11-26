import type { StorageAreaLike } from './area';
import { StorageUnavailableError } from './errors';
import { STORAGE_NAMESPACE } from './keys';
import { notifyDataCleared } from '../data/channel';
import { deleteDatabase } from '../data/db';
import { withHighlightStorageLock } from '../pdf/highlights';

/**
 * FR-078: remove every Clavis record (key, key metadata, preferences, onboarding state
 * and any future cache) from both storage areas, and the `clavis-data` database. Matches by namespace prefix, so a record
 * added later is cleared without touching this list. Allowed even if the lockdown failed.
 *
 * This does NOT revoke Chrome permissions: optional site access stays granted until the
 * user revokes it in Chrome or in Settings (permissions.remove needs a user gesture).
 */
export async function clearClavisStorage(areas: StorageAreaLike[]): Promise<void> {
  try {
    await withHighlightStorageLock(async () => {
      await Promise.all(
        areas.map(async (area) => {
          const keys = Object.keys(await area.get(null)).filter((key) =>
            key.startsWith(STORAGE_NAMESPACE),
          );
          if (keys.length > 0) await area.remove(keys);
        }),
      );
      // The saved words, chats, documents and highlights (design 7.2) live in IndexedDB, under
      // the same lock as the legacy highlight record the migration reads.
      await deleteDatabase();
    });
    // Open pages must not write their state back (a reader's progress): tell them.
    notifyDataCleared();
  } catch {
    throw new StorageUnavailableError();
  }
}

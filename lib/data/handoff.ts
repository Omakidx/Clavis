import { STORE, request, transact, type FileHandoff } from './db';

/**
 * The `fileHandoff` store (docs/clavis-sync-design.md 6.6): the only way PDF bytes cross between
 * the reader or library (which never call the API, rule R2) and the background (which does).
 * An entry lives only for the length of one upload or download: whoever consumes it deletes it,
 * and entries older than `STALE_HANDOFF_MS` are swept when the service worker starts, so no file
 * outlives its transfer (architecture section 9: PDF bytes are not stored automatically).
 */

/** A handoff entry older than this is garbage (design 6.6: 10 minutes). */
export const STALE_HANDOFF_MS = 10 * 60 * 1000;

export type HandoffDirection = FileHandoff['direction'];

/**
 * Leave `blob` for the other side. Replaces an earlier entry of the same direction, but never one
 * of the other direction (an upload and a download of one file must not cancel each other): that
 * returns false and writes nothing. Stale entries are swept by `sweepStaleHandoffs`.
 */
export async function putHandoff(
  fingerprint: string,
  blob: Blob,
  direction: HandoffDirection,
  now: () => number = Date.now,
): Promise<boolean> {
  const entry: FileHandoff = { fingerprint, blob, direction, createdAt: now() };
  return transact([STORE.fileHandoff], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE.fileHandoff);
    const existing = await request<FileHandoff | undefined>(store.get(fingerprint));
    if (existing !== undefined && existing.direction !== direction) return false;
    await request(store.put(entry));
    return true;
  });
}

/**
 * Read the entry for `fingerprint` and delete it in the same transaction. Null when there is none,
 * or when it was left for the other direction (it stays for its own consumer and the sweep).
 */
export async function takeHandoff(
  fingerprint: string,
  direction: HandoffDirection,
): Promise<Blob | null> {
  return transact([STORE.fileHandoff], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE.fileHandoff);
    const entry = await request<FileHandoff | undefined>(store.get(fingerprint));
    if (entry === undefined || entry.direction !== direction) return null;
    await request(store.delete(fingerprint));
    return entry.blob;
  });
}

/** Delete the entry for `fingerprint` if it was left for `direction`. Never throws. */
export async function dropHandoff(fingerprint: string, direction: HandoffDirection): Promise<void> {
  try {
    await transact([STORE.fileHandoff], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.fileHandoff);
      const entry = await request<FileHandoff | undefined>(store.get(fingerprint));
      if (entry !== undefined && entry.direction === direction) {
        await request(store.delete(fingerprint));
      }
    });
  } catch {
    // The database is not available: nothing to delete.
  }
}

/** Delete every entry older than `maxAgeMs`. Returns how many were deleted. */
export async function sweepStaleHandoffs(
  now: () => number = Date.now,
  maxAgeMs: number = STALE_HANDOFF_MS,
): Promise<number> {
  const limit = now() - maxAgeMs;
  return transact([STORE.fileHandoff], 'readwrite', async (tx) => {
    const store = tx.objectStore(STORE.fileHandoff);
    const all = await request<FileHandoff[]>(store.getAll());
    let removed = 0;
    for (const entry of all) {
      // A createdAt that is not a number is as stale as an old one.
      if (typeof entry.createdAt !== 'number' || entry.createdAt <= limit) {
        await request(store.delete(entry.fingerprint));
        removed += 1;
      }
    }
    return removed;
  });
}

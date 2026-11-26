import type { BrowserContext } from '@playwright/test';

declare const indexedDB: IDBFactory;

/**
 * Forget where every PDF was last read (the `documents` store of clavis-data), keeping highlights
 * and everything else.
 *
 * Since Clavis Sync P1 the reader returns to the saved page when the same file is opened again.
 * The older reader specs open the same fixture in many tests of one browser profile and expect
 * a fresh open to start on page 1, so their helpers call this before loading the reader. The
 * progress specs (p10-library.spec.ts) deliberately do not.
 *
 * It runs in the service worker (the extension's origin) and never creates the database: a
 * profile whose reader has not run yet has nothing to forget.
 */
export async function forgetReadingProgress(context: BrowserContext): Promise<void> {
  const worker = context.serviceWorkers()[0];
  if (worker === undefined) return;
  await worker.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const open = indexedDB.open('clavis-data', 1);
        open.onupgradeneeded = () => open.transaction?.abort();
        open.onerror = () => resolve();
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('documents', 'readwrite');
          tx.objectStore('documents').clear();
          const done = (): void => {
            db.close();
            resolve();
          };
          tx.oncomplete = done;
          tx.onerror = done;
          tx.onabort = done;
        };
      }),
  );
}

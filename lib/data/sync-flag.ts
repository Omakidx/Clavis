import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../storage/keys';

/**
 * Whether this device is bound to an account (`clavis.sync-state` has an `accountId`). Writers
 * read it before a transaction: while signed in they maintain the dirty flags (design 4.7), while
 * signed out deletes are direct and `dirty` stays 0. The sync engine (a later phase) owns the key.
 * Never throws: storage trouble means "signed out".
 */
export async function isSignedIn(): Promise<boolean> {
  try {
    const stored = (await browser.storage.local.get(STORAGE_KEYS.syncState))[
      STORAGE_KEYS.syncState
    ];
    return (
      typeof stored === 'object' &&
      stored !== null &&
      typeof (stored as { accountId?: unknown }).accountId === 'string'
    );
  } catch {
    return false;
  }
}

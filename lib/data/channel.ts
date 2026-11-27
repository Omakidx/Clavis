import { STORE_NAMES, type StoreName } from './db';

/** Multi-tab coherence (design 4.1): pages learn about changes through this channel. */
export const DATA_CHANNEL = 'clavis-data';

/** Clear all data finished: every page must forget what it holds and stop writing (design 7.2). */
export function notifyDataCleared(): void {
  try {
    const channel = new BroadcastChannel(DATA_CHANNEL);
    channel.postMessage({ cleared: true });
    channel.close();
  } catch {
    // No BroadcastChannel: pages learn on their next load.
  }
}

/** Call `listener` when all local data was cleared. Returns the unsubscribe. */
export function onDataCleared(listener: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(DATA_CHANNEL);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if ((event.data as { cleared?: unknown } | null)?.cleared === true) listener();
  };
  return () => channel.close();
}

/** Tell every other page which stores changed. Never throws. */
export function notifyDataChanged(stores: readonly StoreName[]): void {
  try {
    const channel = new BroadcastChannel(DATA_CHANNEL);
    channel.postMessage({ stores });
    channel.close();
  } catch {
    // No BroadcastChannel (or it is closing): pages refresh on their next load.
  }
}

/** Call `listener` for a change to any of `watch` (all stores by default). Returns the unsubscribe. */
export function onDataChanged(
  listener: (stores: StoreName[]) => void,
  watch: readonly StoreName[] = STORE_NAMES,
): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(DATA_CHANNEL);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    // Everything was deleted: whatever a page shows is stale.
    if ((event.data as { cleared?: unknown } | null)?.cleared === true) {
      listener([...STORE_NAMES]);
      return;
    }
    const stores = (event.data as { stores?: unknown } | null)?.stores;
    if (!Array.isArray(stores)) return;
    const known = stores.filter((s): s is StoreName => STORE_NAMES.includes(s as StoreName));
    if (known.some((s) => watch.includes(s))) listener(known);
  };
  return () => channel.close();
}

/**
 * The account or sync state changed (a sync started or ended, sign-in, sign-out): pages re-read
 * ACCOUNT_GET_STATUS. A bare signal: it carries no email, no token and no counts. Never throws.
 */
export function notifyAccountStatusChanged(): void {
  try {
    const channel = new BroadcastChannel(DATA_CHANNEL);
    channel.postMessage({ accountStatus: true });
    channel.close();
  } catch {
    // No BroadcastChannel: pages fall back to polling.
  }
}

/** Call `listener` on every account-status-changed signal. Returns the unsubscribe. */
export function onAccountStatusChanged(listener: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => undefined;
  const channel = new BroadcastChannel(DATA_CHANNEL);
  channel.onmessage = (event: MessageEvent<unknown>) => {
    if ((event.data as { accountStatus?: unknown } | null)?.accountStatus === true) listener();
  };
  return () => channel.close();
}

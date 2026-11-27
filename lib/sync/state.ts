import { z } from 'zod';
import { ErrorCode } from '../../shared/api-contract/errors';
import { createQueue, type StorageAreaLike } from '../storage/area';
import { STORAGE_KEYS } from '../storage/keys';

/** `clavis.sync-state` (docs/clavis-sync-design.md 4.1): non-secret bookkeeping of the sync engine. */
export const syncErrorSchema = z.union([ErrorCode, z.literal('NETWORK')]);
export type SyncErrorCode = z.infer<typeof syncErrorSchema>;

export const syncStateSchema = z.object({
  accountId: z.string().min(1),
  cursor: z.string().regex(/^\d{1,19}$/),
  lastPushAt: z.number().optional(),
  lastPullAt: z.number().optional(),
  lastError: syncErrorSchema.optional(),
  deviceId: z.string().min(1),
  /** Pushed records the server refused for good (kept locally); shown in the sync status. */
  rejectedCount: z.number().int().nonnegative().optional(),
  /** Consecutive failed runs and when the next attempt may start: backoff survives a worker restart. */
  failures: z.number().int().nonnegative().optional(),
  retryAt: z.number().optional(),
});
export type SyncState = z.infer<typeof syncStateSchema>;

export interface SyncStateStore {
  read(): Promise<SyncState | null>;
  /** Bind the device to an account. */
  start(state: SyncState): Promise<void>;
  /** Patch the state, only while it is still bound to `accountId` (a sign-out must not be undone). */
  update(
    accountId: string,
    patch: Partial<Omit<SyncState, 'accountId'>>,
    unset?: readonly ('lastError' | 'failures' | 'retryAt')[],
  ): Promise<void>;
  clear(): Promise<void>;
}

export function createSyncStateStore(area: StorageAreaLike): SyncStateStore {
  const queue = createQueue();
  const read = async (): Promise<SyncState | null> => {
    try {
      const raw = (await area.get(STORAGE_KEYS.syncState))[STORAGE_KEYS.syncState];
      const parsed = syncStateSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  };
  return {
    read,
    start: (state) => queue(() => area.set({ [STORAGE_KEYS.syncState]: state })),
    update: (accountId, patch, unset = []) =>
      queue(async () => {
        const current = await read();
        if (current === null || current.accountId !== accountId) return;
        const next: Record<string, unknown> = { ...current };
        for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
        for (const k of unset) delete next[k];
        await area.set({ [STORAGE_KEYS.syncState]: next });
      }),
    clear: () => queue(() => area.remove(STORAGE_KEYS.syncState)),
  };
}

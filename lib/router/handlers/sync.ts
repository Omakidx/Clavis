import type { MessageReply } from '../../contracts';
import { success } from '../replies';

/**
 * SYNC_KICK (docs/clavis-sync-design.md 4.1, 7.4): an extension page tells the background that
 * local data changed. The sync engine hangs its debounced push (and
 * a pull when `pull` is set) on `onKick`; signed out there is nothing to sync.
 */
export function createSyncHandlers(options: { onKick?: (pull: boolean) => void } = {}) {
  return {
    kick(pull: boolean): MessageReply<Record<string, never>> {
      options.onKick?.(pull);
      return success({});
    },
  };
}

export type SyncHandlers = ReturnType<typeof createSyncHandlers>;

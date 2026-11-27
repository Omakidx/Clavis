import { t } from '../../lib/i18n';
import type { SyncStatusView } from '../../lib/contracts/account';

/** One line for how sync is doing (localized). */
export function syncLine(sync: SyncStatusView): string {
  if (sync.state === 'syncing') return t('accountSyncing');
  if (sync.state === 'offline') return t('accountSyncOffline');
  if (sync.state === 'error') return t('accountSyncError');
  if (sync.lastSyncAt === undefined) return t('accountSyncNever');
  return t('accountSyncDone', new Date(sync.lastSyncAt).toLocaleString());
}

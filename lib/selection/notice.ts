import { MESSAGE_VERSION } from '../config/constants';

/**
 * Background -> content (top frame): show a notice instead of a toolbar.
 *
 * Sent by lib/site-access (injection.ts) when the declined-access path (activeTab) cannot reach
 * a cross-origin iframe, which would otherwise fail silently: the background injects the
 * observer into the top frame (frameId 0, covered by the grant) and sends this message there.
 * Plain object and guard, no zod: the observer stays within its size budget.
 */
export type NoticeReason = 'frame-no-access';

export interface ShowNoticeMessage {
  v: typeof MESSAGE_VERSION;
  type: 'CLAVIS_SHOW_NOTICE';
  reason: NoticeReason;
}

export function isShowNoticeMessage(value: unknown): value is ShowNoticeMessage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    record['v'] === MESSAGE_VERSION &&
    record['type'] === 'CLAVIS_SHOW_NOTICE' &&
    record['reason'] === 'frame-no-access'
  );
}

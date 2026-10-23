import type { MessageKey } from '../i18n';
import type { ViewStatus } from './controller';
import type { ReaderState } from './state';

/** What a screen reader should be told, as a message key plus substitutions; null = nothing. */
export interface Announcement {
  key: MessageKey;
  subs?: string[];
}

export interface AnnounceInput {
  state: ReaderState;
  view: ViewStatus | null;
}

/**
 * The one polite announcement for the change from `prev` to `next` (FR-055, accessibility): a
 * state change wins over a page change, which wins over a zoom change. Errors, the image-only
 * notice, the loading status, the password prompt and find results are announced by their own live regions, so they
 * are not repeated here.
 */
export function announcementFor(prev: AnnounceInput, next: AnnounceInput): Announcement | null {
  const a = prev.state;
  const b = next.state;
  if (a.phase !== b.phase) {
    if (b.phase === 'ready') {
      return { key: 'readerOpened', subs: [b.name, String(b.pageCount)] };
    }
    if (b.phase === 'empty' && a.phase !== 'empty') return { key: 'readerClosedLive' };
    return null;
  }
  const from = prev.view;
  const to = next.view;
  if (to === null) return null;
  if (from !== null && from.page !== to.page) {
    return { key: 'readerPageLive', subs: [String(to.page), String(to.pageCount)] };
  }
  if (from !== null && Math.abs(from.zoom - to.zoom) > 0.001) {
    return { key: 'readerZoomLive', subs: [String(Math.round(to.zoom * 100))] };
  }
  return null;
}

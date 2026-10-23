import { useEffect, useRef, useState } from 'react';
import { t } from '../../lib/i18n';
import { announcementFor, type AnnounceInput } from '../../lib/pdf/announce';
import type { ReaderSnapshot } from '../../lib/pdf/controller';

/** Page and zoom changes arrive in bursts while scrolling or holding a key: say only the last. */
const BURST_DELAY_MS = 350;

/**
 * Polite live region for what the viewer does on its own: a document opened or closed, the page
 * that came into view, the zoom level. It is in the DOM from the start (screen readers only
 * announce changes to regions that already exist) and visually hidden.
 */
export function Announcer({ snapshot }: { snapshot: ReaderSnapshot }) {
  const [text, setText] = useState('');
  const previous = useRef<AnnounceInput>({ state: snapshot.state, view: snapshot.view });
  const timer = useRef<number | undefined>(undefined);
  const { state, view } = snapshot;

  useEffect(() => {
    const next: AnnounceInput = { state, view };
    const announcement = announcementFor(previous.current, next);
    previous.current = next;
    if (announcement === null) return;
    window.clearTimeout(timer.current);
    const burst = announcement.key === 'readerPageLive' || announcement.key === 'readerZoomLive';
    timer.current = window.setTimeout(
      () => setText(t(announcement.key, announcement.subs)),
      burst ? BURST_DELAY_MS : 0,
    );
  }, [state, view]);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  return (
    <div className="clavis-sr-only" role="status" aria-live="polite" data-testid="live-region">
      {text}
    </div>
  );
}

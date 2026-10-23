import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SelectionSnapshot } from '../../lib/contracts';
import type { ListenController } from '../../lib/selection/listen';
import type { ListenReport } from '../../lib/selection/ui-api';

const IDLE: ListenReport = { status: 'idle' };

/**
 * Listen for the panel's selected text: the same `ListenController` as the toolbar (only the
 * selected text is sent to TTS, never the context; "playing" only after the engine really
 * started), driven by a plain button instead of the toolbar.
 *
 * State belongs to one selection: a different selection starts from idle with the saved speed.
 */
export function useListen(controller: ListenController, snapshot: SelectionSnapshot | null) {
  const selectionId = snapshot?.selectionId ?? null;
  const [stored, setStored] = useState<{
    id: string | null;
    report: ListenReport;
    /** The user's Slow choice for this selection; undefined = the saved preference. */
    slow: boolean | undefined;
  }>({ id: null, report: IDLE, slow: undefined });
  const current = useMemo(
    () => (stored.id === selectionId ? stored : { id: selectionId, report: IDLE, slow: undefined }),
    [stored, selectionId],
  );
  const abort = useRef<AbortController | null>(null);
  const slowRef = useRef<boolean | undefined>(undefined);
  useEffect(() => {
    slowRef.current = current.slow;
  });

  const stop = useCallback(() => {
    abort.current?.abort();
    abort.current = null;
    setStored((prev) => ({ ...prev, id: selectionId, report: IDLE }));
  }, [selectionId]);

  const start = useCallback(() => {
    if (snapshot === null) return;
    abort.current?.abort();
    const run = new AbortController();
    abort.current = run;
    controller.listen({
      snapshot,
      overLimit: false,
      signal: run.signal,
      listen: {
        slow: slowRef.current,
        report: (next) => {
          if (abort.current === run)
            setStored((prev) => ({ ...prev, id: snapshot.selectionId, report: next }));
        },
      },
    });
  }, [controller, snapshot]);

  // A different selection (or leaving the page) stops what is playing.
  useEffect(
    () => () => {
      abort.current?.abort();
      abort.current = null;
    },
    [selectionId],
  );

  const toggleSlow = useCallback(() => {
    const effective =
      current.slow ?? (current.report.status === 'playing' ? current.report.slow : false);
    setStored({ ...current, id: selectionId, slow: !effective });
  }, [current, selectionId]);

  return { report: current.report, slowChoice: current.slow, start, stop, toggleSlow };
}

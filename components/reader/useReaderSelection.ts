import { useEffect, useRef, type RefObject } from 'react';
import { mountReaderSelection, type ReaderSelectionHandle } from './selection-toolbar';

/**
 * Each PDF owns its toolbar and lookup sessions. Replacing/closing it tears them down even when
 * focus or a selection inside the card would otherwise suppress selection-change dismissal.
 * Page/text-layer renders only reposition the current document's toolbar (zoom, resize).
 */
export function useReaderSelection(
  containerRef: RefObject<HTMLElement | null>,
  renderCount: number,
  documentKey: number | null,
): void {
  const handle = useRef<ReaderSelectionHandle | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    // The empty reader still needs its background-message listener to answer keyboard commands.
    const mounted = mountReaderSelection(container);
    handle.current = mounted;
    return () => {
      mounted.stop();
      handle.current = null;
    };
  }, [containerRef, documentKey]);

  useEffect(() => {
    if (renderCount === 0) return;
    const frame = requestAnimationFrame(() => handle.current?.reposition());
    return () => cancelAnimationFrame(frame);
  }, [renderCount]);
}

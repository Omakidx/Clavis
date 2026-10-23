import { useEffect, useRef, type RefObject } from 'react';
import { mountReaderSelection, type ReaderSelectionHandle } from './selection-toolbar';

/**
 * Mount the shared selection toolbar on the viewer for the page's lifetime. `renderCount` changes
 * after every page or text-layer render; the toolbar is re-placed then (zoom, resize).
 */
export function useReaderSelection(
  containerRef: RefObject<HTMLElement | null>,
  renderCount: number,
): void {
  const handle = useRef<ReaderSelectionHandle | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const mounted = mountReaderSelection(container);
    handle.current = mounted;
    return () => {
      mounted.stop();
      handle.current = null;
    };
  }, [containerRef]);

  useEffect(() => {
    if (renderCount === 0) return;
    const frame = requestAnimationFrame(() => handle.current?.reposition());
    return () => cancelAnimationFrame(frame);
  }, [renderCount]);
}

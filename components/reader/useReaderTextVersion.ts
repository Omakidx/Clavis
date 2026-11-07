import { useEffect, useState, type RefObject } from 'react';

/** Find rebuilds span text nodes without a textlayerrendered event. Reproject source ranges. */
export function useReaderTextVersion(containerRef: RefObject<HTMLDivElement | null>): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof MutationObserver === 'undefined') return;
    let frame = 0;
    const observer = new MutationObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        setVersion((current) => current + 1);
      });
    });
    observer.observe(container, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [containerRef]);
  return version;
}

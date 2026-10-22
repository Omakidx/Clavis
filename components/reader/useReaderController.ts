import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { PdfReaderController, type ReaderSnapshot } from '../../lib/pdf/controller';

export interface PendingLink {
  url: string;
}

/**
 * Owns one PdfReaderController for the page's lifetime and exposes its snapshot to React.
 * The controller is created during the first render without touching the DOM; the viewer elements
 * and the external-link confirmer are attached in an effect, and the document is released on
 * unmount.
 */
export function useReaderController() {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const linkResolver = useRef<((ok: boolean) => void) | null>(null);
  const [pendingLink, setPendingLink] = useState<PendingLink | null>(null);

  const confirmExternalLink = useCallback((url: string): Promise<boolean> => {
    // A second click replaces the first prompt; the first is treated as cancelled.
    linkResolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      linkResolver.current = resolve;
      setPendingLink({ url });
    });
  }, []);

  const answerLink = useCallback((ok: boolean) => {
    linkResolver.current?.(ok);
    linkResolver.current = null;
    setPendingLink(null);
  }, []);

  const [controller] = useState(() => new PdfReaderController());

  // Refs and callbacks are handed over after mount, never read during render.
  useEffect(() => {
    const container = containerRef.current;
    const viewerElement = viewerRef.current;
    if (container && viewerElement) controller.attach({ container, viewerElement });
    controller.setLinkConfirmer(confirmExternalLink);
    return () => {
      void controller.destroy();
    };
  }, [controller, confirmExternalLink]);

  const snapshot: ReaderSnapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
  );

  return { controller, snapshot, containerRef, viewerRef, pendingLink, answerLink };
}

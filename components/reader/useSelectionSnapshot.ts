import { useEffect, useState, type RefObject } from 'react';
import type { SelectionSnapshot } from '../../lib/contracts';
import { readPdfSelection, toPdfSelectionSnapshot } from '../../lib/pdf/selection';

export interface CapturedSelection {
  snapshot: SelectionSnapshot;
  truncated: boolean;
}

/**
 * Keeps the last non-empty selection made inside the PDF text layers under `rootRef`, as a
 * schema-validated `source: 'pdf'` SelectionSnapshot (spike: shown in a developer panel).
 * `current` is false while the selection is empty or outside the PDF.
 */
export function useSelectionSnapshot(rootRef: RefObject<HTMLElement | null>) {
  const [last, setLast] = useState<CapturedSelection | null>(null);
  const [current, setCurrent] = useState(false);

  useEffect(() => {
    const onChange = () => {
      const root = rootRef.current;
      const picked = root ? readPdfSelection(document.getSelection(), root) : null;
      const snapshot = picked ? toPdfSelectionSnapshot(picked) : null;
      setCurrent(snapshot !== null);
      if (picked && snapshot) setLast({ snapshot, truncated: picked.truncated });
    };
    document.addEventListener('selectionchange', onChange);
    return () => document.removeEventListener('selectionchange', onChange);
  }, [rootRef]);

  return { last, current };
}

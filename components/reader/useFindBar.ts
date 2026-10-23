import { useCallback, useEffect, useRef, useState } from 'react';
import type { PdfReaderController } from '../../lib/pdf/controller';
import { isNewSearch, type FindRequest } from '../../lib/pdf/find';

/**
 * State of the find bar (FR-057). The search itself lives in PDF.js's PDFFindController, reached
 * through the controller; this hook owns what the user typed, the case toggle, whether the bar is
 * open and where focus goes. Nothing is remembered once the bar closes or a file is replaced.
 */
export function useFindBar(
  controller: PdfReaderController,
  viewerRef: { current: HTMLElement | null },
) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  /** Bumped by every `show()` so Ctrl+F while the bar is open re-focuses and selects the box. */
  const [focusTick, setFocusTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const last = useRef<FindRequest | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [open, focusTick]);

  const show = useCallback(() => {
    const active = document.activeElement;
    if (!open && active instanceof HTMLElement && active !== document.body)
      returnTo.current = active;
    setOpen(true);
    setFocusTick((n) => n + 1);
  }, [open]);

  const reset = useCallback(() => {
    last.current = null;
    setOpen(false);
    setQuery('');
    setCaseSensitive(false);
    controller.clearFind();
  }, [controller]);

  /** Close the bar. `restoreFocus` returns focus to where it was (or the pages). */
  const hide = useCallback(
    (restoreFocus = true) => {
      const hadFocus = barRef.current?.contains(document.activeElement) === true;
      reset();
      if (!restoreFocus || !hadFocus) return;
      const target = returnTo.current?.isConnected ? returnTo.current : viewerRef.current;
      returnTo.current = null;
      target?.focus({ preventScroll: true });
    },
    [reset, viewerRef],
  );

  const run = useCallback(
    (next: FindRequest) => {
      if (next.query.trim() === '') {
        last.current = null;
        controller.clearFind();
        return;
      }
      if (!isNewSearch(last.current, next)) return;
      last.current = next;
      controller.find(next.query, { caseSensitive: next.caseSensitive });
    },
    [controller],
  );

  const changeQuery = useCallback(
    (value: string) => {
      setQuery(value);
      run({ query: value, caseSensitive });
    },
    [caseSensitive, run],
  );

  const toggleCase = useCallback(() => {
    const next = !caseSensitive;
    setCaseSensitive(next);
    run({ query, caseSensitive: next });
  }, [caseSensitive, query, run]);

  /** Step to the next or previous match of the current search. */
  const step = useCallback(
    (previous: boolean) => {
      if (query.trim() === '') return;
      last.current ??= { query, caseSensitive };
      controller.find(query, { again: true, previous, caseSensitive });
    },
    [caseSensitive, controller, query],
  );

  return {
    open,
    query,
    caseSensitive,
    inputRef,
    barRef,
    show,
    hide,
    reset,
    changeQuery,
    toggleCase,
    step,
  };
}

export type FindBarModel = ReturnType<typeof useFindBar>;

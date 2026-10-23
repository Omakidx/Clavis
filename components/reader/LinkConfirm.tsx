import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { t } from '../../lib/i18n';

/**
 * Pointer activations of "Open link" are ignored for this long after the dialog appears, and any
 * part of a double or triple click is ignored. A full-page link annotation puts the dialog under
 * the pointer of the SECOND click of a double click (Phase 7 security review MEDIUM-1). Keyboard
 * activation (Enter or Space, `detail` 0) is never delayed: it needs a deliberate focus move first.
 */
export const OPEN_GUARD_MS = 500;

interface LinkConfirmProps {
  url: string;
  onAnswer: (open: boolean) => void;
}

/**
 * External links in a PDF open only after this confirmation (architecture section 8). The URL is
 * shown as a text node. Focus lands on Cancel (the safe default), Escape cancels, and focus goes
 * back to the link that was activated once the dialog closes.
 */
export function LinkConfirm({ url, onAnswer }: LinkConfirmProps) {
  const headingId = useId();
  const cancel = useRef<HTMLButtonElement>(null);
  const mountedAt = useRef(Number.POSITIVE_INFINITY);

  useEffect(() => {
    mountedAt.current = performance.now();
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const onOpen = (event: MouseEvent) => {
    // detail: 0 for keyboard, 1 for a first click, 2+ for the rest of a multi-click.
    const pointer = event.detail > 0;
    if (pointer && (event.detail > 1 || performance.now() - mountedAt.current < OPEN_GUARD_MS)) {
      return;
    }
    onAnswer(true);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onAnswer(false);
    } else if (event.key === 'Tab') {
      // Two buttons: keep Tab inside the dialog.
      const buttons = Array.from(event.currentTarget.querySelectorAll('button'));
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
  };

  return (
    <div
      className="reader-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby={headingId}
      data-testid="link-confirm"
      onKeyDown={onKeyDown}
    >
      <h2 id={headingId}>{t('readerLinkConfirmTitle')}</h2>
      <p>{t('readerLinkConfirmBody', url)}</p>
      <div className="clavis-actions">
        <button type="button" className="clavis-button clavis-button--primary" onClick={onOpen}>
          {t('readerLinkOpen')}
        </button>
        <button
          ref={cancel}
          type="button"
          className="clavis-button"
          onClick={() => onAnswer(false)}
        >
          {t('readerLinkCancel')}
        </button>
      </div>
    </div>
  );
}

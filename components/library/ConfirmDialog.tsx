import { useEffect, useId, useRef, type KeyboardEvent, type MouseEvent } from 'react';
import { t } from '../../lib/i18n';

/**
 * Pointer activations of the confirm button are ignored this long after the dialog appears, and
 * any part of a double click (the same guard as the reader's link dialog): a click meant for the
 * button under the dialog must not confirm it.
 */
export const CONFIRM_GUARD_MS = 500;

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  /** The confirm button is the destructive one (deleting). */
  danger?: boolean;
  onAnswer(confirmed: boolean): void;
}

/**
 * A modal question with two buttons. Focus lands on Cancel (the safe default), Tab stays inside,
 * Escape cancels, and focus returns to what had it before. Text only; nothing here is HTML.
 */
export function ConfirmDialog({ title, body, confirmLabel, danger = false, onAnswer }: Props) {
  const headingId = useId();
  const bodyId = useId();
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

  const onConfirm = (event: MouseEvent): void => {
    const pointer = event.detail > 0;
    if (pointer && (event.detail > 1 || performance.now() - mountedAt.current < CONFIRM_GUARD_MS)) {
      return;
    }
    onAnswer(true);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onAnswer(false);
    } else if (event.key === 'Tab') {
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
    <div className="library-modal">
      <div
        className="library-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={bodyId}
        data-testid="library-dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id={headingId} dir="auto">
          {title}
        </h2>
        <p id={bodyId} dir="auto">
          {body}
        </p>
        <div className="clavis-actions">
          <button
            type="button"
            className={`clavis-button${danger ? ' clavis-button--danger' : ' clavis-button--primary'}`}
            data-testid="library-dialog-confirm"
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
          <button
            ref={cancel}
            type="button"
            className="clavis-button"
            data-testid="library-dialog-cancel"
            onClick={() => onAnswer(false)}
          >
            {t('libraryCancel')}
          </button>
        </div>
      </div>
    </div>
  );
}

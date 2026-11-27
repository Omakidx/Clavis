import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { t } from '../../lib/i18n';

interface Props {
  title: string;
  confirmLabel: string;
  danger?: boolean;
  /** Extra content between the text and the buttons (the keep-a-copy checkbox). */
  children?: ReactNode;
  body: string;
  onAnswer(confirmed: boolean): void;
}

/**
 * Modal question for the account actions. Focus starts on Cancel (the safe default), Tab stays
 * inside, Escape cancels, and focus goes back to where it was.
 */
export function AccountDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  children,
  onAnswer,
}: Props) {
  const headingId = useId();
  const bodyId = useId();
  const cancel = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancel.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onAnswer(false);
    } else if (event.key === 'Tab') {
      const focusable = Array.from(
        event.currentTarget.querySelectorAll<HTMLElement>('button, input'),
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
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
    <div className="account-modal">
      <div
        className="account-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={bodyId}
        data-testid="account-dialog"
        onKeyDown={onKeyDown}
      >
        <h2 id={headingId}>{title}</h2>
        <p id={bodyId}>{body}</p>
        {children}
        <div className="clavis-actions">
          <button
            ref={cancel}
            type="button"
            className="clavis-button"
            data-testid="account-dialog-cancel"
            onClick={() => onAnswer(false)}
          >
            {t('accountCancel')}
          </button>
          <button
            type="button"
            className={`clavis-button${danger ? ' clavis-button--danger' : ' clavis-button--primary'}`}
            data-testid="account-dialog-confirm"
            onClick={() => onAnswer(true)}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

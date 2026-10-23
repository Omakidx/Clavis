import { useEffect, useRef } from 'react';
import type { ComponentPropsWithRef, ReactNode, RefObject } from 'react';
import type { ClientError } from '../../lib/ui-client/errors';
import { t } from '../../lib/i18n';

type ButtonVariant = 'default' | 'primary' | 'danger' | 'link';

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
  default: '',
  primary: ' clavis-button--primary',
  danger: ' clavis-button--danger',
  link: ' clavis-button--link',
};

/** A native button; `type` defaults to "button" so it never submits a form by accident. */
export function Button({ variant = 'default', className, type = 'button', ...rest }: ButtonProps) {
  const classes = `clavis-button${VARIANT_CLASS[variant]}${className ? ` ${className}` : ''}`;
  return <button type={type} className={classes} {...rest} />;
}

export type NoticeTone = 'info' | 'success' | 'warning' | 'danger';

interface NoticeProps {
  tone?: NoticeTone;
  children: ReactNode;
  id?: string;
}

/** A visible message with no live-region semantics. Use `LiveStatus` for announced updates. */
export function Notice({ tone = 'info', children, id }: NoticeProps) {
  return (
    <div id={id} className={`clavis-notice${tone === 'info' ? '' : ` clavis-notice--${tone}`}`}>
      {children}
    </div>
  );
}

interface LiveStatusProps {
  /** What to announce. Empty/absent: the region stays in the DOM, silent and invisible. */
  message: string | null | undefined;
  tone?: NoticeTone;
  /** `alert` interrupts (use for errors the user must see); `status` is polite. */
  role?: 'status' | 'alert';
}

/**
 * A polite live region that exists BEFORE it has anything to say (screen readers only announce
 * changes to regions that are already in the DOM). The wrapper is always rendered; the visible
 * notice appears inside it.
 */
export function LiveStatus({ message, tone = 'info', role = 'status' }: LiveStatusProps) {
  return (
    <div className="clavis-live" role={role} aria-live={role === 'alert' ? 'assertive' : 'polite'}>
      {message ? (
        <div className={`clavis-notice${tone === 'info' ? '' : ` clavis-notice--${tone}`}`}>
          <p>{message}</p>
        </div>
      ) : null}
    </div>
  );
}

interface ErrorNoticeProps {
  error: ClientError;
  /** Repeat the failed action. */
  onRetry?: (() => void) | undefined;
  /** Open Settings (for "update key", "connect" and "open settings"). */
  onOpenSettings?: (() => void) | undefined;
}

/** An error with the one action that can fix it. The text is always our own localized message. */
export function ErrorNotice({ error, onRetry, onOpenSettings }: ErrorNoticeProps) {
  let action: ReactNode = null;
  if (error.action === 'retry' && onRetry) {
    action = <Button onClick={onRetry}>{t('uiRetry')}</Button>;
  } else if (onOpenSettings && error.action === 'update-key') {
    action = <Button onClick={onOpenSettings}>{t('uiUpdateKey')}</Button>;
  } else if (onOpenSettings && error.action === 'connect') {
    action = <Button onClick={onOpenSettings}>{t('uiConnectGroq')}</Button>;
  } else if (onOpenSettings && error.action === 'open-settings') {
    action = <Button onClick={onOpenSettings}>{t('uiOpenSettings')}</Button>;
  }
  return (
    <div role="alert" className="clavis-notice clavis-notice--danger" data-error-code={error.code}>
      <p>{error.message}</p>
      {error.hint ? <p className="clavis-hint">{error.hint}</p> : null}
      {action ? <div className="clavis-actions">{action}</div> : null}
    </div>
  );
}

/**
 * Move keyboard focus to `ref` whenever `trigger` changes (not on first render, where the
 * browser's own initial focus applies). Used for wizard step headings so screen-reader and
 * keyboard users land on the new content.
 */
export function useFocusOnChange(ref: RefObject<HTMLElement | null>, trigger: unknown): void {
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    ref.current?.focus();
  }, [ref, trigger]);
}

interface ExternalLinkProps {
  href: string;
  children: ReactNode;
  className?: string;
}

/** A link to another site: new tab, no opener, and the new tab is announced to screen readers. */
export function ExternalLink({ href, children, className }: ExternalLinkProps) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" {...(className ? { className } : {})}>
      {children}
      <span className="clavis-sr-only"> {t('uiOpensInNewTab')}</span>
    </a>
  );
}

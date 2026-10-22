import { useId } from 'react';
import { t } from '../../lib/i18n';

interface LinkConfirmProps {
  url: string;
  onAnswer: (open: boolean) => void;
}

/** External links in a PDF open only after this confirmation (architecture section 8). */
export function LinkConfirm({ url, onAnswer }: LinkConfirmProps) {
  const headingId = useId();
  return (
    <div
      className="reader-dialog"
      role="alertdialog"
      aria-labelledby={headingId}
      data-testid="link-confirm"
    >
      <h2 id={headingId}>{t('readerLinkConfirmTitle')}</h2>
      <p>{t('readerLinkConfirmBody', url)}</p>
      <div className="page__actions">
        <button type="button" className="button button--primary" onClick={() => onAnswer(true)}>
          {t('readerLinkOpen')}
        </button>
        <button type="button" className="button" onClick={() => onAnswer(false)}>
          {t('readerLinkCancel')}
        </button>
      </div>
    </div>
  );
}

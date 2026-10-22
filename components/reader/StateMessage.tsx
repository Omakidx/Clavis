import { t } from '../../lib/i18n';
import { MAX_PDF_BYTES, MAX_PDF_PAGES } from '../../lib/pdf/limits';
import type { ReaderErrorCode, ReaderState } from '../../lib/pdf/state';

function errorText(code: ReaderErrorCode, limit: 'bytes' | 'pages' | undefined): string {
  switch (code) {
    case 'CORRUPT':
      return t('readerErrorCorrupt');
    case 'PERMISSION':
      return t('readerErrorPermission');
    case 'TOO_LARGE':
      if (limit === 'pages') return t('readerErrorTooManyPages', String(MAX_PDF_PAGES));
      return t('readerErrorTooLarge', String(Math.round(MAX_PDF_BYTES / (1024 * 1024))));
    case 'UNSUPPORTED':
      return t('readerErrorUnsupported');
  }
}

/** Message for the non-document states. `ready` and `password-required` render nothing here. */
export function StateMessage({ state, dragging }: { state: ReaderState; dragging: boolean }) {
  switch (state.phase) {
    case 'empty':
      return (
        <p className="reader-message" data-testid="state-empty">
          {dragging ? t('readerDropActive') : t('readerEmptyHint')}
        </p>
      );
    case 'loading':
      return (
        <p className="reader-message" role="status" data-testid="state-loading">
          {t('readerLoading', state.name)}
        </p>
      );
    case 'error':
      return (
        <p
          className="reader-message reader-message--error"
          role="alert"
          data-testid="state-error"
          data-code={state.code}
        >
          {errorText(state.code, state.limit)}
        </p>
      );
    case 'image-only':
      return (
        <p className="reader-banner" role="status" data-testid="state-image-only">
          {t('readerImageOnly')}
        </p>
      );
    default:
      return null;
  }
}

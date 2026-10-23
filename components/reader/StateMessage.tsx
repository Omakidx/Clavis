import { SETTINGS_SECTION_ANCHORS } from '../../lib/config/constants';
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
    case 'RENDER':
      return t('readerErrorRender');
  }
}

interface StateMessageProps {
  state: ReaderState;
  /** A file is being dragged over the page. */
  dragging: boolean;
  /** Opens the file picker (the empty state's and the error states' action). */
  onOpen?: () => void;
}

/**
 * Message for the non-document states. `ready` and `password-required` render nothing here.
 * Every message is Clavis's own localized text chosen by state/code: nothing from the PDF (its
 * file name is the only exception and is rendered as a text node by React) reaches markup.
 */
export function StateMessage({ state, dragging, onOpen }: StateMessageProps) {
  switch (state.phase) {
    case 'empty':
      return (
        <section className="reader-empty" data-testid="state-empty" data-dragging={dragging}>
          <h2 className="reader-empty__title">{t('readerEmptyTitle')}</h2>
          <p>{t('readerEmptyBody')}</p>
          {onOpen ? (
            <div className="clavis-actions reader-empty__actions">
              <button
                type="button"
                className="clavis-button clavis-button--primary"
                onClick={onOpen}
              >
                {t('readerEmptyChoose')}
              </button>
            </div>
          ) : null}
          <p className="reader-empty__drop">
            {dragging ? t('readerDropActive') : t('readerEmptyHint')}
          </p>
          <p className="clavis-muted">{t('readerEmptyChrome')}</p>
          <p>
            {/* A plain link: the reader's first-load chunks must not pull in the shared UI module. */}
            <a
              href={`/options.html#${SETTINGS_SECTION_ANCHORS.pdfHelp}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('readerEmptyHelp')}
              <span className="clavis-sr-only"> {t('uiOpensInNewTab')}</span>
            </a>
          </p>
          <p className="clavis-muted">{t('readerShortcutsHint')}</p>
        </section>
      );
    case 'loading':
      return (
        <div className="reader-message" role="status" data-testid="state-loading">
          <p>{t('readerLoading', state.name)}</p>
          {state.progress === undefined ? null : (
            <progress
              className="reader-progress"
              max={100}
              value={Math.round(state.progress * 100)}
              aria-label={t('readerLoading', state.name)}
              data-testid="state-progress"
            />
          )}
        </div>
      );
    case 'error':
      return (
        <div
          className="reader-message reader-message--error"
          role="alert"
          data-testid="state-error"
          data-code={state.code}
        >
          <p>{errorText(state.code, state.limit)}</p>
          {onOpen ? (
            <div className="clavis-actions reader-empty__actions">
              <button type="button" className="clavis-button" onClick={onOpen}>
                {t('readerChooseAnother')}
              </button>
            </div>
          ) : null}
        </div>
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

import { t } from '../../lib/i18n';
import { LIMITS } from '../../lib/config/constants';
import type { CapturedSelection } from './useSelectionSnapshot';

/** Spike-only developer panel: the last selection as a validated pdf SelectionSnapshot. */
export function SelectionPanel({ selection }: { selection: CapturedSelection | null }) {
  return (
    <section className="reader-selection" aria-labelledby="reader-selection-title">
      <h2 id="reader-selection-title">{t('readerSelectionTitle')}</h2>
      {selection ? (
        <div data-source={selection.snapshot.source} data-kind={selection.snapshot.kind}>
          <p data-testid="selection-page" data-page={selection.snapshot.page}>
            {t('readerSelectionPage', String(selection.snapshot.page ?? 0))}
          </p>
          <p data-testid="selection-text" className="reader-selection__text">
            {selection.snapshot.text}
          </p>
          {selection.truncated ? (
            <p>{t('readerSelectionTruncated', String(LIMITS.maxSelectionChars))}</p>
          ) : null}
        </div>
      ) : (
        <p data-testid="selection-none">{t('readerSelectionNone')}</p>
      )}
    </section>
  );
}

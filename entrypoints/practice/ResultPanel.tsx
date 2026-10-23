import { useId } from 'react';
import type { ReactNode } from 'react';
import { ErrorNotice } from '../../components/common/ui';
import { t } from '../../lib/i18n';
import { openSettingsPage } from '../../lib/ui-client/navigation';
import type { PracticeState } from './actions';

interface ResultPanelProps {
  state: PracticeState;
  onRetry(): void;
}

/**
 * Where Listen reports back. Explain does not: its answer opens in the explanation card
 * (components/explanation), exactly as on a web page. Plain text only (D-10).
 */
export function ResultPanel({ state, onRetry }: ResultPanelProps) {
  const headingId = useId();
  let body: ReactNode = <p className="clavis-muted">{t('explainPracticeResultEmpty')}</p>;

  if (state.kind === 'working') {
    body = <p>{t('practiceListening')}</p>;
  } else if (state.kind === 'speaking') {
    body = (
      <>
        <p>{t('practiceSelected', state.text)}</p>
        <p>{t('practiceListening')}</p>
      </>
    );
  }

  return (
    <section className="clavis-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('practiceResultTitle')}</h2>
      {state.kind === 'error' ? (
        <ErrorNotice error={state.error} onRetry={onRetry} onOpenSettings={openSettingsPage} />
      ) : (
        <div className="clavis-live" role="status" aria-live="polite" data-testid="practice-result">
          {body}
        </div>
      )}
    </section>
  );
}

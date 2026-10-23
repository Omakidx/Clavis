import { useId } from 'react';
import type { ReactNode } from 'react';
import { Button } from '../../components/common/ui';
import { t } from '../../lib/i18n';
import type { PracticeState } from './actions';

interface ResultPanelProps {
  state: PracticeState;
  /** Open Settings at the Voice section. */
  onOpenVoiceSettings(): void;
}

/**
 * Where Listen reports back (mirroring the toolbar). Explain does not: its answer opens in the
 * explanation card (components/explanation), exactly as on a web page. Plain text only (D-10).
 */
export function ResultPanel({ state, onOpenVoiceSettings }: ResultPanelProps) {
  const headingId = useId();
  let body: ReactNode = <p className="clavis-muted">{t('explainPracticeResultEmpty')}</p>;

  if (state.kind === 'starting') {
    body = <p>{t('speechStarting')}</p>;
  } else if (state.kind === 'playing') {
    body = (
      <>
        <p>{t('practiceSelected', state.text)}</p>
        <p>{t('practiceListening')}</p>
      </>
    );
  } else if (state.kind === 'ended') {
    body = (
      <>
        <p>{t('practiceSelected', state.text)}</p>
        <p>{t('listenDone')}</p>
      </>
    );
  } else if (state.kind === 'stopped') {
    body = <p>{t('speechStopped')}</p>;
  } else if (state.kind === 'problem') {
    body = (
      <div className="clavis-notice clavis-notice--danger" data-testid="practice-problem">
        <p>{state.message}</p>
        {state.hint === '' ? null : <p className="clavis-hint">{state.hint}</p>}
        {state.voiceSettings ? (
          <div className="clavis-actions">
            <Button onClick={onOpenVoiceSettings}>{t('speechVoiceSettings')}</Button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <section className="clavis-section" aria-labelledby={headingId}>
      <h2 id={headingId}>{t('practiceResultTitle')}</h2>
      <div className="clavis-live" role="status" aria-live="polite" data-testid="practice-result">
        {body}
      </div>
    </section>
  );
}

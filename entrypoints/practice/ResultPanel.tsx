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
 * Where Listen and Explain report back. Plain text only (D-10): model output is rendered as
 * text nodes. The real explanation card is Phase 5; this panel exists to prove the path.
 */
export function ResultPanel({ state, onRetry }: ResultPanelProps) {
  const headingId = useId();
  let body: ReactNode = <p className="clavis-muted">{t('practiceResultEmpty')}</p>;

  if (state.kind === 'working') {
    body = <p>{state.action === 'listen' ? t('practiceListening') : t('practiceExplaining')}</p>;
  } else if (state.kind === 'speaking') {
    body = (
      <>
        <p>{t('practiceSelected', state.text)}</p>
        <p>{t('practiceListening')}</p>
      </>
    );
  } else if (state.kind === 'explained') {
    const { result } = state;
    body = (
      <div data-testid="explain-result">
        <p>{t('practiceSelected', state.text)}</p>
        <h3>{result.title}</h3>
        <p>{result.summary}</p>
        {result.contextualMeaning ? (
          <p>
            <strong>{t('practiceMeaning')}:</strong> {result.contextualMeaning}
          </p>
        ) : null}
        {result.definition ? (
          <p>
            <strong>{t('practiceDefinition')}:</strong> {result.definition}
          </p>
        ) : null}
        {result.examples ? (
          <>
            <p>
              <strong>{t('practiceExamples')}:</strong>
            </p>
            <ul>
              {result.examples.map((example, index) => (
                <li key={index}>{example.sentence}</li>
              ))}
            </ul>
          </>
        ) : null}
        {result.caveat ? (
          <p>
            <strong>{t('practiceCaveat')}:</strong> {result.caveat}
          </p>
        ) : null}
        <p className="clavis-muted">{t('practiceModel', result.model)}</p>
      </div>
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

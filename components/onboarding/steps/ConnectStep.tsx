import { useState } from 'react';
import { t } from '../../../lib/i18n';
import type { KeyOutcome } from '../../../lib/ui-client/key-flow';
import { Button, Notice } from '../../common/ui';
import { KeyConnectForm, KeyOutcomeNotice } from '../../settings/KeyConnectForm';
import { ResourceGate } from '../../settings/ResourceGate';
import type { StepContext } from '../StepTypes';

/**
 * Paste, choose where to keep it, and Connect. The three results stay distinct: working,
 * rejected by Groq, and "saved but could not be checked" (offline). Nothing blocks finishing
 * setup without a key (UJ-05).
 */
export function ConnectStep({ keys, skipKey, focusNext }: StepContext) {
  const [replacing, setReplacing] = useState(false);
  const [outcome, setOutcome] = useState<KeyOutcome | null>(null);

  async function retest() {
    setOutcome(null);
    setOutcome(await keys.test());
  }

  return (
    <ResourceGate resource={keys.resource}>
      {(status) =>
        status.hasKey && !replacing ? (
          <>
            {/* The form is gone once a key exists, so its result is shown here instead. */}
            <div className="clavis-live" role="status" aria-live="polite">
              {outcome !== null && outcome.kind !== 'error' ? (
                <KeyOutcomeNotice outcome={outcome} />
              ) : outcome === null ? (
                <Notice tone="success">
                  <p>
                    {status.last4 === null ? t('keyConnectedLive') : t('keyEnding', status.last4)}
                  </p>
                </Notice>
              ) : null}
            </div>
            {outcome?.kind === 'error' ? (
              <KeyOutcomeNotice outcome={outcome} onRetry={() => void retest()} />
            ) : null}
            <div className="clavis-actions">
              <Button disabled={keys.busy !== 'idle'} onClick={() => void retest()}>
                {t('keyTest')}
              </Button>
              <Button
                onClick={() => {
                  setOutcome(null);
                  setReplacing(true);
                }}
              >
                {t('keyChange')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <KeyConnectForm
              busy={keys.busy === 'connecting'}
              onConnect={keys.connect}
              onOutcome={(result) => {
                if (result.kind !== 'error') {
                  setReplacing(false);
                  setOutcome(result);
                  focusNext();
                }
              }}
            />
            {status.hasKey ? null : (
              <>
                <div className="clavis-actions">
                  <Button onClick={skipKey}>{t('onbSkipKey')}</Button>
                </div>
                <p className="clavis-muted">{t('onbSkipKeyHint')}</p>
              </>
            )}
          </>
        )
      }
    </ResourceGate>
  );
}

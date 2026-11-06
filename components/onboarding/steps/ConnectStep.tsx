import { useState } from 'react';
import type { KeyVerification } from '../../../lib/contracts/setup';
import { t } from '../../../lib/i18n';
import type { KeyOutcome } from '../../../lib/ui-client/key-flow';
import { GROQ_KEYS_URL } from '../../../lib/ui-client/links';
import { Button, ExternalLink } from '../../common/ui';
import { KeyConnectForm, KeyOutcomeNotice } from '../../settings/KeyConnectForm';
import { ResourceGate } from '../../settings/ResourceGate';
import type { StepContext } from '../StepTypes';

const VERIFICATION_KIND = {
  valid: 'valid',
  invalid: 'invalid',
  unverified: 'unverified',
  never: 'unchecked',
} as const satisfies Record<KeyVerification, KeyOutcome['kind']>;

/** Get a Groq key and connect it in one step, while keeping every verification result distinct. */
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
            <div className="clavis-live" role="status" aria-live="polite">
              <KeyOutcomeNotice
                outcome={
                  outcome !== null && outcome.kind !== 'error'
                    ? outcome
                    : { kind: VERIFICATION_KIND[status.verification], status }
                }
              />
            </div>
            {outcome?.kind === 'error' ? (
              <KeyOutcomeNotice outcome={outcome} onRetry={() => void retest()} />
            ) : null}
            <div className="clavis-actions">
              <Button disabled={keys.busy !== 'idle'} onClick={() => void retest()}>
                {keys.busy === 'testing' ? t('keyResultChecking') : t('keyTest')}
              </Button>
              <Button
                disabled={keys.busy !== 'idle'}
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
            {status.hasKey ? (
              <div className="clavis-actions">
                <Button disabled={keys.busy !== 'idle'} onClick={() => setReplacing(false)}>
                  {t('uiCancel')}
                </Button>
              </div>
            ) : (
              <div className="clavis-onboarding__key-guide">
                <p>
                  {t('onbGetKeyIntro')}{' '}
                  <ExternalLink href={GROQ_KEYS_URL}>{t('onbGetKeyLink')}</ExternalLink>
                </p>
                <details>
                  <summary>{t('onbKeyStepsSummary')}</summary>
                  <ol>
                    <li>{t('onbGetKeyStep1')}</li>
                    <li>{t('onbGetKeyStep2')}</li>
                  </ol>
                </details>
              </div>
            )}
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
                  <Button disabled={keys.busy !== 'idle'} onClick={skipKey}>
                    {t('onbSkipKey')}
                  </Button>
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

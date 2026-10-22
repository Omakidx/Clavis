import { useEffect, useId, useRef, useState } from 'react';
import type { KeyStatus, KeyVerification } from '../../lib/contracts/setup';
import { t } from '../../lib/i18n';
import type { KeyOutcome } from '../../lib/ui-client/key-flow';
import type { KeyStatusHook } from '../../lib/ui-client/use-key-status';
import type { ClientError } from '../../lib/ui-client/errors';
import { GROQ_KEYS_URL } from '../../lib/ui-client/links';
import { Button, ErrorNotice, ExternalLink, LiveStatus, Notice } from '../common/ui';
import { KeyConnectForm, KeyOutcomeNotice } from './KeyConnectForm';
import { ResourceGate } from './ResourceGate';

const STATUS_TEXT = {
  valid: 'keyStatusValid',
  invalid: 'keyStatusInvalid',
  unverified: 'keyStatusUnverified',
  never: 'keyStatusNever',
} as const satisfies Record<KeyVerification, string>;

const STATUS_BADGE = {
  valid: 'success',
  invalid: 'danger',
  unverified: 'warning',
  never: 'warning',
} as const satisfies Record<KeyVerification, string>;

function formatChecked(verifiedAt: number | null): string {
  if (verifiedAt === null) return t('keyNeverChecked');
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(verifiedAt),
  );
}

interface ApiKeySectionProps {
  keys: KeyStatusHook;
}

/** Settings: key status, test, change and remove (FR-004, FR-007, FR-071). */
export function ApiKeySection({ keys }: ApiKeySectionProps) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);
  const [changing, setChanging] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [testOutcome, setTestOutcome] = useState<KeyOutcome | null>(null);
  const [removed, setRemoved] = useState(false);
  const [removeError, setRemoveError] = useState<ClientError | null>(null);

  // Opening the confirmation moves focus to its safe choice (Cancel).
  useEffect(() => {
    if (confirming) confirmCancelRef.current?.focus();
  }, [confirming]);

  async function runTest() {
    setTestOutcome(null);
    setRemoved(false);
    setTestOutcome(await keys.test());
  }

  async function runRemove() {
    setRemoveError(null);
    const result = await keys.remove();
    setConfirming(false);
    if (result.ok) {
      setRemoved(true);
      setChanging(false);
      setTestOutcome(null);
      // The button that had focus is gone; keep keyboard users in this section.
      headingRef.current?.focus();
    } else {
      setRemoveError(result.error);
    }
  }

  const busy = keys.busy !== 'idle';

  return (
    <section className="clavis-section" aria-labelledby={headingId} id="section-key">
      <h2 id={headingId} tabIndex={-1} ref={headingRef}>
        {t('keyTitle')}
      </h2>

      <ResourceGate resource={keys.resource}>
        {(status: KeyStatus) => (
          <>
            {status.hasKey ? (
              <>
                <dl className="clavis-facts" data-testid="key-facts">
                  <dt>{t('keyFactStatus')}</dt>
                  <dd>
                    <span
                      className={`clavis-badge clavis-badge--${STATUS_BADGE[status.verification]}`}
                    >
                      {t(STATUS_TEXT[status.verification])}
                    </span>
                  </dd>
                  <dt>{t('keyFactKey')}</dt>
                  <dd>{status.last4 === null ? '' : t('keyEnding', status.last4)}</dd>
                  <dt>{t('keyFactStorage')}</dt>
                  <dd>
                    {status.storage === 'session'
                      ? t('keyStorageSessionShort')
                      : t('keyStorageLocalShort')}
                  </dd>
                  <dt>{t('keyFactChecked')}</dt>
                  <dd>{formatChecked(status.verifiedAt)}</dd>
                </dl>

                {status.verification === 'invalid' ? (
                  <Notice tone="danger">
                    <p>{t('errInvalidApiKey')}</p>
                  </Notice>
                ) : null}

                {confirming ? (
                  <div
                    className="clavis-notice clavis-notice--warning"
                    role="alertdialog"
                    aria-labelledby={`${headingId}-confirm`}
                    aria-describedby={`${headingId}-confirm-body`}
                  >
                    <h3 id={`${headingId}-confirm`}>{t('keyRemoveTitle')}</h3>
                    <p id={`${headingId}-confirm-body`}>{t('keyRemoveBody')}</p>
                    <p>
                      {t('keyRemoveGroqNote')}{' '}
                      <ExternalLink href={GROQ_KEYS_URL}>{t('keyRemoveGroqLink')}</ExternalLink>
                    </p>
                    <div className="clavis-actions">
                      <Button variant="danger" disabled={busy} onClick={() => void runRemove()}>
                        {t('keyRemove')}
                      </Button>
                      <Button ref={confirmCancelRef} onClick={() => setConfirming(false)}>
                        {t('uiCancel')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="clavis-actions">
                    <Button disabled={busy} onClick={() => void runTest()}>
                      {keys.busy === 'testing' ? t('keyResultChecking') : t('keyTest')}
                    </Button>
                    <Button
                      disabled={busy}
                      aria-expanded={changing}
                      onClick={() => setChanging((open) => !open)}
                    >
                      {t('keyChange')}
                    </Button>
                    <Button disabled={busy} onClick={() => setConfirming(true)}>
                      {t('keyRemove')}
                    </Button>
                  </div>
                )}

                <div className="clavis-live" role="status" aria-live="polite">
                  {testOutcome !== null && testOutcome.kind !== 'error' ? (
                    <KeyOutcomeNotice outcome={testOutcome} />
                  ) : null}
                </div>
                {testOutcome?.kind === 'error' ? (
                  <KeyOutcomeNotice outcome={testOutcome} onRetry={() => void runTest()} />
                ) : null}
                {removeError ? (
                  <ErrorNotice error={removeError} onRetry={() => setConfirming(true)} />
                ) : null}
              </>
            ) : (
              <>
                <Notice>
                  <p>{t('keyNone')}</p>
                  <p>{t('keyNoneHint')}</p>
                </Notice>
              </>
            )}

            <LiveStatus message={removed ? t('keyRemoved') : null} tone="success" />

            {!status.hasKey || changing ? (
              <div className="clavis-stack">
                <h3>{status.hasKey ? t('keyChange') : t('uiConnectGroq')}</h3>
                <KeyConnectForm
                  busy={keys.busy === 'connecting'}
                  onConnect={async (apiKey, storage) => {
                    setRemoved(false);
                    setTestOutcome(null);
                    const outcome = await keys.connect(apiKey, storage);
                    if (outcome.kind !== 'error') {
                      setChanging(false);
                      // The form closes (or disappears once a key exists): show the result here.
                      setTestOutcome(outcome);
                    }
                    return outcome;
                  }}
                />
              </div>
            ) : null}

            <Notice tone="warning">
              <p>{t('keyNotEncrypted')}</p>
            </Notice>
          </>
        )}
      </ResourceGate>
    </section>
  );
}

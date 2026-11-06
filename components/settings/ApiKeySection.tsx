import { useEffect, useId, useRef, useState } from 'react';
import type { KeyStatus, KeyVerification } from '../../lib/contracts/setup';
import { t } from '../../lib/i18n';
import type { KeyOutcome } from '../../lib/ui-client/key-flow';
import type { KeyStatusHook } from '../../lib/ui-client/use-key-status';
import type { ClientError } from '../../lib/ui-client/errors';
import { GROQ_KEYS_URL } from '../../lib/ui-client/links';
import { Button, ErrorNotice, ExternalLink, LiveStatus, Notice } from '../common/ui';
import { useToast } from '../common/Toast';
import { KeyConnectForm, KeyOutcomeNotice, KeyVerificationResponse } from './KeyConnectForm';
import { ResourceGate } from './ResourceGate';
import { GroqIcon, InfoIcon } from './SettingsIcon';

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
  active?: boolean;
}

/** Settings: key status, test, change and remove (FR-004, FR-007, FR-071). */
export function ApiKeySection({ keys, active = true }: ApiKeySectionProps) {
  const toast = useToast();
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

  useEffect(() => {
    if (active) return;
    const frame = window.requestAnimationFrame(() => {
      setChanging(false);
      setConfirming(false);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [active]);

  async function runTest() {
    setTestOutcome(null);
    setRemoved(false);
    toast?.show({ content: t('keyResultChecking'), durationMs: 0 });
    const outcome = await keys.test();
    setTestOutcome(outcome);
    toast?.show({
      content: <KeyOutcomeNotice outcome={outcome} onRetry={() => void runTest()} />,
      tone:
        outcome.kind === 'valid'
          ? 'success'
          : outcome.kind === 'invalid' || outcome.kind === 'error'
            ? 'danger'
            : 'warning',
    });
  }

  async function runRemove() {
    setRemoveError(null);
    const result = await keys.remove();
    setConfirming(false);
    if (result.ok) {
      setRemoved(true);
      toast?.show({ content: t('keyRemoved'), tone: 'success' });
      setChanging(false);
      setTestOutcome(null);
      // The button that had focus is gone; keep keyboard users in this section.
      headingRef.current?.focus();
    } else {
      setRemoveError(result.error);
      toast?.show({
        content: <ErrorNotice error={result.error} onRetry={() => setConfirming(true)} />,
        tone: 'danger',
      });
    }
  }

  const busy = keys.busy !== 'idle';

  return (
    <section
      className="clavis-section"
      aria-labelledby={headingId}
      aria-busy={busy}
      id="section-key"
    >
      <h2 id={headingId} tabIndex={-1} ref={headingRef}>
        <GroqIcon />
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
                  {(status.verificationHttpStatus !== undefined ||
                    status.verification === 'unverified') && (
                    <>
                      <dt>{t('keyFactResponse')}</dt>
                      <dd>
                        <KeyVerificationResponse
                          status={status.verificationHttpStatus}
                          reason={status.forbiddenReason}
                          probe={status.accessProbe}
                          showCopy
                        />
                      </dd>
                    </>
                  )}
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

                {!toast && (
                  <div className="clavis-live" role="status" aria-live="polite">
                    {testOutcome !== null && testOutcome.kind !== 'error' ? (
                      <KeyOutcomeNotice outcome={testOutcome} />
                    ) : null}
                  </div>
                )}
                {!toast && testOutcome?.kind === 'error' ? (
                  <KeyOutcomeNotice outcome={testOutcome} onRetry={() => void runTest()} />
                ) : null}
                {!toast && removeError ? (
                  <ErrorNotice error={removeError} onRetry={() => setConfirming(true)} />
                ) : null}
              </>
            ) : (
              <>
                <Notice>
                  <p>{t('keyNone')}</p>
                  <p>{t('keyNoneHint')}</p>
                  <p>
                    <ExternalLink href={GROQ_KEYS_URL}>{t('keyGetLink')}</ExternalLink>
                  </p>
                </Notice>
              </>
            )}

            {!toast ? (
              <LiveStatus message={removed ? t('keyRemoved') : null} tone="success" />
            ) : null}

            {!status.hasKey || changing ? (
              <div className="clavis-stack">
                <div className="clavis-key-form-heading">
                  <h3>{status.hasKey ? t('keyChange') : t('uiConnectGroq')}</h3>
                  {status.hasKey ? (
                    <Button disabled={busy} onClick={() => setChanging(false)}>
                      {t('uiCancel')}
                    </Button>
                  ) : null}
                </div>
                {active ? (
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
                        window.requestAnimationFrame(() => headingRef.current?.focus());
                      }
                      return outcome;
                    }}
                  />
                ) : null}
              </div>
            ) : null}

            <Notice tone="warning">
              <p className="clavis-key-storage-note">
                <InfoIcon />
                <span>{t('keyNotEncrypted')}</span>
              </p>
            </Notice>
          </>
        )}
      </ResourceGate>
    </section>
  );
}

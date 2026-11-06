import { useEffect, useRef, useState } from 'react';
import { t } from '../../../lib/i18n';
import { api } from '../../../lib/ui-client/api';
import type { ClientError } from '../../../lib/ui-client/errors';
import { openExtensionPage, openSettingsPage } from '../../../lib/ui-client/navigation';
import { Button, ErrorNotice, LiveStatus, Notice } from '../../common/ui';
import { ResourceGate } from '../../settings/ResourceGate';
import { SiteAccessHelp } from '../../settings/SiteAccessHelp';
import type { StepContext } from '../StepTypes';

const NONWORKING_KEY_SUMMARY = {
  invalid: 'keyStatusInvalid',
  unverified: 'keyStatusUnverified',
  never: 'keyStatusNever',
} as const;

/** Summary and "Finish setup" (UPDATE_ONBOARDING completed:true). */
export function DoneStep({ settings, keys }: StepContext) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [justFinished, setJustFinished] = useState(false);
  const settingsButton = useRef<HTMLButtonElement>(null);
  const keyState = keys.resource.state;
  const hasKey = keyState.status === 'ready' && keyState.data.hasKey;
  const keySummary =
    keyState.status !== 'ready' || !keyState.data.hasKey
      ? t('onbSummaryNotConnected')
      : keyState.data.verification === 'valid'
        ? t('onbSummaryConnected')
        : t(NONWORKING_KEY_SUMMARY[keyState.data.verification]);

  async function finish() {
    setBusy(true);
    setError(null);
    const result = await settings.adopt(api.updateOnboarding({ completed: true }));
    setBusy(false);
    if (result.ok) setJustFinished(true);
    else setError(result.error);
  }

  // "Finish setup" disappears once it worked; keep keyboard focus inside the step.
  useEffect(() => {
    if (justFinished) settingsButton.current?.focus();
  }, [justFinished]);

  return (
    <ResourceGate resource={settings.resource}>
      {(snapshot) => (
        <>
          <p>{t('onbDoneBody')}</p>
          <h3>{t('onbSummaryHeading')}</h3>
          <dl className="clavis-facts" data-testid="setup-summary">
            <dt>{t('onbSummaryGroq')}</dt>
            <dd>{keySummary}</dd>
            <dt>{t('onbSummaryAccess')}</dt>
            <dd>
              {snapshot.onboarding.siteAccessChoice === 'granted'
                ? t('onbSummaryOn')
                : t('onbSummaryOff')}
            </dd>
          </dl>
          {hasKey ? null : (
            <Notice tone="warning">
              <p>{t('onbDoneNoKey')}</p>
            </Notice>
          )}
          {snapshot.onboarding.siteAccessChoice === 'granted' ? null : <SiteAccessHelp />}
          {snapshot.onboarding.completed ? null : (
            <div className="clavis-actions">
              <Button variant="primary" disabled={busy} onClick={() => void finish()}>
                {t('onbDoneFinish')}
              </Button>
            </div>
          )}
          <LiveStatus
            message={snapshot.onboarding.completed ? t('onbDoneSaved') : null}
            tone="success"
          />
          {error ? <ErrorNotice error={error} onRetry={() => void finish()} /> : null}
          {snapshot.onboarding.completed ? (
            <div className="clavis-actions">
              <Button ref={settingsButton} onClick={openSettingsPage}>
                {t('uiOpenSettings')}
              </Button>
              <Button onClick={() => openExtensionPage('/reader.html')}>
                {t('popupOpenReader')}
              </Button>
            </div>
          ) : null}
        </>
      )}
    </ResourceGate>
  );
}

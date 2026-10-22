import { useState } from 'react';
import { t } from '../../../lib/i18n';
import { api } from '../../../lib/ui-client/api';
import type { ClientError } from '../../../lib/ui-client/errors';
import { Button, ErrorNotice, LiveStatus } from '../../common/ui';
import { DisclosureList } from '../../settings/DisclosureList';
import { ResourceGate } from '../../settings/ResourceGate';
import type { StepContext } from '../StepTypes';

/**
 * FR-002: the approved data disclosure (D-16 copy, unchanged) and the acknowledgement that
 * must happen before anything can be sent to Groq. "I understand" sends ACCEPT_DISCLOSURE.
 */
export function DisclosureStep({ settings, focusNext }: StepContext) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  async function accept() {
    setBusy(true);
    setError(null);
    const result = await settings.adopt(api.acceptDisclosure());
    setBusy(false);
    if (result.ok) {
      setJustSaved(true);
      focusNext();
    } else {
      setError(result.error);
    }
  }

  return (
    <ResourceGate resource={settings.resource}>
      {(snapshot) => {
        const accepted = snapshot.onboarding.disclosureAcceptedAt !== null;
        return (
          <>
            <DisclosureList />
            {accepted ? null : (
              <div className="clavis-actions">
                <Button variant="primary" disabled={busy} onClick={() => void accept()}>
                  {t('disclosureAccept')}
                </Button>
              </div>
            )}
            <LiveStatus
              message={
                accepted ? (justSaved ? t('onbDisclosureSaved') : t('onbDisclosureAccepted')) : null
              }
              tone="success"
            />
            {error ? <ErrorNotice error={error} onRetry={() => void accept()} /> : null}
          </>
        );
      }}
    </ResourceGate>
  );
}

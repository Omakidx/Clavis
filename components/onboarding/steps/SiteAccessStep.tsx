import { useState } from 'react';
import { t } from '../../../lib/i18n';
import type { SiteAccessChoice } from '../../../lib/contracts/setup';
import { useSiteAccess, type SiteAccess } from '../../../lib/site-access/use-site-access';
import { api } from '../../../lib/ui-client/api';
import type { ClientError } from '../../../lib/ui-client/errors';
import { Button, ErrorNotice, LiveStatus } from '../../common/ui';
import { ResourceGate } from '../../settings/ResourceGate';
import type { StepContext } from '../StepTypes';

const REQUEST_TEXT = {
  pending: 'toolbarSiteAccessPending',
  granted: 'toolbarSiteAccessGranted',
  denied: 'toolbarSiteAccessDenied',
  skipped: 'toolbarSiteAccessSkipped',
  error: 'toolbarSiteAccessError',
} as const;

const CHOICE_TEXT = {
  granted: 'toolbarSiteAccessGranted',
  declined: 'toolbarSiteAccessSkipped',
} as const;

interface SiteAccessStepProps extends StepContext {
  /** Test seam; the wizard uses the real permission hook. */
  access?: SiteAccess;
}

/**
 * FR-009 / UJ-02b: optional all-sites access. "Enable on websites" asks Chrome for the
 * permission straight from the click (a user gesture is required); "Not now" is a complete,
 * equally supported answer. Either choice is stored so Clavis never asks again unprompted.
 */
export function SiteAccessStep({ settings, focusNext, access: injected }: SiteAccessStepProps) {
  const own = useSiteAccess();
  const access = injected ?? own;
  const [error, setError] = useState<ClientError | null>(null);

  async function persist(choice: SiteAccessChoice) {
    setError(null);
    const result = await settings.adopt(api.updateOnboarding({ siteAccessChoice: choice }));
    if (result.ok) focusNext();
    else setError(result.error);
  }

  function enable() {
    // Nothing may be awaited before this call: Chrome only shows the prompt inside the gesture.
    access.grant((outcome) => {
      if (outcome === 'granted') void persist('granted');
      else if (outcome === 'denied') void persist('declined');
      // 'error': nothing was decided; the status line says so and the button stays available.
    });
  }

  function notNow() {
    access.skip();
    void persist('declined');
  }

  return (
    <ResourceGate resource={settings.resource}>
      {(snapshot) => {
        const choice = snapshot.onboarding.siteAccessChoice;
        const statusKey =
          access.requestState !== 'idle'
            ? REQUEST_TEXT[access.requestState]
            : choice === 'unset'
              ? null
              : CHOICE_TEXT[choice];
        return (
          <>
            <p>{t('siteAccessBody')}</p>
            <div className="clavis-actions">
              {access.status === 'granted' ? null : (
                <Button
                  variant="primary"
                  disabled={access.requestState === 'pending'}
                  onClick={enable}
                >
                  {t('siteAccessGrant')}
                </Button>
              )}
              {access.status === 'granted' ? null : (
                <Button disabled={access.requestState === 'pending'} onClick={notNow}>
                  {t('siteAccessSkip')}
                </Button>
              )}
            </div>
            <LiveStatus
              message={statusKey === null ? null : t(statusKey)}
              tone={statusKey === 'toolbarSiteAccessGranted' ? 'success' : 'info'}
            />
            {error ? <ErrorNotice error={error} /> : null}
            <p>{t('onbAccessAlternative')}</p>
            <p className="clavis-muted">{t('onbAccessLater')}</p>
          </>
        );
      }}
    </ResourceGate>
  );
}

import { useEffect, useId, useState } from 'react';
import { browser } from 'wxt/browser';
import { t } from '../../lib/i18n';
import { useSiteAccess, type SiteAccess } from '../../lib/site-access/use-site-access';
import { api } from '../../lib/ui-client/api';
import { openChromeExtensionDetails } from '../../lib/ui-client/navigation';
import type { SettingsHook } from '../../lib/ui-client/use-settings';
import { useResource } from '../../lib/ui-client/use-resource';
import type { SiteAccessStatus } from '../../lib/contracts/setup';
import { Button, LiveStatus } from '../common/ui';
import { DisabledSites } from './DisabledSites';
import { ResourceGate } from './ResourceGate';

interface SiteAccessSectionProps {
  settings: SettingsHook;
  /** Test seam; the page uses the real permission hook. */
  access?: SiteAccess;
}

type Outcome = 'granted' | 'denied' | 'error' | 'removed' | 'remove-failed' | null;

const OUTCOME_TEXT = {
  granted: 'toolbarSiteAccessGranted',
  denied: 'toolbarSiteAccessDenied',
  error: 'toolbarSiteAccessError',
  removed: 'siteRevoked',
  'remove-failed': 'toolbarSiteAccessError',
} as const;

/** Settings: website access (FR-009) and the per-site disable list. */
export function SiteAccessSection({ settings, access: injected }: SiteAccessSectionProps) {
  const headingId = useId();
  const own = useSiteAccess();
  const access = injected ?? own;
  const status = useResource(api.getSiteAccessStatus);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const { refresh } = status;

  // Chrome's own Site-access switch changes permissions without going through this page.
  useEffect(() => {
    browser.permissions.onAdded.addListener(refresh);
    browser.permissions.onRemoved.addListener(refresh);
    return () => {
      browser.permissions.onAdded.removeListener(refresh);
      browser.permissions.onRemoved.removeListener(refresh);
    };
  }, [refresh]);

  function enable() {
    // The Chrome prompt must be requested synchronously from this click (no await before it).
    access.grant((result) => {
      void (async () => {
        setOutcome(result);
        if (result === 'granted') await api.updateOnboarding({ siteAccessChoice: 'granted' });
        else if (result === 'denied') await api.updateOnboarding({ siteAccessChoice: 'declined' });
        refresh();
      })();
    });
  }

  async function remove() {
    const removed = await access.revoke();
    setOutcome(removed ? 'removed' : 'remove-failed');
    if (removed) await api.updateOnboarding({ siteAccessChoice: 'declined' });
    refresh();
  }

  return (
    <section className="clavis-section" aria-labelledby={headingId} id="section-site-access">
      <h2 id={headingId}>{t('siteTitle')}</h2>

      <ResourceGate resource={status}>
        {(info: SiteAccessStatus) => (
          <>
            <p data-testid="site-access-status">
              {info.granted
                ? info.registered
                  ? t('siteStatusOn')
                  : t('siteStatusNotStarted')
                : t('siteStatusOff')}
            </p>
            {info.granted ? (
              <>
                <p>{t('siteRevokeHelp')}</p>
                <div className="clavis-actions">
                  <Button onClick={() => void remove()}>{t('siteRevoke')}</Button>
                  <Button onClick={openChromeExtensionDetails}>{t('siteOpenExtensions')}</Button>
                </div>
              </>
            ) : (
              <div className="clavis-actions">
                <Button
                  variant="primary"
                  disabled={access.requestState === 'pending'}
                  onClick={enable}
                >
                  {t('siteAccessGrant')}
                </Button>
              </div>
            )}
          </>
        )}
      </ResourceGate>

      <LiveStatus
        message={
          access.requestState === 'pending'
            ? t('toolbarSiteAccessPending')
            : outcome === null
              ? null
              : t(OUTCOME_TEXT[outcome])
        }
        tone={outcome === 'granted' || outcome === 'removed' ? 'success' : 'info'}
      />

      <ResourceGate resource={settings.resource}>
        {(snapshot) => (
          <DisabledSites
            sites={snapshot.preferences.disabledSites}
            save={(sites) => settings.save({ disabledSites: sites })}
          />
        )}
      </ResourceGate>
    </section>
  );
}

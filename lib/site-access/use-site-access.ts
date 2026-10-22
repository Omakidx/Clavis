import { browser } from 'wxt/browser';
import { useCallback, useEffect, useState } from 'react';
import { OPTIONAL_SITE_ORIGINS } from '../config/constants';
import { hasSiteAccess } from './registration';

export type RequestOutcome = 'granted' | 'denied' | 'error';

/**
 * Ask Chrome for access to all http(s) sites. MUST be called synchronously from
 * a user gesture (a click handler): `permissions.request` rejects otherwise,
 * so nothing may be awaited before it.
 */
export async function requestSiteAccess(
  permissions: Pick<typeof browser.permissions, 'request'>,
): Promise<RequestOutcome> {
  try {
    return (await permissions.request({ origins: [...OPTIONAL_SITE_ORIGINS] }))
      ? 'granted'
      : 'denied';
  } catch {
    return 'error';
  }
}

export type SiteAccessStatus = 'unknown' | 'granted' | 'not-granted';
export type SiteAccessRequestState = 'idle' | 'pending' | 'skipped' | RequestOutcome;

export interface SiteAccess {
  status: SiteAccessStatus;
  requestState: SiteAccessRequestState;
  /** Click handler for the "Enable on websites" button. */
  grant(): void;
  /** Click handler for "Not now". */
  skip(): void;
}

/** Live site-access state for extension pages (onboarding, popup, later settings). */
export function useSiteAccess(): SiteAccess {
  const [status, setStatus] = useState<SiteAccessStatus>('unknown');
  const [requestState, setRequestState] = useState<SiteAccessRequestState>('idle');

  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void hasSiteAccess(browser.permissions).then((granted) => {
        if (alive) setStatus(granted ? 'granted' : 'not-granted');
      });
    };
    refresh();
    browser.permissions.onAdded.addListener(refresh);
    browser.permissions.onRemoved.addListener(refresh);
    return () => {
      alive = false;
      browser.permissions.onAdded.removeListener(refresh);
      browser.permissions.onRemoved.removeListener(refresh);
    };
  }, []);

  const grant = useCallback(() => {
    setRequestState('pending');
    void requestSiteAccess(browser.permissions).then((outcome) => {
      setRequestState(outcome);
      setStatus(outcome === 'granted' ? 'granted' : 'not-granted');
    });
  }, []);

  const skip = useCallback(() => setRequestState('skipped'), []);

  return { status, requestState, grant, skip };
}

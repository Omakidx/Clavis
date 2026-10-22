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

/** Remove the optional website access again (Settings). Resolves to whether Chrome removed it. */
export async function removeSiteAccess(
  permissions: Pick<typeof browser.permissions, 'remove'>,
): Promise<boolean> {
  try {
    return await permissions.remove({ origins: [...OPTIONAL_SITE_ORIGINS] });
  } catch {
    return false;
  }
}

export type SiteAccessStatus = 'unknown' | 'granted' | 'not-granted';
export type SiteAccessRequestState = 'idle' | 'pending' | 'skipped' | RequestOutcome;

export interface SiteAccess {
  status: SiteAccessStatus;
  requestState: SiteAccessRequestState;
  /**
   * Click handler for the "Enable on websites" button. The Chrome prompt is requested
   * synchronously; `onOutcome` (optional) receives the user's answer so callers can persist it.
   * Returns nothing so it can be used directly as a click handler.
   */
  grant(onOutcome?: (outcome: RequestOutcome) => void): void;
  /** Click handler for "Remove website access" (Settings). Resolves to whether it was removed. */
  revoke(): Promise<boolean>;
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

  const grant = useCallback((onOutcome?: (outcome: RequestOutcome) => void): void => {
    setRequestState('pending');
    // `requestSiteAccess` calls permissions.request before its first await, i.e. still inside
    // the click handler's user gesture. Nothing may be awaited above this line.
    void requestSiteAccess(browser.permissions).then((outcome) => {
      setRequestState(outcome);
      // A refusal must not downgrade an access that was already granted.
      if (outcome === 'granted') setStatus('granted');
      onOutcome?.(outcome);
    });
  }, []);

  const revoke = useCallback(async (): Promise<boolean> => {
    const removed = await removeSiteAccess(browser.permissions);
    if (removed) setStatus('not-granted');
    return removed;
  }, []);

  const skip = useCallback(() => setRequestState('skipped'), []);

  return { status, requestState, grant, revoke, skip };
}

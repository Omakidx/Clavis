import { useEffect } from 'react';
import { onAccountStatusChanged } from '../data/channel';
import { accountApi } from './account-api';
import { useResource, type Resource } from './use-resource';
import type { AccountStatus } from '../contracts/account';

/** How often a visible page asks the background how sync is doing. */
const POLL_MS = 5_000;

/**
 * The account status. The background signals every change (sync started or ended, sign-in,
 * sign-out) on the data channel, and the page also re-reads when it becomes visible or focused.
 * The poll stays as a fallback while the page is visible.
 */
export function useAccountStatus(): Resource<AccountStatus> {
  const resource = useResource(accountApi.getStatus);
  const { refresh } = resource;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    const stop = onAccountStatusChanged(refresh);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refresh);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refresh);
    };
  }, [refresh]);
  return resource;
}

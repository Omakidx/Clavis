/**
 * Re-authentication marker (design §8.4). Deleting the account needs a Google login from the last ten minutes.
 * Before navigating to Google we leave a short-lived marker in sessionStorage; when the callback lands on `/`
 * (it has no return-to parameter, by design) the landing page sees the marker and goes back to /account.
 * Storage may be unavailable (private mode, blocked): every access is guarded and the flow degrades to
 * "user opens Delete account again".
 */
const KEY = 'clavis.reauth-delete';
const MARKER_TTL_MS = 10 * 60_000;
/** The server accepts a login up to 10 minutes old; ask again a little earlier so the request cannot race it. */
export const FRESH_LOGIN_MS = 9.5 * 60_000;
export const REAUTH_URL = '/auth/google/start?reauth=1';

export const needsReauth = (authenticatedAt: number, now = Date.now()): boolean =>
  now - authenticatedAt > FRESH_LOGIN_MS;

export function setReauthMarker(now = Date.now()): void {
  try {
    sessionStorage.setItem(KEY, String(now + MARKER_TTL_MS));
  } catch {
    /* storage unavailable: the user just reopens Delete account after signing in */
  }
}

export function hasReauthMarker(now = Date.now()): boolean {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw !== null && Number(raw) > now;
  } catch {
    return false;
  }
}

export function clearReauthMarker(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

/** Router history state carried from the landing page to /account after a re-auth round trip. */
export interface ResumeState {
  reopenDelete?: boolean;
  reauthFailed?: boolean;
  /** The Google login was a different account than the signed-in one. */
  reauthMismatch?: boolean;
}

/** What the OAuth callback's fixed redirect to `/` says about a re-authentication (design §8.4). */
export function readReauthOutcome(
  search: string,
): 'done' | 'mismatch' | 'session' | 'failed' | null {
  const q = new URLSearchParams(search);
  if (q.get('reauth') === 'done') return 'done';
  if (q.get('signin') !== 'failed') return null;
  const reason = q.get('reason');
  if (reason === 'reauth_mismatch') return 'mismatch';
  return reason === 'reauth_session' ? 'session' : 'failed';
}

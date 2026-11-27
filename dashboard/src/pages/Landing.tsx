import { useEffect, useState } from 'react';
import { Redirect } from 'wouter';
import {
  clearReauthMarker,
  hasReauthMarker,
  readReauthOutcome,
  type ResumeState,
} from '../api/reauth';
import { useSession } from '../api/session';
import { PRIVACY_URL } from '../config';
import { ErrorState, Loading, usePage } from '../ui/page';

export function Landing() {
  const { state, retry } = useSession();
  const heading = usePage('Clavis', state.status !== 'loading');
  const failed = new URLSearchParams(window.location.search).get('signin') === 'failed';

  // A re-auth for account deletion was started in this tab: the OAuth callback always lands here.
  // Resume only when the callback says so (`reauth=done`/a failure) AND this tab left the marker: a stale
  // marker with a plain load of `/` must not reopen anything.
  const [{ outcome, marker }] = useState(() => ({
    outcome: readReauthOutcome(window.location.search),
    marker: hasReauthMarker(),
  }));
  const settled = state.status !== 'loading';
  useEffect(() => {
    if (!settled) return;
    clearReauthMarker();
    if (new URLSearchParams(window.location.search).get('reauth') !== null)
      window.history.replaceState(window.history.state, '', '/');
  }, [settled]);

  if (state.status === 'loading') return <Loading label="Loading…" />;
  if (state.status === 'signed-in') {
    if (marker && outcome) {
      const resume: ResumeState =
        outcome === 'done'
          ? { reopenDelete: true }
          : outcome === 'mismatch'
            ? { reauthFailed: true, reauthMismatch: true }
            : { reauthFailed: true };
      return <Redirect to="/account" replace state={resume} />;
    }
    return <Redirect to="/words" replace />;
  }

  return (
    <section className="hero" aria-labelledby="hero-title">
      <h1 id="hero-title" ref={heading} tabIndex={-1}>
        Your saved words and PDFs, wherever you read
      </h1>
      <p className="lead">
        Clavis helps you understand and pronounce text you select on webpages and in PDFs. A free
        Clavis account is optional: it keeps your saved words, chats and reading progress in sync
        between devices, and shows them here.
      </p>
      {state.status === 'error' ? <ErrorState failure={state.failure} onRetry={retry} /> : null}
      {state.status === 'signed-out' && state.deleted ? (
        <p className="notice notice--info" role="status">
          Your Clavis account was deleted.
        </p>
      ) : null}
      {state.status === 'signed-out' && (state.ended || outcome === 'session') ? (
        <p className="notice notice--info" role="status">
          Your session has ended. Sign in again to continue.
        </p>
      ) : null}
      {failed && outcome !== 'session' ? (
        <p className="notice notice--danger" role="alert">
          Sign-in did not complete. Try again.
        </p>
      ) : null}
      <p>
        <a className="btn btn--large" href="/auth/google/start">
          Sign in with Google
        </a>
      </p>
      <p className="muted">
        Clavis only uses your Google account to sign you in. Read the{' '}
        <a href={PRIVACY_URL} target="_blank" rel="noopener noreferrer">
          privacy policy<span className="sr-only"> (opens in a new tab)</span>
        </a>
        .
      </p>
    </section>
  );
}

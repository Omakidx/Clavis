import { Redirect } from 'wouter';
import { useSession } from '../api/session';
import { PRIVACY_URL } from '../config';
import { ErrorState, Loading, usePage } from '../ui/page';

export function Landing() {
  const { state, retry } = useSession();
  const heading = usePage('Clavis', state.status !== 'loading');
  const failed = new URLSearchParams(window.location.search).get('signin') === 'failed';

  if (state.status === 'loading') return <Loading label="Loading…" />;
  if (state.status === 'signed-in') return <Redirect to="/words" replace />;

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
      {state.status === 'signed-out' && state.ended ? (
        <p className="notice notice--info" role="status">
          Your session has ended. Sign in again to continue.
        </p>
      ) : null}
      {failed ? (
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

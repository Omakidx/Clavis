import { useEffect, useState } from 'react';
import type { AccountResponse } from '@shared/api-contract/endpoints';
import { describeFailure, isAbort } from '../api/client';
import { api, EXPORT_URL } from '../api/endpoints';
import { clearReauthMarker, needsReauth, type ResumeState } from '../api/reauth';
import { useSession } from '../api/session';
import { formatBytes, formatCount } from '../format';
import { ConfirmDialog } from '../ui/modal';
import { DeleteAccountDialog } from './DeleteAccountDialog';
import { ErrorState, Loading, usePage } from '../ui/page';

type Load =
  | { status: 'loading' }
  | { status: 'error'; failure: unknown }
  | { status: 'ready'; account: AccountResponse };

export function Account() {
  const [tick, setTick] = useState(0);
  return <AccountLoaded key={tick} onRetry={() => setTick((n) => n + 1)} />;
}

function AccountLoaded({ onRetry }: { onRetry(): void }) {
  const heading = usePage('Account');
  const { state, clear } = useSession();
  // Set by the landing page after a Google re-authentication round trip (see api/reauth.ts).
  const [resume] = useState<ResumeState>(() => (window.history.state ?? {}) as ResumeState);
  const authenticatedAt = state.status === 'signed-in' ? state.authenticatedAt : 0;
  const [deleting, setDeleting] = useState(() => resume.reopenDelete === true);
  const [reauth, setReauth] = useState(false);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState<'logout' | 'logout-all' | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    // The resume hint is single-use: a reload or a later visit must not reopen the dialog.
    if (resume.reopenDelete || resume.reauthFailed) window.history.replaceState(null, '');
    // Arriving without a resume: a leftover marker must not reopen the dialog later.
    if (!resume.reopenDelete) clearReauthMarker();
  }, [resume]);

  useEffect(() => {
    const ctl = new AbortController();
    api
      .account(ctl.signal)
      .then((account) => setLoad({ status: 'ready', account }))
      .catch((e: unknown) => {
        if (!isAbort(e)) setLoad({ status: 'error', failure: e });
      });
    return () => ctl.abort();
  }, []);

  const signOut = async (): Promise<void> => {
    setBusy('logout');
    setError(null);
    try {
      await api.logout();
      clear(false);
    } catch (e) {
      setError(e);
      setBusy(null);
    }
  };

  const signOutEverywhere = async (): Promise<void> => {
    setBusy('logout-all');
    setError(null);
    try {
      await api.logoutAll();
      clear(false);
    } catch (e) {
      setError(e);
      setBusy(null);
      setConfirmAll(false);
    }
  };

  return (
    <section>
      <h1 ref={heading} tabIndex={-1}>
        Account
      </h1>
      {load.status === 'loading' ? <Loading label="Loading account…" /> : null}
      {load.status === 'error' ? <ErrorState failure={load.failure} onRetry={onRetry} /> : null}
      {load.status === 'ready' ? (
        <>
          <h2>Profile</h2>
          <dl className="facts">
            <div>
              <dt>Email</dt>
              <dd className="break">{load.account.user.email}</dd>
            </div>
            <div>
              <dt>Name</dt>
              <dd className="break">{load.account.user.displayName ?? 'Not provided'}</dd>
            </div>
          </dl>
          <h2>Usage</h2>
          <dl className="facts">
            <div>
              <dt>Saved words</dt>
              <dd>{formatCount(load.account.usage.words)}</dd>
            </div>
            <div>
              <dt>Documents</dt>
              <dd>{formatCount(load.account.usage.documents)}</dd>
            </div>
            <div>
              <dt>Stored PDFs</dt>
              <dd>
                {formatBytes(load.account.usage.storageUsedBytes)} of{' '}
                {formatBytes(load.account.usage.storageQuotaBytes)}
              </dd>
            </div>
          </dl>
        </>
      ) : null}

      {resume.reauthFailed ? (
        <p className="notice notice--danger" role="alert">
          {resume.reauthMismatch
            ? `You signed in to Google with a different account. Sign in again with ${state.status === 'signed-in' ? state.user.email : 'the account you are signed in to Clavis with'} to delete this account.`
            : 'Sign-in did not complete. Try again.'}
        </p>
      ) : null}

      <h2>Sign out</h2>
      {error && !confirmAll ? (
        <p className="notice notice--danger" role="alert">
          {describeFailure(error)}
        </p>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={busy !== null}
          onClick={() => void signOut()}
        >
          {busy === 'logout' ? 'Signing out…' : 'Sign out'}
        </button>
        <button
          type="button"
          className="btn btn--quiet"
          disabled={busy !== null}
          onClick={() => {
            setError(null);
            setConfirmAll(true);
          }}
        >
          Sign out everywhere
        </button>
      </div>
      <p className="muted">
        Signing out everywhere ends this session and signs out the Clavis extension on all your
        devices.
      </p>

      <h2>Your data</h2>
      <div className="actions">
        <a className="btn btn--quiet" href={EXPORT_URL} download aria-describedby="export-note">
          Export data
        </a>
        <button
          type="button"
          className="btn btn--quiet"
          onClick={() => {
            setReauth(needsReauth(authenticatedAt));
            setDeleting(true);
          }}
        >
          Delete account
        </button>
      </div>
      <p className="muted" id="export-note">
        The export is a ZIP file with your saved words and their chats, your documents with reading
        progress and highlights, and your stored PDFs. You can export up to 3 times a day. If a
        download fails, you may have used today's 3 exports or another export may still be running.
        Try again later.
      </p>

      {deleting ? (
        <DeleteAccountDialog
          reauth={reauth}
          onReauthRequired={() => setReauth(true)}
          onCancel={() => {
            clearReauthMarker();
            setDeleting(false);
          }}
        />
      ) : null}

      {confirmAll ? (
        <ConfirmDialog
          title="Sign out everywhere?"
          confirmLabel="Sign out everywhere"
          danger={false}
          busy={busy === 'logout-all'}
          onConfirm={() => void signOutEverywhere()}
          onCancel={() => setConfirmAll(false)}
        >
          <p>
            You will be signed out of this browser and of the Clavis extension on every device. Your
            saved data is not deleted.
          </p>
          {error ? (
            <p className="notice notice--danger" role="alert">
              {describeFailure(error)}
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

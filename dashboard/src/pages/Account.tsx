import { useEffect, useState } from 'react';
import type { AccountResponse } from '@shared/api-contract/endpoints';
import { describeFailure, isAbort } from '../api/client';
import { api } from '../api/endpoints';
import { useSession } from '../api/session';
import { formatBytes, formatCount } from '../format';
import { ConfirmDialog } from '../ui/modal';
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
  const { clear } = useSession();
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState<'logout' | 'logout-all' | null>(null);
  const [error, setError] = useState<unknown>(null);

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
        <button type="button" className="btn btn--quiet" disabled aria-describedby="soon-note">
          Export data
        </button>
        <button type="button" className="btn btn--quiet" disabled aria-describedby="soon-note">
          Delete account
        </button>
      </div>
      <p className="muted" id="soon-note">
        Exporting your data and deleting your account from the web are coming soon.
      </p>

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

import { useId, useRef, useState } from 'react';
import { t } from '../../lib/i18n';
import { accountApi } from '../../lib/ui-client/account-api';
import { describeError, type ClientError } from '../../lib/ui-client/errors';
import { useAccountStatus } from '../../lib/ui-client/use-account-status';
import { Button, ErrorNotice, ExternalLink, LiveStatus, Notice } from '../common/ui';
import { SettingsIcon } from '../common/Icons';
import { useToast } from '../common/Toast';
import { AccountDialog } from './AccountDialog';
import { syncLine } from './sync-line';
import './account.css';

/** Where "Manage account on the web" goes: the dashboard is served by the API origin. */
export interface AccountSectionProps {
  dashboardUrl: string;
}

type Busy = 'sign-in' | 'sync' | 'sign-out' | null;
type Dialog = 'sign-out' | 'everywhere' | null;

/** Settings: Account & sync (docs/clavis-sync-design.md 7.7). Only rendered when accounts are on. */
export function AccountSection({ dashboardUrl }: AccountSectionProps) {
  const toast = useToast();
  const headingId = useId();
  const keepId = useId();
  const status = useAccountStatus();
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [keepCopy, setKeepCopy] = useState(false);
  const [noticeHidden, setNoticeHidden] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  const accountError = (code: Parameters<typeof describeError>[0]): ClientError =>
    code === 'NETWORK_ERROR'
      ? { ...describeError('NETWORK_ERROR'), message: t('accountErrNetwork') }
      : describeError(code);

  async function run(
    kind: Exclude<Busy, null>,
    action: () => ReturnType<typeof accountApi.signIn>,
  ) {
    setBusy(kind);
    setError(null);
    const result = await action();
    setBusy(null);
    status.refresh();
    if (!result.ok) {
      setError(
        result.error.code === 'NETWORK_ERROR' ? accountError('NETWORK_ERROR') : result.error,
      );
    }
    return result.ok;
  }

  async function confirmSignOut(confirmed: boolean) {
    const which = dialog;
    setDialog(null);
    const keep = keepCopy;
    setKeepCopy(false);
    if (!confirmed) return;
    setBusy('sign-out');
    setError(null);
    const result =
      which === 'everywhere'
        ? await accountApi.signOutEverywhere()
        : await accountApi.signOut(keep);
    setBusy(null);
    status.reload();
    if (result.ok) {
      toast?.show({ content: t('accountSignedOutDone'), tone: 'success' });
      headingRef.current?.focus();
    } else {
      setError(result.error);
    }
  }

  const data = status.state.status === 'ready' ? status.state.data : null;
  const pending = data?.sync.pending ?? 0;

  return (
    <section className="clavis-section" aria-labelledby={headingId} id="section-account">
      <h2 id={headingId} tabIndex={-1} ref={headingRef}>
        <SettingsIcon name="account" />
        {t('accountTitle')}
      </h2>

      {status.state.status === 'error' ? (
        <ErrorNotice error={status.state.error} onRetry={status.reload} />
      ) : null}

      {data?.notice === 'session-ended' && !noticeHidden ? (
        <Notice tone="warning" testId="account-session-ended">
          <p>{t('accountSessionEnded')}</p>
          <Button variant="link" onClick={() => setNoticeHidden(true)}>
            {t('accountDismiss')}
          </Button>
        </Notice>
      ) : null}

      {data !== null && !data.signedIn ? (
        <>
          <p>{t('accountIntro')}</p>
          <Notice tone="info">
            <p>{t('accountMergeNotice')}</p>
          </Notice>
          <div className="clavis-actions">
            <Button
              variant="primary"
              data-testid="account-sign-in"
              disabled={busy !== null}
              onClick={() => void run('sign-in', accountApi.signIn)}
            >
              {busy === 'sign-in' ? t('accountSigningIn') : t('accountSignIn')}
            </Button>
          </div>
        </>
      ) : null}

      {data?.signedIn === true ? (
        <>
          <p data-testid="account-email">
            {t('accountSignedInAs', data.email ?? data.displayName ?? '')}
          </p>
          <p data-testid="account-sync-line">{syncLine(data.sync)}</p>
          {pending > 0 ? (
            <p data-testid="account-pending">{t('accountPending', String(pending))}</p>
          ) : null}
          {data.sync.rejected > 0 ? (
            <Notice tone="warning">
              <p>{t('accountRejected', String(data.sync.rejected))}</p>
            </Notice>
          ) : null}
          <div className="clavis-actions">
            <Button
              data-testid="account-sync-now"
              disabled={busy !== null || data.sync.state === 'syncing'}
              onClick={() => void run('sync', accountApi.syncNow)}
            >
              {t('accountSyncNow')}
            </Button>
            <ExternalLink href={dashboardUrl}>{t('accountManageWeb')}</ExternalLink>
          </div>
          <div className="clavis-actions">
            <Button
              data-testid="account-sign-out"
              disabled={busy !== null}
              onClick={() => setDialog('sign-out')}
            >
              {t('accountSignOut')}
            </Button>
            <Button
              data-testid="account-sign-out-everywhere"
              disabled={busy !== null}
              onClick={() => setDialog('everywhere')}
            >
              {t('accountSignOutEverywhere')}
            </Button>
          </div>
        </>
      ) : null}

      {error !== null ? <ErrorNotice error={error} onRetry={() => setError(null)} /> : null}
      <LiveStatus message={busy === 'sync' ? t('accountSyncing') : null} tone="info" />

      {dialog === 'sign-out' ? (
        <AccountDialog
          title={t('accountSignOutTitle')}
          body={
            pending > 0
              ? `${t('accountPending', String(pending))} ${t('accountSignOutBody')}`
              : t('accountSignOutBody')
          }
          confirmLabel={t('accountSignOutConfirm')}
          danger
          onAnswer={(confirmed) => void confirmSignOut(confirmed)}
        >
          <div className="clavis-account__check">
            <input
              id={keepId}
              type="checkbox"
              data-testid="account-keep-copy"
              checked={keepCopy}
              onChange={(event) => setKeepCopy(event.target.checked)}
            />
            <label htmlFor={keepId}>
              {t('accountKeepCopy')}
              <br />
              <small>{t('accountKeepCopyHint')}</small>
            </label>
          </div>
        </AccountDialog>
      ) : null}
      {dialog === 'everywhere' ? (
        <AccountDialog
          title={t('accountEverywhereTitle')}
          body={t('accountEverywhereBody')}
          confirmLabel={t('accountEverywhereConfirm')}
          danger
          onAnswer={(confirmed) => void confirmSignOut(confirmed)}
        />
      ) : null}
    </section>
  );
}

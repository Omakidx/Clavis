// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSection } from '../../../components/account/AccountSection';
import { ToastProvider } from '../../../components/common/Toast';
import type { AccountStatus } from '../../../lib/contracts/account';
import { installCatalog } from '../ui-client/support';

const OUT: AccountStatus = {
  enabled: true,
  signedIn: false,
  sync: { state: 'idle', pending: 0, rejected: 0 },
};
const IN: AccountStatus = {
  enabled: true,
  signedIn: true,
  email: 'me@example.test',
  sync: { state: 'idle', pending: 0, rejected: 0, lastSyncAt: 1_760_000_000_000 },
};

function setup(initial: AccountStatus, answers: Record<string, unknown> = {}) {
  installCatalog();
  let status = initial;
  const sent: { type: string; [k: string]: unknown }[] = [];
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: { type: string }) => {
    sent.push(message);
    if (message.type === 'ACCOUNT_GET_STATUS') return Promise.resolve({ ok: true, data: status });
    const answer = answers[message.type];
    if (answer !== undefined) return Promise.resolve(answer);
    if (message.type === 'ACCOUNT_SIGN_IN') status = IN;
    if (message.type === 'ACCOUNT_SIGN_OUT') status = OUT;
    return Promise.resolve({
      ok: true,
      data: message.type === 'ACCOUNT_SIGN_OUT' ? { unsyncedDropped: 0 } : {},
    });
  }) as never);
  render(
    <ToastProvider>
      <AccountSection dashboardUrl="https://dash.example/" />
    </ToastProvider>,
  );
  return { user: userEvent.setup(), sent };
}
afterEach(() => cleanup());

describe('Account & sync section', () => {
  it('signed out: states what signing in does, and signs in with one click', async () => {
    const { user, sent } = setup(OUT);
    expect(await screen.findByText(/adds this device's saved words/)).toBeVisible();
    await user.click(screen.getByTestId('account-sign-in'));
    await waitFor(() => expect(sent.some((m) => m.type === 'ACCOUNT_SIGN_IN')).toBe(true));
    expect(await screen.findByTestId('account-email')).toHaveTextContent('me@example.test');
  });

  it('a cancelled sign-in says so and stays signed out', async () => {
    const { user } = setup(OUT, {
      ACCOUNT_SIGN_IN: { ok: false, error: { code: 'CANCELLED', message: 'x' } },
    });
    await user.click(await screen.findByTestId('account-sign-in'));
    expect(await screen.findByText(/Sign-in was cancelled/)).toBeVisible();
    expect(screen.getByTestId('account-sign-in')).toBeEnabled();
  });

  it('not configured is explained', async () => {
    const { user } = setup(OUT, {
      ACCOUNT_SIGN_IN: { ok: false, error: { code: 'NOT_CONFIGURED', message: 'x' } },
    });
    await user.click(await screen.findByTestId('account-sign-in'));
    expect(await screen.findByText(/not set up in this version/)).toBeVisible();
  });

  it('signed in: email, sync line, the web link and sync now', async () => {
    const { user, sent } = setup(IN);
    expect(await screen.findByTestId('account-email')).toHaveTextContent(
      'Signed in as me@example.test',
    );
    expect(screen.getByTestId('account-sync-line')).toHaveTextContent(/Synced/);
    const link = screen.getByRole('link', { name: /Manage account on the web/ });
    expect(link).toHaveAttribute('href', 'https://dash.example/');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
    await user.click(screen.getByTestId('account-sync-now'));
    expect(sent.some((m) => m.type === 'SYNC_NOW')).toBe(true);
  });

  it('shows pending and refused counts', async () => {
    setup({ ...IN, sync: { state: 'error', pending: 3, rejected: 2 } });
    expect(await screen.findByTestId('account-pending')).toHaveTextContent(
      '3 changes are not synced yet.',
    );
    expect(screen.getByText(/2 changes were refused/)).toBeVisible();
    expect(screen.getByTestId('account-sync-line')).toHaveTextContent(/Sync failed/);
  });

  it('sign out: the dialog warns about unsynced changes, the copy checkbox starts off, and the choice is sent', async () => {
    const { user, sent } = setup({ ...IN, sync: { state: 'idle', pending: 4, rejected: 0 } });
    await user.click(await screen.findByTestId('account-sign-out'));
    const dialog = await screen.findByTestId('account-dialog');
    expect(dialog).toHaveTextContent('4 changes are not synced yet.');
    const keep = screen.getByTestId('account-keep-copy');
    expect(keep).not.toBeChecked();
    // Focus starts on the safe button.
    expect(screen.getByTestId('account-dialog-cancel')).toHaveFocus();
    await user.click(keep);
    await user.click(screen.getByTestId('account-dialog-confirm'));
    await waitFor(() =>
      expect(sent.find((m) => m.type === 'ACCOUNT_SIGN_OUT')).toMatchObject({
        keepLocalCopy: true,
      }),
    );
    expect(await screen.findByTestId('account-sign-in')).toBeVisible();
  });

  it('sign out without the checkbox sends keepLocalCopy false; Escape cancels and sends nothing', async () => {
    const { user, sent } = setup(IN);
    await user.click(await screen.findByTestId('account-sign-out'));
    await screen.findByTestId('account-dialog');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('account-dialog')).toBeNull();
    expect(sent.some((m) => m.type === 'ACCOUNT_SIGN_OUT')).toBe(false);
    await user.click(screen.getByTestId('account-sign-out'));
    await user.click(await screen.findByTestId('account-dialog-confirm'));
    await waitFor(() =>
      expect(sent.find((m) => m.type === 'ACCOUNT_SIGN_OUT')).toMatchObject({
        keepLocalCopy: false,
      }),
    );
  });

  it('sign out everywhere asks first', async () => {
    const { user, sent } = setup(IN);
    await user.click(await screen.findByTestId('account-sign-out-everywhere'));
    expect(await screen.findByTestId('account-dialog')).toHaveTextContent(/every device/);
    expect(sent.some((m) => m.type === 'ACCOUNT_SIGN_OUT_EVERYWHERE')).toBe(false);
    await user.click(screen.getByTestId('account-dialog-confirm'));
    await waitFor(() =>
      expect(sent.some((m) => m.type === 'ACCOUNT_SIGN_OUT_EVERYWHERE')).toBe(true),
    );
  });

  it('shows the session-ended notice after the server ended the session', async () => {
    setup({ ...OUT, notice: 'session-ended' });
    expect(await screen.findByTestId('account-session-ended')).toHaveTextContent(
      /signed out because the account session ended/,
    );
  });
});

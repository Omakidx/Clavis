// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiKeySection } from '../../../components/settings/ApiKeySection';
import {
  KeyOutcomeNotice,
  KeyVerificationResponse,
} from '../../../components/settings/KeyConnectForm';
import { useKeyStatus } from '../../../lib/ui-client/use-key-status';
import {
  createFakeBackend,
  installBackend,
  installCatalog,
  type FakeBackend,
  type FakeBackendOptions,
} from '../ui-client/support';

const FAKE_KEY = 'gsk_TESTabcdefghijklmnop9876';

function Harness() {
  const keys = useKeyStatus();
  return <ApiKeySection keys={keys} />;
}

let backend: FakeBackend;
function setup(options: FakeBackendOptions = {}, tested = false) {
  installCatalog();
  backend = createFakeBackend(options);
  if (tested) backend.handle({ v: 1, type: 'TEST_API_KEY' });
  installBackend(backend);
  render(<Harness />);
  return userEvent.setup();
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'clipboard');
});

describe('API key section', () => {
  it.each([
    ['forbidden', /without an API key was also denied \(HTTP 403\)/],
    ['auth-required', /HTTP 401 without a key as expected, but HTTP 403/],
    ['unreachable', /comparison request got no HTTP response/],
    ['other-response', /comparison response was unexpected/],
  ] as const)('explains the safe %s comparison result', (accessProbe, conclusion) => {
    installCatalog();
    render(
      <KeyOutcomeNotice
        outcome={{
          kind: 'unverified',
          status: {
            hasKey: true,
            storage: 'local',
            last4: '9876',
            verification: 'unverified',
            verificationHttpStatus: 403,
            forbiddenReason: 'unknown',
            accessProbe,
            verifiedAt: null,
            models: [],
          },
        }}
      />,
    );
    expect(screen.getByText(conclusion)).toBeVisible();
    expect(document.body.textContent).not.toContain(FAKE_KEY);
  });

  it('copies only fixed diagnostic fields and reports unavailable clipboard access', async () => {
    installCatalog();
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { rerender } = render(
      <KeyVerificationResponse status={403} reason="unknown" probe="forbidden" showCopy />,
    );
    await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    const report = String(writeText.mock.calls[0]?.[0]);
    expect(report).toContain('HTTP: 403');
    expect(report).toContain('forbidden');
    expect(report).toContain('unknown');
    expect(report).not.toContain(FAKE_KEY);
    expect(report).not.toContain('9876');
    expect(screen.getByRole('status')).toHaveTextContent('Diagnostics copied.');

    Reflect.deleteProperty(navigator, 'clipboard');
    rerender(<KeyVerificationResponse status={403} reason="unknown" probe="forbidden" showCopy />);
    await user.click(screen.getByRole('button', { name: 'Copy diagnostics' }));
    expect(screen.getByRole('status')).toHaveTextContent('Clipboard unavailable');
  });

  it('offers Copy diagnostics only for a probed HTTP 403', () => {
    installCatalog();
    const { rerender } = render(<KeyVerificationResponse status={403} reason="unknown" showCopy />);
    expect(screen.queryByRole('button', { name: 'Copy diagnostics' })).toBeNull();
    rerender(<KeyVerificationResponse status={500} probe="forbidden" showCopy />);
    expect(screen.queryByRole('button', { name: 'Copy diagnostics' })).toBeNull();
  });

  it('shows an HTTP 403 with permission guidance without exposing provider text or a key', () => {
    installCatalog();
    render(
      <KeyOutcomeNotice
        outcome={{
          kind: 'unverified',
          status: {
            hasKey: true,
            storage: 'local',
            last4: '9876',
            verification: 'unverified',
            verificationHttpStatus: 403,
            forbiddenReason: 'unknown',
            verifiedAt: null,
            models: [],
          },
        }}
      />,
    );
    expect(screen.getByText('Groq returned HTTP 403.')).toBeVisible();
    expect(screen.getByText(/cannot determine why this request was denied/)).toBeVisible();
    expect(document.body.textContent).not.toContain(FAKE_KEY);
  });

  it.each([
    ['model_permission_org', /organization blocks this model/],
    ['model_permission_project', /project blocks this model/],
    ['permission_restriction', /permission restriction but did not identify/],
    ['region_block', /region block/],
    ['edge_block', /security or browser\/IP block/],
  ] as const)('shows fixed guidance for %s', (forbiddenReason, guidance) => {
    installCatalog();
    render(
      <KeyOutcomeNotice
        outcome={{
          kind: 'unverified',
          status: {
            hasKey: true,
            storage: 'local',
            last4: '9876',
            verification: 'unverified',
            verificationHttpStatus: 403,
            forbiddenReason,
            verifiedAt: null,
            models: [],
          },
        }}
      />,
    );
    expect(screen.getByText(guidance)).toBeVisible();
  });

  it('without a key: says so, shows the connect form, and states that storage is not encrypted', async () => {
    setup();
    expect(await screen.findByText('No Groq key is connected.')).toBeVisible();
    expect(screen.getByLabelText('Your Groq key')).toBeVisible();
    expect(screen.getByText(/Clavis does not encrypt your key/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Remove key' })).toBeNull();
  });

  it('with a key: shows status, the last four characters, where it is kept and when it was checked', async () => {
    setup({ key: { value: FAKE_KEY, storage: 'session' }, groq: 'valid' }, true);
    const facts = await screen.findByTestId('key-facts');
    expect(within(facts).getByText('Working')).toBeVisible();
    expect(within(facts).getByText('Ending in 9876')).toBeVisible();
    expect(within(facts).getByText(/Only for this session/)).toBeVisible();
    expect(within(facts).queryByText('Never')).toBeNull();
    expect(document.body.textContent).not.toContain(FAKE_KEY);
    expect(document.body.textContent).not.toContain('gsk_TESTabcdefghijklmnop');
  });

  it('shows "saved, not checked yet" for a key that was never tested and "Never" as last checked', async () => {
    setup({ key: { value: FAKE_KEY, storage: 'local' } });
    const facts = await screen.findByTestId('key-facts');
    expect(within(facts).getByText('Saved, not checked yet')).toBeVisible();
    expect(within(facts).getByText('Never')).toBeVisible();
    expect(within(facts).getByText(/On this device until you remove it/)).toBeVisible();
  });

  it('Test connection reports working, rejected and unreachable keys differently', async () => {
    const user = setup({ key: { value: FAKE_KEY, storage: 'local' }, groq: 'valid' });
    await screen.findByTestId('key-facts');
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/Groq accepted your key ending in 9876/)).toBeVisible();

    backend.state.groq = 'invalid';
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findAllByText(/Groq didn't accept/)).not.toHaveLength(0);
    expect(within(screen.getByTestId('key-facts')).getByText('Not accepted by Groq')).toBeVisible();

    backend.state.groq = 'offline';
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText(/check could not confirm access/)).toBeVisible();
    expect(screen.getAllByText('No HTTP response (network or timeout).').length).toBeGreaterThan(0);
    expect(
      within(screen.getByTestId('key-facts')).getByText(/Saved, but not verified/),
    ).toBeVisible();
  });

  it('Remove key asks for confirmation first, focuses Cancel, and cancelling changes nothing', async () => {
    const user = setup({ key: { value: FAKE_KEY, storage: 'local' } });
    await user.click(await screen.findByRole('button', { name: 'Remove key' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove your Groq key?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(dialog).toHaveTextContent(/does not cancel it at Groq/);
    expect(within(dialog).getByRole('link', { name: /Groq keys page/ })).toHaveAttribute(
      'href',
      'https://console.groq.com/keys',
    );
    expect(backend.calls.map((c) => c.type)).not.toContain('REMOVE_API_KEY');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(backend.state.key).not.toBeNull();
  });

  it('confirming Remove key deletes it and returns to the connect state', async () => {
    const user = setup({ key: { value: FAKE_KEY, storage: 'local' } });
    await user.click(await screen.findByRole('button', { name: 'Remove key' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Remove key' }),
    );
    await waitFor(() => expect(backend.state.key).toBeNull());
    expect(await screen.findByText('Your key was removed.')).toBeVisible();
    expect(screen.getByText('No Groq key is connected.')).toBeVisible();
    expect(screen.getByLabelText('Your Groq key')).toBeVisible();
  });

  it('Change key shows the form, replaces the key, and reports the new key without echoing it', async () => {
    const user = setup({ key: { value: FAKE_KEY, storage: 'local' }, groq: 'valid' });
    await user.click(await screen.findByRole('button', { name: 'Change key' }));
    await user.click(screen.getByRole('radio', { name: /Only for this session/ }));
    await user.type(screen.getByLabelText('Your Groq key'), 'gsk_TESTnewkeyvalue5555');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/Groq accepted your key ending in 5555/)).toBeVisible();
    expect(backend.state.key).toEqual({ value: 'gsk_TESTnewkeyvalue5555', storage: 'session' });
    expect(document.body.textContent).not.toContain('gsk_TESTnewkeyvalue5555');
    expect(within(screen.getByTestId('key-facts')).getByText('Ending in 5555')).toBeVisible();
  });

  it('shows an actionable message when the background is unreachable', async () => {
    installCatalog();
    backend = createFakeBackend({ silentReplies: 99 });
    installBackend(backend);
    render(<Harness />);
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert).toHaveTextContent(/isn't responding/);
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

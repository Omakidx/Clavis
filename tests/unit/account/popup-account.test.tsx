// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installCatalog, createFakeBackend, installPermissions } from '../ui-client/support';

vi.mock('../../../lib/config/constants', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../lib/config/constants')>();
  return { ...original, FEATURES: { ...original.FEATURES, accountSync: true } };
});

import { App } from '../../../entrypoints/popup/App';

afterEach(() => cleanup());

function setup(signedIn: boolean) {
  installCatalog();
  const backend = createFakeBackend({});
  const sent: string[] = [];
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: { type: string }) => {
    sent.push(message.type);
    if (message.type === 'ACCOUNT_GET_STATUS') {
      return Promise.resolve({
        ok: true,
        data: signedIn
          ? {
              enabled: true,
              signedIn: true,
              email: 'me@example.test',
              sync: { state: 'idle', pending: 0, rejected: 0 },
            }
          : { enabled: true, signedIn: false, sync: { state: 'idle', pending: 0, rejected: 0 } },
      });
    }
    if (message.type === 'ACCOUNT_SIGN_IN') return Promise.resolve({ ok: true, data: {} });
    return Promise.resolve(backend.handle(message));
  }) as never);
  vi.spyOn(browser.tabs, 'query').mockResolvedValue([
    { id: 1, url: 'https://example.com/' },
  ] as never);
  vi.spyOn(window, 'close').mockImplementation(() => undefined);
  installPermissions({ granted: false });
  render(<App />);
  return { user: userEvent.setup(), sent };
}

describe('popup account row (accounts on)', () => {
  it('signed out: "Sign in to sync" with the consent line, and it starts the sign-in', async () => {
    const { user, sent } = setup(false);
    const button = await screen.findByTestId('popup-account-sign-in');
    expect(screen.getByText(/adds this device's saved words/)).toBeVisible();
    await user.click(button);
    await waitFor(() => expect(sent).toContain('ACCOUNT_SIGN_IN'));
  });

  it('signed in: shows the email', async () => {
    setup(true);
    expect(await screen.findByTestId('popup-account-email')).toHaveTextContent('me@example.test');
  });
});

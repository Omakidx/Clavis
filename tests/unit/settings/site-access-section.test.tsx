// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SiteAccessSection } from '../../../components/settings/SiteAccessSection';
import { useSettings } from '../../../lib/ui-client/use-settings';
import {
  createFakeBackend,
  installBackend,
  installCatalog,
  installPermissions,
  type FakeBackend,
  type FakeBackendOptions,
} from '../ui-client/support';

function Harness() {
  return <SiteAccessSection settings={useSettings()} />;
}

let backend: FakeBackend;
function setup(options: FakeBackendOptions = {}, granted = false, answer = true) {
  installCatalog();
  backend = createFakeBackend(options);
  backend.state.siteGranted = granted;
  installBackend(backend);
  const perms = installPermissions({ granted, answer });
  // The real background registers the observer when Chrome reports the grant.
  perms.request.mockImplementation(() => {
    perms.granted = answer;
    backend.state.siteGranted = answer;
    return Promise.resolve(answer);
  });
  perms.remove.mockImplementation(() => {
    perms.granted = false;
    backend.state.siteGranted = false;
    return Promise.resolve(true);
  });
  render(<Harness />);
  return { user: userEvent.setup(), perms };
}

afterEach(() => cleanup());

describe('site access (FR-009)', () => {
  it('off: explains the right-click alternative and offers Enable on websites', async () => {
    const { user, perms } = setup();
    expect(await screen.findByTestId('site-access-status')).toHaveTextContent(
      /Website access is off.*right-click/,
    );
    await user.click(screen.getByRole('button', { name: 'Enable on websites' }));
    expect(perms.request).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(backend.state.onboarding.siteAccessChoice).toBe('granted'));
    expect(
      await screen.findByText(/Website access is on\. Clavis will show its toolbar/),
    ).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId('site-access-status')).toHaveTextContent(/Website access is on/),
    );
  });

  it('records a refused prompt as declined', async () => {
    const { user } = setup({}, false, false);
    await user.click(await screen.findByRole('button', { name: 'Enable on websites' }));
    await waitFor(() => expect(backend.state.onboarding.siteAccessChoice).toBe('declined'));
    expect(await screen.findByText(/Website access stayed off/)).toBeVisible();
  });

  it('on: tells how to revoke in Chrome and offers Remove website access', async () => {
    const { user, perms } = setup({ onboarding: { siteAccessChoice: 'granted' } }, true);
    expect(await screen.findByTestId('site-access-status')).toHaveTextContent(
      /Website access is on/,
    );
    expect(
      screen.getByText(/chrome:\/\/extensions page, choose Details, and change Site access/),
    ).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Remove website access' }));
    expect(perms.remove).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*'] });
    await waitFor(() => expect(backend.state.onboarding.siteAccessChoice).toBe('declined'));
    expect(await screen.findByText('Website access was removed.')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByTestId('site-access-status')).toHaveTextContent(/Website access is off/),
    );
  });

  it('on but not registered yet: asks the user to reload a page', async () => {
    installCatalog();
    backend = createFakeBackend();
    backend.state.siteGranted = true;
    installBackend(backend);
    installPermissions({ granted: true });
    backend.handle = ((original) => (raw: unknown) => {
      const reply = original(raw) as { ok: boolean; data?: Record<string, unknown> };
      if ((raw as { type: string }).type === 'GET_SITE_ACCESS_STATUS' && reply.data) {
        reply.data['registered'] = false;
      }
      return reply;
    })(backend.handle);
    render(<Harness />);
    expect(await screen.findByTestId('site-access-status')).toHaveTextContent(
      /hasn't started on your open pages yet/,
    );
  });

  it("opens Chrome's extension page for Site access", async () => {
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    const { user } = setup({}, true);
    await user.click(
      await screen.findByRole('button', { name: /Open Clavis in Chrome's extensions page/ }),
    );
    expect(create).toHaveBeenCalledWith({
      url: expect.stringMatching(/^chrome:\/\/extensions\/\?id=/),
    });
  });
});

describe('per-site disable list', () => {
  async function list() {
    return screen.findByLabelText('Website address');
  }

  it('adds a normalized hostname and saves the whole list', async () => {
    const { user } = setup();
    await user.type(await list(), 'HTTPS://www.Example.com/some/page');
    await user.click(screen.getByRole('button', { name: 'Add website' }));
    await waitFor(() =>
      expect(backend.state.preferences.disabledSites).toEqual(['www.example.com']),
    );
    expect(await screen.findByText('Added www.example.com.')).toBeVisible();
    expect(screen.getByRole('list', { name: 'Websites where Clavis is off' })).toHaveTextContent(
      'www.example.com',
    );
    expect((await list()) as HTMLInputElement).toHaveValue('');
    expect(await list()).toHaveFocus();
  });

  it.each([
    ['', 'Enter a website address.'],
    ['not a site', "That doesn't look like a website address."],
    ['intranet', "That doesn't look like a website address."],
  ])('rejects %j with a clear, announced error and sends nothing', async (input, message) => {
    const { user } = setup();
    const field = await list();
    if (input !== '') await user.type(field, input);
    await user.click(screen.getByRole('button', { name: 'Add website' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(message);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(backend.calls.some((c) => c.type === 'UPDATE_PREFERENCES')).toBe(false);
  });

  it('rejects a duplicate', async () => {
    const { user } = setup({ preferences: { disabledSites: ['example.com'] } });
    await user.type(await list(), 'EXAMPLE.com');
    await user.click(screen.getByRole('button', { name: 'Add website' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'example.com is already on the list.',
    );
    expect(backend.state.preferences.disabledSites).toEqual(['example.com']);
  });

  it('removes a site and returns focus to the input', async () => {
    const { user } = setup({ preferences: { disabledSites: ['a.example.com', 'b.example.com'] } });
    const items = await screen.findByTestId('disabled-sites');
    await user.click(within(items).getByRole('button', { name: 'Remove a.example.com' }));
    await waitFor(() => expect(backend.state.preferences.disabledSites).toEqual(['b.example.com']));
    expect(await screen.findByText('Removed a.example.com.')).toBeVisible();
    expect(await list()).toHaveFocus();
  });

  it('says the list matches exact hosts and applies to pages loaded afterwards', async () => {
    setup();
    await list();
    expect(screen.getByText(/does not cover www\.example\.com/)).toBeVisible();
    expect(screen.getByText(/apply to pages you load afterwards/)).toBeVisible();
  });

  it('accepts an IPv4 address and rejects an IPv6 literal', async () => {
    const { user } = setup();
    await user.type(await list(), '192.168.1.1');
    await user.click(screen.getByRole('button', { name: 'Add website' }));
    await waitFor(() => expect(backend.state.preferences.disabledSites).toEqual(['192.168.1.1']));
    await user.type(await list(), '[[::1]');
    await user.click(screen.getByRole('button', { name: 'Add website' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "doesn't look like a website address",
    );
  });

  it('shows an empty state', async () => {
    setup();
    expect(await screen.findByText('No websites are listed.')).toBeVisible();
  });
});

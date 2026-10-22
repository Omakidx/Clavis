// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../entrypoints/popup/App';
import {
  createFakeBackend,
  installCatalog,
  installPermissions,
  type FakeBackend,
  type FakeBackendOptions,
} from '../ui-client/support';

let backend: FakeBackend;
const injectReplies: unknown[] = [];

function setup(options: FakeBackendOptions = {}, granted = false, tested = false) {
  installCatalog();
  backend = createFakeBackend(options);
  if (tested) backend.handle({ v: 1, type: 'TEST_API_KEY' });
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: { type?: string }) =>
    Promise.resolve(
      message.type === 'CLAVIS_INJECT_TAB' ? injectReplies.shift() : backend.handle(message),
    )) as never);
  vi.spyOn(browser.tabs, 'query').mockImplementation((() =>
    Promise.resolve([{ id: 7, url: 'https://example.com/a' }])) as unknown as never);
  installPermissions({ granted });
  render(<App />);
  return userEvent.setup();
}

beforeEach(() => {
  injectReplies.length = 0;
  vi.spyOn(window, 'close').mockImplementation(() => undefined);
});
afterEach(() => cleanup());

const groq = () => screen.getByTestId('popup-groq');

describe('popup status', () => {
  it('shows "setup needed" with a Connect Groq button when there is no key', async () => {
    const user = setup();
    await waitFor(() => expect(groq()).toHaveTextContent('Setup needed'));
    const open = vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined);
    await user.click(screen.getByRole('button', { name: 'Connect Groq' }));
    expect(open).toHaveBeenCalled();
  });

  it('shows "connected" when Groq is ready, and no fix-it button', async () => {
    setup({
      key: { value: 'gsk_TESTpopup00000001', storage: 'local' },
      onboarding: { disclosureAcceptedAt: 5 },
    });
    await waitFor(() => expect(groq()).toHaveTextContent('Connected'));
    expect(screen.queryByRole('button', { name: 'Connect Groq' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update key' })).toBeNull();
  });

  it('shows "key not working" with Update key when Groq rejected the key', async () => {
    setup(
      { key: { value: 'gsk_TESTpopup00000002', storage: 'local' }, groq: 'invalid' },
      false,
      true,
    );
    await waitFor(() => expect(groq()).toHaveTextContent('Key not working'));
    expect(screen.getByRole('button', { name: 'Update key' })).toBeVisible();
  });

  it('asks to review the data notice when a key exists but the disclosure was never accepted', async () => {
    const user = setup({ key: { value: 'gsk_TESTpopup00000003', storage: 'local' } });
    await waitFor(() => expect(groq()).toHaveTextContent('Review the data notice'));
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await user.click(screen.getByRole('button', { name: 'Review setup' }));
    expect(create).toHaveBeenCalledWith({ url: expect.stringContaining('/onboarding.html') });
  });

  it('reports website access on or off', async () => {
    setup({}, true);
    await waitFor(() => expect(screen.getByTestId('popup-site')).toHaveTextContent('On'));
    cleanup();
    setup({}, false);
    await waitFor(() => expect(screen.getByTestId('popup-site')).toHaveTextContent('Off'));
  });

  it('shows an actionable error when the background does not answer', async () => {
    setup({ silentReplies: 99 });
    const alert = await screen.findByRole('alert', {}, { timeout: 4000 });
    expect(alert).toHaveTextContent(/isn't responding/);
    expect(groq()).toHaveTextContent('Status unavailable');
    expect(within(alert).getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

describe('popup buttons', () => {
  it('opens the PDF reader and Settings', async () => {
    const user = setup();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    const open = vi.spyOn(browser.runtime, 'openOptionsPage').mockResolvedValue(undefined);
    await user.click(screen.getByRole('button', { name: 'Open PDF reader' }));
    expect(create).toHaveBeenCalledWith({ url: expect.stringContaining('/reader.html') });
    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(open).toHaveBeenCalled();
  });
});

describe('"Explain on this page" fallback (FR-018) still works', () => {
  it('is offered only without website access and injects into the current tab', async () => {
    const user = setup({}, false);
    injectReplies.push({ ok: true, shown: true });
    await user.click(await screen.findByRole('button', { name: 'Explain on this page' }));
    await waitFor(() => expect(window.close).toHaveBeenCalled());
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CLAVIS_INJECT_TAB', tabId: 7 }),
    );
  });

  it('explains a missing selection and a restricted page', async () => {
    const user = setup({}, false);
    injectReplies.push({ ok: true, shown: false }, { ok: false, reason: 'restricted' });
    await user.click(await screen.findByRole('button', { name: 'Explain on this page' }));
    expect(await screen.findByText(/No text is selected/)).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Explain on this page' }));
    expect(await screen.findByText(/can't run on this kind of page/)).toBeVisible();
  });

  it('is hidden when website access is on', async () => {
    setup({}, true);
    await waitFor(() => expect(screen.getByTestId('popup-site')).toHaveTextContent('On'));
    expect(screen.queryByRole('button', { name: 'Explain on this page' })).toBeNull();
  });
});

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

function setup(
  options: FakeBackendOptions = {},
  granted = false,
  tested = false,
  tabUrl = 'https://example.com/a',
) {
  installCatalog();
  backend = createFakeBackend(options);
  if (tested) backend.handle({ v: 1, type: 'TEST_API_KEY' });
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: { type?: string }) =>
    Promise.resolve(
      message.type === 'CLAVIS_INJECT_TAB' ? injectReplies.shift() : backend.handle(message),
    )) as never);
  vi.spyOn(browser.tabs, 'query').mockImplementation((() =>
    Promise.resolve([{ id: 7, url: tabUrl }])) as unknown as never);
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
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await user.click(screen.getByRole('button', { name: 'Connect Groq' }));
    // Straight to Settings > Groq API key, not just the top of Settings.
    expect(create).toHaveBeenCalledWith({
      url: expect.stringMatching(/\/options\.html#section-key$/),
    });
  });

  it('leads with the corrective action when there is no key', async () => {
    setup();
    await waitFor(() => expect(groq()).toHaveTextContent('Setup needed'));
    expect(
      screen.getByText('Explain needs a Groq key. Listen and the PDF reader work without one.'),
    ).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Connect Groq' })).toHaveLength(1);
    const actions = screen.getByRole('region', { name: 'Quick actions' });
    expect(
      within(actions)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Connect Groq', 'Explain on this page', 'Open PDF reader']);
    expect(within(actions).getByRole('button', { name: 'Connect Groq' })).toHaveClass(
      'clavis-button--primary',
    );
    expect(
      within(actions).getByText('Select text on the page, then choose Explain on this page.'),
    ).toBeVisible();
  });

  it('tells a rejected key apart and opens Settings at the key', async () => {
    const user = setup(
      { key: { value: 'gsk_TESTpopup00000009', storage: 'local' }, groq: 'invalid' },
      false,
      true,
    );
    await waitFor(() => expect(groq()).toHaveTextContent('Key not working'));
    expect(screen.getByText(/Groq didn't accept your key/)).toBeVisible();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await user.click(screen.getByRole('button', { name: 'Update key' }));
    expect(create).toHaveBeenCalledWith({
      url: expect.stringMatching(/\/options\.html#section-key$/),
    });
  });

  it('shows "connected" when Groq is ready, and no fix-it button', async () => {
    setup({
      key: { value: 'gsk_TESTpopup00000001', storage: 'local' },
      onboarding: { disclosureAcceptedAt: 5 },
    });
    await waitFor(() => expect(groq()).toHaveTextContent('Connected'));
    expect(screen.queryByRole('button', { name: 'Connect Groq' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Update key' })).toBeNull();
    const actions = screen.getByRole('region', { name: 'Quick actions' });
    expect(within(actions).getByRole('button', { name: 'Explain on this page' })).toHaveClass(
      'clavis-button--primary',
    );
    expect(within(actions).getByRole('button', { name: 'Open PDF reader' })).toBeVisible();
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
  it('is offered without website access and injects into the current tab', async () => {
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

  it('also works when website access is on', async () => {
    const user = setup({}, true);
    injectReplies.push({ ok: true, shown: true });
    await waitFor(() => expect(screen.getByTestId('popup-site')).toHaveTextContent('On'));
    await user.click(screen.getByRole('button', { name: 'Explain on this page' }));
    await waitFor(() => expect(window.close).toHaveBeenCalled());
    expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CLAVIS_INJECT_TAB', tabId: 7 }),
    );
  });

  it('blocks a second injection while the first is pending', async () => {
    const user = setup({}, true);
    let finish: (value: unknown) => void = () => undefined;
    injectReplies.push(new Promise<unknown>((resolve) => (finish = resolve)));
    const button = await screen.findByRole('button', { name: 'Explain on this page' });
    await user.click(button);
    expect(screen.getByRole('button', { name: 'Opening Explain…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Opening Explain…');
    await user.click(screen.getByRole('button', { name: 'Opening Explain…' }));
    const calls = vi
      .mocked(browser.runtime.sendMessage)
      .mock.calls.filter(
        ([message]) => (message as { type?: string }).type === 'CLAVIS_INJECT_TAB',
      );
    expect(calls).toHaveLength(1);
    finish({ ok: true, shown: false });
    expect(await screen.findByText(/No text is selected/)).toBeVisible();
  });
});

describe('PDF tabs (FR-056)', () => {
  it('points a tab that looks like a PDF to the Clavis reader and the help', async () => {
    const user = setup({}, false, false, 'https://example.com/papers/Report.PDF?download=1');
    const help = await screen.findByTestId('popup-pdf-help');
    expect(within(help).getByRole('heading', { name: 'This tab looks like a PDF' })).toBeVisible();
    expect(help).toHaveTextContent(/can't add its toolbar to Chrome's built-in PDF viewer/);
    // "Explain on this page" cannot work in Chrome's viewer, so it is not offered there.
    expect(screen.queryByRole('button', { name: 'Explain on this page' })).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Quick actions' })).getByRole('button', {
        name: 'Open PDF reader',
      }),
    ).toHaveClass('clavis-button--primary');
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await user.click(within(help).getByRole('button', { name: 'How to read PDFs with Clavis' }));
    expect(create).toHaveBeenCalledWith({
      url: expect.stringMatching(/\/options\.html#section-help-pdf$/),
    });
  });

  it('is silent on ordinary pages and when the address cannot be read', async () => {
    setup();
    await screen.findByRole('button', { name: 'Explain on this page' });
    expect(screen.queryByTestId('popup-pdf-help')).toBeNull();
    cleanup();
    setup({}, true, false, '');
    await waitFor(() => expect(screen.getByTestId('popup-site')).toHaveTextContent('On'));
    expect(screen.queryByTestId('popup-pdf-help')).toBeNull();
  });
});

describe('help without website access (FR-018)', () => {
  it('offers the three ways to use Clavis and a way to turn automatic mode on', async () => {
    const user = setup({}, false);
    const help = await screen.findByTestId('popup-site-help');
    expect(help).not.toHaveAttribute('open');
    await user.click(within(help).getByText('Using Clavis without website access'));
    expect(help).toHaveAttribute('open');
    expect(within(help).getByText(/right-click it and choose Explain with Clavis/)).toBeVisible();
    expect(within(help).getByText(/press Alt\+Shift\+E/)).toBeVisible();
    const create = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    await user.click(within(help).getByRole('button', { name: 'Turn on website access' }));
    expect(create).toHaveBeenCalledWith({
      url: expect.stringMatching(/\/options\.html#section-site-access$/),
    });
  });

  it('is not shown once website access is on', async () => {
    setup({}, true);
    await waitFor(() => expect(screen.getByTestId('popup-site')).toHaveTextContent('On'));
    expect(screen.queryByTestId('popup-site-help')).toBeNull();
  });
});

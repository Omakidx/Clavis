// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { Wizard } from '../../../components/onboarding/Wizard';
import catalog from '../../../public/_locales/en/messages.json';
import {
  createFakeBackend,
  installBackend,
  installCatalog,
  installPermissions,
  type FakeBackend,
  type FakeBackendOptions,
} from '../ui-client/support';

const FAKE_KEY = 'gsk_TESTabcdefghijklmnop1234';
const text = (key: keyof typeof catalog): string => catalog[key].message;

let backend: FakeBackend;

function setup(options: FakeBackendOptions = {}, permissions = { granted: false, answer: true }) {
  installCatalog();
  backend = createFakeBackend(options);
  installBackend(backend);
  const perms = installPermissions(permissions);
  const user = userEvent.setup();
  render(<Wizard />);
  return { user, perms };
}

const next = () => screen.getByRole('button', { name: 'Next' });
const heading = () => screen.getByRole('heading', { level: 2 });

afterEach(() => cleanup());

describe('wizard navigation', () => {
  it('starts at the purpose step with a progress list and moves focus to each heading', async () => {
    const { user } = setup();
    expect(heading()).toHaveTextContent(text('onbPurposeTitle'));
    const progress = screen.getByRole('navigation', { name: 'Setup progress' });
    expect(within(progress).getAllByRole('listitem')).toHaveLength(8);
    expect(within(progress).getByRole('listitem', { current: 'step' })).toHaveTextContent(
      'Welcome',
    );
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();

    await user.click(next());
    expect(heading()).toHaveTextContent(text('disclosureTitle'));
    expect(heading()).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(heading()).toHaveTextContent(text('onbPurposeTitle'));
    expect(heading()).toHaveFocus();
  });
});

describe('disclosure step (FR-002)', () => {
  it('shows the approved copy verbatim and blocks Next until "I understand"', async () => {
    const { user } = setup();
    await user.click(next());
    for (const key of [
      'disclosureSelect',
      'disclosureListen',
      'disclosureExplain',
      'disclosurePdf',
      'disclosureNoServer',
    ] as const) {
      expect(
        screen.getByText(new RegExp(text(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))),
      ).toBeVisible();
    }
    expect(screen.getByRole('link', { name: /Groq privacy policy/ })).toHaveAttribute(
      'href',
      'https://groq.com/privacy-policy/',
    );
    await screen.findByRole('button', { name: 'I understand' });
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'I understand' }));
    await waitFor(() => expect(backend.calls.map((c) => c.type)).toContain('ACCEPT_DISCLOSURE'));
    expect(backend.state.onboarding.disclosureAcceptedAt).not.toBeNull();
    expect(await screen.findByRole('status')).toHaveTextContent(text('onbDisclosureSaved'));
    // Keyboard flow continues on the newly available Next button.
    await waitFor(() => expect(next()).toHaveFocus());
  });
});

describe('website access step (FR-009, UJ-02b)', () => {
  async function toAccess(user: ReturnType<typeof userEvent.setup>) {
    await user.click(next());
    await user.click(await screen.findByRole('button', { name: 'I understand' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByRole('button', { name: text('siteAccessGrant') });
  }

  it('"Not now" is a complete answer: stored as declined, and the right-click path is explained', async () => {
    const { user, perms } = setup();
    await toAccess(user);
    expect(screen.getByText(/right-click it and choose Explain with Clavis/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
    await user.click(screen.getByRole('button', { name: text('siteAccessSkip') }));
    await waitFor(() => expect(backend.state.onboarding.siteAccessChoice).toBe('declined'));
    expect(perms.request).not.toHaveBeenCalled();
    expect(await screen.findByRole('status')).toHaveTextContent(text('toolbarSiteAccessSkipped'));
    expect(await screen.findByRole('button', { name: 'Next' })).toBeVisible();
  });

  it('asks Chrome for permission synchronously inside the click, then stores "granted"', async () => {
    const { user, perms } = setup();
    await toAccess(user);
    const button = screen.getByRole('button', { name: text('siteAccessGrant') });
    // fireEvent is synchronous: the prompt must already be requested when it returns.
    act(() => {
      fireEvent.click(button);
    });
    expect(perms.request).toHaveBeenCalledTimes(1);
    expect(perms.request).toHaveBeenCalledWith({ origins: ['http://*/*', 'https://*/*'] });
    await waitFor(() => expect(backend.state.onboarding.siteAccessChoice).toBe('granted'));
    expect(await screen.findByRole('status')).toHaveTextContent(text('toolbarSiteAccessGranted'));
  });

  it('stores "declined" when the Chrome prompt is refused and keeps the extension usable', async () => {
    const { user } = setup({}, { granted: false, answer: false });
    await toAccess(user);
    await user.click(screen.getByRole('button', { name: text('siteAccessGrant') }));
    await waitFor(() => expect(backend.state.onboarding.siteAccessChoice).toBe('declined'));
    expect(await screen.findByRole('status')).toHaveTextContent(text('toolbarSiteAccessDenied'));
  });
});

async function toConnect(user: ReturnType<typeof userEvent.setup>) {
  await user.click(next());
  await user.click(await screen.findByRole('button', { name: 'I understand' }));
  await user.click(await screen.findByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('button', { name: text('siteAccessSkip') }));
  await user.click(await screen.findByRole('button', { name: 'Next' }));
  await user.click(await screen.findByRole('button', { name: 'I have my key' }));
  await screen.findByLabelText('Your Groq key');
}

describe('Groq key steps (FR-003, FR-004, UJ-05)', () => {
  it('links to the Groq keys page in a new tab and explains how to paste the key', async () => {
    const { user } = setup();
    await user.click(next());
    await user.click(await screen.findByRole('button', { name: 'I understand' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: text('siteAccessSkip') }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    const link = screen.getByRole('link', { name: /Open the Groq keys page/ });
    expect(link).toHaveAttribute('href', 'https://console.groq.com/keys');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(screen.getByText(text('keyWarning'))).toBeVisible();
    expect(screen.getByText(text('onbGetKeyStep3'))).toBeVisible();
  });

  it('can be skipped with "Set up later", and setup still finishes', async () => {
    const { user } = setup();
    await user.click(next());
    await user.click(await screen.findByRole('button', { name: 'I understand' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: text('siteAccessSkip') }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Set up later' }));
    expect(heading()).toHaveTextContent(text('onbPrefsTitle'));
    await user.click(next());
    expect(heading()).toHaveTextContent(text('onbPracticeTitle'));
    expect(screen.getByText(text('onbPracticeNoKey'))).toBeVisible();
    const practice = screen.getByRole('link', { name: /Open the practice page/ });
    expect(practice).toHaveAttribute('href', '/practice.html');
    expect(practice).toHaveAttribute('target', '_blank');
    await user.click(next());
    expect(heading()).toHaveTextContent(text('onbDoneTitle'));
    expect(screen.getByText(text('onbDoneNoKey'))).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Finish setup' }));
    await waitFor(() => expect(backend.state.onboarding.completed).toBe(true));
    expect(await screen.findByText(text('onbDoneSaved'))).toBeVisible();
    expect(backend.state.key).toBeNull();
  });

  it('masks the key, offers show/hide, and validates before sending', async () => {
    const { user } = setup();
    await toConnect(user);
    const input = screen.getByLabelText('Your Groq key');
    expect(input).toHaveAttribute('type', 'password');
    await user.type(input, FAKE_KEY);
    const toggle = screen.getByRole('button', { name: 'Show key' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(input).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide key' }));
    expect(input).toHaveAttribute('type', 'password');

    await user.clear(input);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(text('keyEmptyError'))).toBeVisible();
    await user.type(input, 'gsk_TEST with spaces');
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/doesn't look like a key/)).toBeVisible();
    expect(backend.calls.some((c) => c.type === 'SET_API_KEY')).toBe(false);
  });

  it('offers the two storage choices with the approved copy and "local" preselected', async () => {
    const { user } = setup();
    await toConnect(user);
    const local = screen.getByRole('radio', { name: /Remember on this device/ });
    const session = screen.getByRole('radio', { name: /Only for this session/ });
    expect(local).toBeChecked();
    expect(
      screen.getByText(/It is not encrypted: anyone with access to your Chrome profile/),
    ).toBeVisible();
    await user.click(session);
    await user.type(screen.getByLabelText('Your Groq key'), FAKE_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(backend.state.key?.storage).toBe('session'));
  });

  it('keeps the typed key out of the DOM value attribute (uncontrolled input)', async () => {
    const { user } = setup();
    await toConnect(user);
    const input = screen.getByLabelText('Your Groq key') as HTMLInputElement;
    await user.type(input, FAKE_KEY);
    expect(input.value).toBe(FAKE_KEY);
    expect(input.getAttribute('value')).toBeNull();
    expect(input).toHaveAttribute('autocomplete', 'new-password');
    expect(input).toHaveAttribute('spellcheck', 'false');
    expect(input).toHaveAttribute('autocapitalize', 'off');
    expect(document.documentElement.outerHTML).not.toContain(FAKE_KEY);
    await user.click(screen.getByRole('button', { name: 'Show key' }));
    expect(input.getAttribute('value')).toBeNull();
  });

  it('shows a working key, shows only the last four, and never echoes the key', async () => {
    const { user } = setup({ groq: 'valid' });
    await toConnect(user);
    await user.type(screen.getByLabelText('Your Groq key'), FAKE_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/Groq accepted your key ending in 1234/)).toBeVisible();
    expect(backend.calls.map((c) => c.type)).toEqual(
      expect.arrayContaining(['SET_API_KEY', 'TEST_API_KEY']),
    );
    expect(document.body.textContent).not.toContain(FAKE_KEY);
    // The key is gone from the page once handed over: no input holds it.
    expect(screen.queryByLabelText('Your Groq key')).toBeNull();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus());
  });

  it('shows an invalid key distinctly and lets the user try another', async () => {
    const { user } = setup({ groq: 'invalid' });
    await toConnect(user);
    await user.type(screen.getByLabelText('Your Groq key'), FAKE_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/Groq didn't accept this key/)).toBeVisible();
    expect(screen.queryByText(/couldn't reach Groq/)).toBeNull();
    expect(document.body.textContent).not.toContain(FAKE_KEY);
    await user.click(screen.getByRole('button', { name: 'Change key' }));
    const input = screen.getByLabelText('Your Groq key') as HTMLInputElement;
    expect(input).toBeEnabled();
    expect(input.value).toBe('');
  });

  it('shows "connection not verified" (offline) differently from invalid', async () => {
    const { user } = setup({ groq: 'offline' });
    await toConnect(user);
    await user.type(screen.getByLabelText('Your Groq key'), FAKE_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    expect(await screen.findByText(/couldn't reach Groq to check it/)).toBeVisible();
    expect(screen.queryByText(/Groq didn't accept this key/)).toBeNull();
    expect(document.body.textContent).not.toContain(FAKE_KEY);
  });

  it('shows localized guidance, never the raw provider text, when saving fails', async () => {
    const { user } = setup();
    await toConnect(user);
    backend.state.failNext = 'STORAGE_UNAVAILABLE';
    await user.type(screen.getByLabelText('Your Groq key'), FAKE_KEY);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/protected extension storage/);
    expect(document.body.textContent).not.toContain('RAW_PROVIDER_TEXT');
    // The paste is kept after a failed save so the user can retry without pasting again.
    expect((screen.getByLabelText('Your Groq key') as HTMLInputElement).value).toBe(FAKE_KEY);
  });
});

describe('preferences step (FR-006, FR-005)', () => {
  async function toPreferences(user: ReturnType<typeof userEvent.setup>) {
    await user.click(next());
    await user.click(await screen.findByRole('button', { name: 'I understand' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: text('siteAccessSkip') }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Set up later' }));
    await screen.findByLabelText('Explanation language');
  }

  it('saves each change at once with a confirmation', async () => {
    const { user } = setup();
    await toPreferences(user);
    await user.click(screen.getByRole('radio', { name: /Simple/ }));
    await waitFor(() => expect(backend.state.preferences.readingLevel).toBe('simple'));
    expect(await screen.findByText('Saved.')).toBeVisible();
    await user.click(screen.getByRole('radio', { name: 'Slow' }));
    await waitFor(() => expect(backend.state.preferences.ttsRate).toBe(0.75));
    await user.click(screen.getByRole('radio', { name: /Only when I ask/ }));
    await waitFor(() => expect(backend.state.preferences.tooltipBehavior).toBe('on-demand'));
    await user.selectOptions(screen.getByLabelText('Explanation language'), 'es');
    await waitFor(() => expect(backend.state.preferences.explanationLanguage).toBe('es'));
  });

  it('explains the empty model list instead of inventing models when no key is connected', async () => {
    const { user } = setup();
    await toPreferences(user);
    expect(screen.getByText(text('modelListNoKey'))).toBeVisible();
    const select = screen.getByLabelText('Model used for Explain') as HTMLSelectElement;
    expect(select.options).toHaveLength(1);
    expect(select.value).toBe('');
  });

  it('lists the models of a connected key', async () => {
    installCatalog();
    backend = createFakeBackend({
      key: { value: FAKE_KEY, storage: 'local' },
      groq: 'valid',
      verifyOnSet: true,
    });
    backend.handle({ v: 1, type: 'TEST_API_KEY' });
    installBackend(backend);
    installPermissions({ granted: false });
    const user = userEvent.setup();
    render(<Wizard />);
    await user.click(next());
    await user.click(await screen.findByRole('button', { name: 'I understand' }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: text('siteAccessSkip') }));
    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'I have my key' }));
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    const select = (await screen.findByLabelText('Model used for Explain')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      '',
      'openai/gpt-oss-20b',
      'llama-3.3-70b-versatile',
    ]);
    await user.selectOptions(select, 'openai/gpt-oss-20b');
    await waitFor(() => expect(backend.state.preferences.model).toBe('openai/gpt-oss-20b'));
  });
});

describe('service worker restarts', () => {
  it('retries a silent first reply so the wizard still loads', async () => {
    const { user } = setup({ silentReplies: 1 });
    await user.click(next());
    await user.click(
      await screen.findByRole('button', { name: 'I understand' }, { timeout: 3000 }),
    );
    await waitFor(() => expect(backend.state.onboarding.disclosureAcceptedAt).not.toBeNull());
  });
});

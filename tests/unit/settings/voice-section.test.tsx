// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceSection, VoiceStepField } from '../../../components/settings/VoiceSection';
import { MESSAGE_VERSION } from '../../../lib/config/constants';
import type { VoicesReport } from '../../../lib/contracts';
import { useSettings } from '../../../lib/ui-client/use-settings';
import {
  createFakeBackend,
  installBackend,
  installCatalog,
  NO_VOICES,
  type FakeBackend,
  type FakeBackendOptions,
} from '../ui-client/support';

// Settings > Voice (FR-025, FR-006): per-engine counts, empty state, chooser, test voice.

function Harness({ compact = false }: { compact?: boolean }) {
  const settings = useSettings();
  return compact ? <VoiceStepField settings={settings} /> : <VoiceSection settings={settings} />;
}

let backend: FakeBackend;
function setup(options: FakeBackendOptions = {}, compact = false) {
  installCatalog();
  backend = createFakeBackend(options);
  installBackend(backend);
  render(<Harness compact={compact} />);
  return userEvent.setup();
}

const voice = (name: string, lang: string, remote = false) => ({
  name,
  lang,
  engine: 'chrome-tts' as const,
  remote,
});
const fallbackVoice = (name: string, lang: string) => ({
  name,
  lang,
  engine: 'offscreen-web-speech' as const,
  remote: false,
});

const WITH_VOICES: VoicesReport = {
  platform: 'win',
  defaultEngine: 'chrome-tts',
  engines: {
    chromeTts: {
      voices: [
        voice('Microsoft David', 'en-US'),
        voice('Microsoft Hazel', 'en-GB'),
        voice('Google Deutsch', 'de-DE', true),
      ],
    },
    offscreen: {
      available: true,
      voices: [fallbackVoice('eSpeak French', 'fr'), fallbackVoice('Fallback FR', 'fr')],
    },
  },
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('empty state (this Linux machine has no voices)', () => {
  it('says so plainly with zero counts and the Linux hint, and disables what cannot work', async () => {
    setup();
    expect(await screen.findByText('No voices found on this device')).toBeVisible();
    expect(
      screen.getByText(
        'Install speech-dispatcher and a voice such as espeak-ng, then restart Chrome.',
      ),
    ).toBeVisible();
    const counts = screen.getByTestId('voice-counts');
    expect(within(counts).getByText('Chrome voices: 0')).toBeVisible();
    expect(within(counts).getByText('Fallback voices: not in use')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Test voice' })).toBeDisabled();
    const chooser = screen.getByRole('combobox', { name: 'Voice' }) as HTMLSelectElement;
    expect(chooser).toBeDisabled();
    expect(chooser.options).toHaveLength(1);
    expect(chooser.options[0]?.textContent).toBe('Automatic (best match)');
  });

  it('gives the generic hint off Linux', async () => {
    setup({ voices: { ...NO_VOICES, platform: 'mac' } });
    expect(await screen.findByText('No voices found on this device')).toBeVisible();
    expect(
      screen.getByText(/Install a text-to-speech voice in your system settings/),
    ).toBeVisible();
    expect(screen.queryByText(/espeak-ng/)).toBeNull();
  });
});

describe('voices present', () => {
  it('shows the count per engine and groups the chooser by engine', async () => {
    setup({ voices: WITH_VOICES });
    const counts = await screen.findByTestId('voice-counts');
    expect(within(counts).getByText('Chrome voices: 3')).toBeVisible();
    expect(within(counts).getByText('Fallback voices: 2')).toBeVisible();
    expect(within(counts).getByText('Listen will use: Chrome voices')).toBeVisible();
    const chooser = screen.getByRole('combobox', { name: 'Voice' }) as HTMLSelectElement;
    const groups = Array.from(chooser.querySelectorAll('optgroup')).map((g) => g.label);
    expect(groups).toEqual(['Chrome voices', 'Fallback voices']);
    expect(chooser.options[0]?.textContent).toBe('Automatic (best match)');
    expect(screen.getByRole('option', { name: 'Google Deutsch (de-DE) (online)' })).toBeVisible();
    expect(screen.queryByText('No voices found on this device')).toBeNull();
  });

  it('hides the Fallback group when that engine is not available', async () => {
    setup({
      voices: {
        ...WITH_VOICES,
        engines: {
          chromeTts: WITH_VOICES.engines.chromeTts,
          offscreen: { available: false, voices: [fallbackVoice('Ghost', 'en')] },
        },
      },
    });
    await screen.findByTestId('voice-counts');
    const chooser = screen.getByRole('combobox', { name: 'Voice' }) as HTMLSelectElement;
    expect(Array.from(chooser.querySelectorAll('optgroup')).map((g) => g.label)).toEqual([
      'Chrome voices',
    ]);
    expect(screen.queryByRole('option', { name: /Ghost/ })).toBeNull();
  });

  it('filters the voice list by language', async () => {
    const user = setup({ voices: WITH_VOICES });
    const filter = (await screen.findByLabelText('Show voices for')) as HTMLSelectElement;
    expect(screen.getByRole('option', { name: /Microsoft David/ })).toBeVisible();
    await user.selectOptions(filter, 'de');
    expect(screen.queryByRole('option', { name: /Microsoft David/ })).toBeNull();
    expect(screen.getByRole('option', { name: /Google Deutsch/ })).toBeVisible();
  });

  it('starts filtered to the saved voice language when a voice speaks it', async () => {
    setup({ voices: WITH_VOICES, preferences: { ttsLang: 'de' } });
    const filter = (await screen.findByLabelText('Show voices for')) as HTMLSelectElement;
    expect(filter.value).toBe('de');
  });

  it('saves the chosen voice, and null for Automatic', async () => {
    const user = setup({ voices: WITH_VOICES });
    const chooser = (await screen.findByRole('combobox', { name: 'Voice' })) as HTMLSelectElement;
    await user.selectOptions(chooser, 'Microsoft Hazel');
    await waitFor(() => expect(backend.state.preferences.ttsVoice).toBe('Microsoft Hazel'));
    expect(await screen.findByText('Saved.')).toBeVisible();
    await user.selectOptions(chooser, '');
    await waitFor(() => expect(backend.state.preferences.ttsVoice).toBeUndefined());
    expect(backend.calls.filter((c) => c.type === 'UPDATE_PREFERENCES').at(-1)).toMatchObject({
      patch: { ttsVoice: null },
    });
  });

  it('keeps a saved voice that is no longer installed visible instead of silently changing it', async () => {
    setup({ voices: WITH_VOICES, preferences: { ttsVoice: 'Old Voice' } });
    const chooser = (await screen.findByRole('combobox', { name: 'Voice' })) as HTMLSelectElement;
    expect(chooser.value).toBe('Old Voice');
    expect(screen.getByRole('option', { name: 'Old Voice (not installed)' })).toBeVisible();
    expect(backend.calls.some((c) => c.type === 'UPDATE_PREFERENCES')).toBe(false);
  });
});

describe('language and speed (FR-006)', () => {
  it('sends only the changed field and clears the voice language with null', async () => {
    const user = setup({ preferences: { ttsLang: 'fr' } });
    const lang = (await screen.findByLabelText('Voice language')) as HTMLSelectElement;
    expect(lang.value).toBe('fr');
    await user.selectOptions(lang, '');
    await waitFor(() => expect(backend.state.preferences.ttsLang).toBeUndefined());
    expect(backend.calls.filter((c) => c.type === 'UPDATE_PREFERENCES').at(-1)).toMatchObject({
      patch: { ttsLang: null },
    });
  });

  it('shows the stored speed and saves Slow', async () => {
    const user = setup({ preferences: { ttsRate: 1 } });
    expect(await screen.findByRole('radio', { name: 'Normal' })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'Slow' }));
    await waitFor(() => expect(backend.state.preferences.ttsRate).toBe(0.75));
  });

  it('shows a custom playback speed without overwriting it', async () => {
    setup({ preferences: { ttsRate: 1.5 } });
    expect(await screen.findByRole('radio', { name: /Custom speed \(1.5×\)/ })).toBeChecked();
    expect(backend.calls.some((c) => c.type === 'UPDATE_PREFERENCES')).toBe(false);
  });
});

describe('online voices (D-22: only on explicit choice)', () => {
  it('labels them, and shows a persistent privacy note only while an online voice is chosen', async () => {
    const user = setup({ voices: WITH_VOICES });
    const chooser = await screen.findByRole('combobox', { name: 'Voice' });
    expect(screen.queryByTestId('voice-online-note')).toBeNull();
    await user.selectOptions(chooser, 'Google Deutsch');
    await waitFor(() => expect(backend.state.preferences.ttsVoice).toBe('Google Deutsch'));
    expect(await screen.findByTestId('voice-online-note')).toHaveTextContent(
      'This voice is an online service: when you press Listen, the selected text is sent to that service to be spoken.',
    );
    await user.selectOptions(chooser, '');
    await waitFor(() => expect(screen.queryByTestId('voice-online-note')).toBeNull());
  });

  it('the Automatic hint promises an on-device voice', async () => {
    setup({ voices: WITH_VOICES });
    expect(await screen.findByText(/best voice on this device/)).toBeVisible();
  });
});

describe('chooser details', () => {
  it('lists a voice name once even when both engines report it (Chrome wins)', async () => {
    setup({
      voices: {
        ...WITH_VOICES,
        engines: {
          chromeTts: { voices: [voice('Same Name', 'en-US')] },
          offscreen: { available: true, voices: [fallbackVoice('Same Name', 'en-US')] },
        },
      },
    });
    const chooser = (await screen.findByRole('combobox', { name: 'Voice' })) as HTMLSelectElement;
    const values = Array.from(chooser.options).map((o) => o.value);
    expect(values.filter((v) => v === 'Same Name')).toHaveLength(1);
    expect(
      chooser.querySelector('optgroup[label="Chrome voices"] option[value="Same Name"]'),
    ).not.toBeNull();
    expect(chooser.querySelector('optgroup[label="Fallback voices"]')).toBeNull();
  });

  it('the language filter follows a later change of the voice language', async () => {
    const user = setup({ voices: WITH_VOICES });
    const filter = (await screen.findByRole('combobox', {
      name: 'Show voices for',
    })) as HTMLSelectElement;
    expect(filter.value).toBe('');
    await user.selectOptions(screen.getByLabelText('Voice language'), 'de');
    await waitFor(() => expect(filter.value).toBe('de'));
  });
});

describe('Test voice', () => {
  const speaks = () => backend.calls.filter((c) => c.type === 'TTS_SPEAK');

  it('speaks the sample with the chosen voice and the default speed, and shows playing only after started', async () => {
    const listeners: Array<(message: unknown) => void> = [];
    vi.spyOn(browser.runtime.onMessage, 'addListener').mockImplementation(
      ((listener: (message: unknown) => void) => void listeners.push(listener)) as never,
    );
    const user = setup({
      voices: WITH_VOICES,
      preferences: { ttsVoice: 'Microsoft Hazel', ttsRate: 0.75 },
    });
    await user.click(await screen.findByRole('button', { name: 'Test voice' }));
    await waitFor(() => expect(speaks()).toHaveLength(1));
    expect(speaks()[0]).toMatchObject({
      text: 'Hello, this is how Clavis sounds.',
      voiceName: 'Microsoft Hazel',
      lang: 'en-GB',
      rate: 0.75,
    });
    expect(await screen.findByText('Playing the test sentence.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();

    // The background reports the end for THIS request only.
    const requestId = speaks()[0]?.['requestId'];
    listeners.forEach((l) =>
      l({ v: MESSAGE_VERSION, type: 'TTS_EVENT', requestId: 'someone-else', state: 'ended' }),
    );
    expect(screen.getByRole('button', { name: 'Stop' })).toBeVisible();
    listeners.forEach((l) =>
      l({ v: MESSAGE_VERSION, type: 'TTS_EVENT', requestId, state: 'ended' }),
    );
    expect(await screen.findByRole('button', { name: 'Test voice' })).toBeVisible();
    expect(await screen.findByText('Test finished.')).toBeVisible();
  });

  it('Stop sends TTS_STOP for the test request', async () => {
    const user = setup({ voices: WITH_VOICES });
    await user.click(await screen.findByRole('button', { name: 'Test voice' }));
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    const requestId = backend.calls.find((c) => c.type === 'TTS_SPEAK')?.['requestId'];
    expect(backend.calls.find((c) => c.type === 'TTS_STOP')).toMatchObject({ requestId });
    expect(screen.getByRole('button', { name: 'Test voice' })).toBeVisible();
  });

  it('late success after Stop is stopped too (the audio must not play on)', async () => {
    installCatalog();
    backend = createFakeBackend({ voices: WITH_VOICES });
    let answer: (value: unknown) => void = () => undefined;
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: unknown) => {
      if ((message as { type?: string }).type === 'TTS_SPEAK') {
        backend.calls.push({ ...(message as { type: string }) });
        return new Promise((resolve) => (answer = resolve));
      }
      return Promise.resolve(backend.handle(message));
    }) as unknown as typeof browser.runtime.sendMessage);
    render(<Harness />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Test voice' }));
    // Pressing again while it is starting stops it.
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    const stops = () => backend.calls.filter((c) => c.type === 'TTS_STOP').length;
    expect(stops()).toBe(1);
    answer({ ok: true, data: { state: 'started', engine: 'chrome-tts', remote: false } });
    await waitFor(() => expect(stops()).toBe(2));
    expect(screen.getByRole('button', { name: 'Test voice' })).toBeVisible();
  });

  it('leaving the page while starting stops a late start too', async () => {
    installCatalog();
    backend = createFakeBackend({ voices: WITH_VOICES });
    let answer: (value: unknown) => void = () => undefined;
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: unknown) => {
      if ((message as { type?: string }).type === 'TTS_SPEAK') {
        backend.calls.push({ ...(message as { type: string }) });
        return new Promise((resolve) => (answer = resolve));
      }
      return Promise.resolve(backend.handle(message));
    }) as unknown as typeof browser.runtime.sendMessage);
    const view = render(<Harness />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Test voice' }));
    view.unmount();
    answer({ ok: true, data: { state: 'started', engine: 'chrome-tts', remote: false } });
    await waitFor(() =>
      expect(backend.calls.filter((c) => c.type === 'TTS_STOP').length).toBeGreaterThanOrEqual(2),
    );
  });

  it('speaks the sample in the chosen voice language, and an exact voice carries its own language only', async () => {
    const user = setup({
      voices: WITH_VOICES,
      preferences: { ttsVoice: 'Test Voix FR', ttsLang: 'en' },
    });
    // The saved voice is not in this list: pick a French one that is.
    const chooser = await screen.findByRole('combobox', { name: 'Voice' });
    expect(chooser).toBeVisible();
    // The voice language is English, so the list starts filtered to English: show all.
    await user.selectOptions(screen.getByRole('combobox', { name: 'Show voices for' }), '');
    await user.selectOptions(chooser, 'Fallback FR');
    await user.click(screen.getByRole('button', { name: 'Test voice' }));
    await waitFor(() => expect(backend.calls.some((c) => c.type === 'TTS_SPEAK')).toBe(true));
    const speak = backend.calls.find((c) => c.type === 'TTS_SPEAK');
    expect(speak).toMatchObject({
      voiceName: 'Fallback FR',
      lang: 'fr',
      text: 'Bonjour, voici comment parle Clavis.',
    });
  });

  it('a voice with no language is offered, and tested without inventing a language', async () => {
    const user = setup({
      voices: {
        ...WITH_VOICES,
        engines: {
          chromeTts: {
            voices: [
              ...WITH_VOICES.engines.chromeTts.voices,
              { name: 'Mystery', engine: 'chrome-tts', remote: false },
            ],
          },
          offscreen: { available: false, voices: [] },
        },
      },
      preferences: { ttsLang: 'fr' },
    });
    const chooser = await screen.findByRole('combobox', { name: 'Voice' });
    // Kept by the language filter: it may speak anything.
    expect(screen.getByRole('option', { name: 'Mystery' })).toBeVisible();
    await user.selectOptions(chooser, 'Mystery');
    await user.click(screen.getByRole('button', { name: 'Test voice' }));
    await waitFor(() => expect(backend.calls.some((c) => c.type === 'TTS_SPEAK')).toBe(true));
    const speak = backend.calls.find((c) => c.type === 'TTS_SPEAK') as Record<string, unknown>;
    expect(speak['voiceName']).toBe('Mystery');
    expect(speak).not.toHaveProperty('lang');
  });

  it.each([
    ['no-voice-language', 'No voice on this device speaks this language'],
    ['online-only', 'Only online voices are available for this language'],
    ['start-failed', "The voice didn't start"],
  ] as const)('reason %s explains itself without an install hint', async (speak, text) => {
    const user = setup({ voices: WITH_VOICES, speak });
    await user.click(await screen.findByRole('button', { name: 'Test voice' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(text);
    expect(alert).not.toHaveTextContent('Install');
  });

  it('a no-voice answer explains itself with the Linux hint, not a stuck state', async () => {
    const user = setup({ voices: WITH_VOICES, speak: 'no-voice-linux' });
    await user.click(await screen.findByRole('button', { name: 'Test voice' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Voice isn't available on this device.");
    expect(alert).toHaveTextContent('Install speech-dispatcher');
    expect(screen.getByRole('button', { name: 'Test voice' })).toBeEnabled();
    expect(document.body.textContent).not.toContain('RAW_PROVIDER_TEXT');
  });
});

describe('load failure', () => {
  it('shows an error with Try again when the voices cannot be read', async () => {
    installCatalog();
    backend = createFakeBackend();
    installBackend(backend);
    backend.state.failNext = 'INTERNAL_ERROR';
    render(<Harness />);
    expect(await screen.findByRole('alert')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

describe('onboarding (compact)', () => {
  it('offers just the chooser and Test voice when voices exist', async () => {
    const user = setup({ voices: WITH_VOICES }, true);
    const chooser = (await screen.findByRole('combobox', { name: 'Voice' })) as HTMLSelectElement;
    expect(screen.queryByLabelText('Show voices for')).toBeNull();
    expect(screen.queryByTestId('voice-counts')).toBeNull();
    await user.selectOptions(chooser, 'Microsoft David');
    await waitFor(() => expect(backend.state.preferences.ttsVoice).toBe('Microsoft David'));
  });

  it('says there are no voices (with the hint) instead of showing a dead chooser', async () => {
    setup({}, true);
    expect(await screen.findByText('No voices found on this device')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Test voice' })).toBeNull();
  });
});

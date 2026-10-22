// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { PreferencesSection } from '../../../components/settings/PreferencesSection';
import { DEFAULT_PREFERENCES } from '../../../lib/contracts';
import { useSettings } from '../../../lib/ui-client/use-settings';
import {
  createFakeBackend,
  installBackend,
  installCatalog,
  type FakeBackend,
  type FakeBackendOptions,
} from '../ui-client/support';

function Harness() {
  return <PreferencesSection settings={useSettings()} />;
}

let backend: FakeBackend;
function setup(options: FakeBackendOptions = {}) {
  installCatalog();
  backend = createFakeBackend(options);
  installBackend(backend);
  render(<Harness />);
  return userEvent.setup();
}

afterEach(() => cleanup());

describe('preferences section (FR-006)', () => {
  it('shows the stored values', async () => {
    setup({
      preferences: { readingLevel: 'advanced', ttsRate: 0.75, tooltipBehavior: 'on-demand' },
    });
    expect(await screen.findByRole('radio', { name: /Advanced/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Slow' })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Only when I ask/ })).toBeChecked();
    expect(screen.getByLabelText('Explanation language')).toHaveValue('en');
  });

  it('tells the user that toolbar changes apply to pages loaded afterwards', async () => {
    setup();
    expect(await screen.findByText(/apply to pages you load afterwards/)).toBeVisible();
  });

  it('saves immediately and confirms in a live region', async () => {
    const user = setup();
    await user.click(await screen.findByRole('radio', { name: /Advanced/ }));
    await waitFor(() => expect(backend.state.preferences.readingLevel).toBe('advanced'));
    const saved = await screen.findByText('Saved.');
    expect(saved.closest('[role="status"]')).not.toBeNull();
    expect(backend.calls.find((c) => c.type === 'UPDATE_PREFERENCES')).toMatchObject({
      patch: { readingLevel: 'advanced' },
    });
  });

  it('sends only the changed field and clears the voice language with null', async () => {
    const user = setup({ preferences: { ttsLang: 'fr' } });
    const voice = (await screen.findByLabelText('Voice language')) as HTMLSelectElement;
    expect(voice.value).toBe('fr');
    await user.selectOptions(voice, '');
    await waitFor(() => expect(backend.state.preferences.ttsLang).toBeUndefined());
    expect(backend.calls.filter((c) => c.type === 'UPDATE_PREFERENCES').at(-1)).toMatchObject({
      patch: { ttsLang: null },
    });
  });

  it('keeps a saved language that is not in the list selectable', async () => {
    setup({ preferences: { explanationLanguage: 'sw' } });
    const select = (await screen.findByLabelText('Explanation language')) as HTMLSelectElement;
    expect(select.value).toBe('sw');
  });

  it('shows a custom playback speed without overwriting it', async () => {
    setup({ preferences: { ttsRate: 1.5 } });
    expect(await screen.findByRole('radio', { name: /Custom speed \(1.5×\)/ })).toBeChecked();
    expect(backend.calls.some((c) => c.type === 'UPDATE_PREFERENCES')).toBe(false);
  });

  it('Reset to defaults restores them and says so', async () => {
    const user = setup({
      preferences: {
        readingLevel: 'simple',
        explanationLanguage: 'de',
        tooltipBehavior: 'on-demand',
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Reset to defaults' }));
    await waitFor(() => expect(backend.state.preferences).toEqual({ ...DEFAULT_PREFERENCES }));
    expect(await screen.findByText('Preferences were reset to their defaults.')).toBeVisible();
    expect(screen.getByRole('radio', { name: /Standard/ })).toBeChecked();
    expect(screen.getByLabelText('Explanation language')).toHaveValue('en');
  });

  it('explains a failed save and returns to the stored value', async () => {
    const user = setup();
    await screen.findByRole('radio', { name: /Standard/ });
    backend.state.failNext = 'STORAGE_UNAVAILABLE';
    await user.click(screen.getByRole('radio', { name: /Simple/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/protected extension storage/);
    expect(screen.getByRole('radio', { name: /Standard/ })).toBeChecked();
    expect(document.body.textContent).not.toContain('RAW_PROVIDER_TEXT');
  });
});

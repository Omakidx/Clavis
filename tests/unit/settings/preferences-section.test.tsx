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
      preferences: { readingLevel: 'advanced', tooltipBehavior: 'on-demand' },
    });
    expect(await screen.findByRole('radio', { name: /Advanced/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Only when I ask/ })).toBeChecked();
    expect(screen.getByLabelText('Explanation language')).toHaveValue('en');
    expect(screen.getByLabelText('Translation language')).toHaveValue('en');
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

  it('leaves the voice language and playback speed to the Voice section', async () => {
    setup();
    await screen.findByRole('radio', { name: /Advanced/ });
    expect(screen.queryByLabelText('Voice language')).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Slow' })).toBeNull();
  });

  it('keeps a saved language that is not in the list selectable', async () => {
    setup({ preferences: { explanationLanguage: 'sw', translationLanguage: 'eo' } });
    const select = (await screen.findByLabelText('Explanation language')) as HTMLSelectElement;
    expect(select.value).toBe('sw');
    expect(screen.getByLabelText('Translation language')).toHaveValue('eo');
  });

  it('saves Translation language independently of Explanation language', async () => {
    const user = setup({ preferences: { explanationLanguage: 'de' } });
    const translation = await screen.findByLabelText('Translation language');
    expect(translation).toHaveValue('de');
    await user.selectOptions(translation, 'fr');
    await waitFor(() => expect(backend.state.preferences.translationLanguage).toBe('fr'));
    expect(screen.getByLabelText('Explanation language')).toHaveValue('de');
    expect(screen.getByLabelText('Translation language')).toHaveValue('fr');
    expect(backend.calls.find((call) => call.type === 'UPDATE_PREFERENCES')).toMatchObject({
      patch: { translationLanguage: 'fr' },
    });
    await user.selectOptions(screen.getByLabelText('Explanation language'), 'it');
    expect(screen.getByLabelText('Translation language')).toHaveValue('fr');
  });

  it('Reset to defaults restores them and says so', async () => {
    const user = setup({
      preferences: {
        readingLevel: 'simple',
        explanationLanguage: 'de',
        translationLanguage: 'fr',
        tooltipBehavior: 'on-demand',
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Reset to defaults' }));
    await waitFor(() => expect(backend.state.preferences).toEqual({ ...DEFAULT_PREFERENCES }));
    expect(await screen.findByText('Preferences were reset to their defaults.')).toBeVisible();
    expect(screen.getByRole('radio', { name: /Standard/ })).toBeChecked();
    expect(screen.getByLabelText('Explanation language')).toHaveValue('en');
    expect(screen.getByLabelText('Translation language')).toHaveValue('en');
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

  it('restores the saved Translation language after a failed save', async () => {
    const user = setup({ preferences: { explanationLanguage: 'de', translationLanguage: 'fr' } });
    const select = await screen.findByLabelText('Translation language');
    expect(select).toHaveValue('fr');
    backend.state.failNext = 'STORAGE_UNAVAILABLE';
    await user.selectOptions(select, 'it');
    expect(await screen.findByRole('alert')).toHaveTextContent(/protected extension storage/);
    expect(screen.getByLabelText('Translation language')).toHaveValue('fr');
    expect(backend.state.preferences.translationLanguage).toBe('fr');
  });
});

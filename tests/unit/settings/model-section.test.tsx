// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ModelSection } from '../../../components/settings/ModelSection';
import { useKeyStatus } from '../../../lib/ui-client/use-key-status';
import { useSettings } from '../../../lib/ui-client/use-settings';
import {
  createFakeBackend,
  installBackend,
  installCatalog,
  type FakeBackend,
  type FakeBackendOptions,
} from '../ui-client/support';

function Harness() {
  const settings = useSettings();
  const keys = useKeyStatus();
  return <ModelSection settings={settings} keys={keys} />;
}

let backend: FakeBackend;
function setup(options: FakeBackendOptions, verified = true) {
  installCatalog();
  backend = createFakeBackend(options);
  if (verified) backend.handle({ v: 1, type: 'TEST_API_KEY' });
  installBackend(backend);
  render(<Harness />);
  return userEvent.setup();
}

afterEach(() => cleanup());

const KEY = { value: 'gsk_TESTmodelsection0001', storage: 'local' as const };

describe('model section (FR-005)', () => {
  it('offers the default plus the models of the key, and saves a choice', async () => {
    const user = setup({ key: KEY });
    const select = (await screen.findByLabelText('Model used for Explain')) as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect(select.value).toBe('');
    await user.selectOptions(select, 'llama-3.3-70b-versatile');
    await waitFor(() => expect(backend.state.preferences.model).toBe('llama-3.3-70b-versatile'));
    expect(await screen.findByText('Saved.')).toBeVisible();
  });

  it('can go back to the recommended default', async () => {
    const user = setup({ key: KEY, preferences: { model: 'openai/gpt-oss-20b' } });
    const select = (await screen.findByLabelText('Model used for Explain')) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe('openai/gpt-oss-20b'));
    await user.selectOptions(select, '');
    await waitFor(() => expect(backend.state.preferences.model).toBeUndefined());
  });

  it('when the saved model is gone: warns, asks the user to choose, and never switches by itself', async () => {
    const user = setup({ key: KEY, preferences: { model: 'retired/old-model' } });
    const warning = await screen.findByTestId('model-missing');
    expect(warning).toHaveTextContent('retired/old-model');
    expect(warning).toHaveTextContent(/Clavis won't switch models for you/);
    const select = screen.getByLabelText('Model used for Explain') as HTMLSelectElement;
    expect(select.value).toBe('__choose__');
    expect(screen.getByRole('option', { name: 'Choose a model' })).toBeDisabled();
    // Nothing was written without the user's action.
    expect(backend.calls.some((c) => c.type === 'UPDATE_PREFERENCES')).toBe(false);
    expect(backend.state.preferences.model).toBe('retired/old-model');

    await user.selectOptions(select, 'openai/gpt-oss-20b');
    await waitFor(() => expect(backend.state.preferences.model).toBe('openai/gpt-oss-20b'));
    await waitFor(() => expect(screen.queryByTestId('model-missing')).toBeNull());
  });

  it('with an unverified (offline) key: keeps the saved model and explains the empty list', async () => {
    setup({ key: KEY, groq: 'offline', preferences: { model: 'openai/gpt-oss-20b' } });
    expect(await screen.findByText(/couldn't check your key with Groq/)).toBeVisible();
    const select = screen.getByLabelText('Model used for Explain') as HTMLSelectElement;
    expect(select.value).toBe('openai/gpt-oss-20b');
    expect(screen.queryByTestId('model-missing')).toBeNull();
  });

  it('with no key: explains that the list needs a key', async () => {
    setup({}, false);
    expect(await screen.findByText(/Connect a Groq key to see the models/)).toBeVisible();
    expect(
      (screen.getByLabelText('Model used for Explain') as HTMLSelectElement).options,
    ).toHaveLength(1);
  });
});

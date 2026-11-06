// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../../entrypoints/options/App';
import {
  createFakeBackend,
  installBackend,
  installCatalog,
  installPermissions,
  type FakeBackendOptions,
} from '../ui-client/support';

afterEach(async () => {
  cleanup();
  // JSDOM dispatches link hashchange events on a later task.
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  window.history.replaceState(null, '', '/');
});

function renderSettings(hash = '', options: FakeBackendOptions = {}) {
  window.history.replaceState(null, '', `/${hash}`);
  installCatalog();
  const backend = createFakeBackend(options);
  installBackend(backend);
  installPermissions({ granted: false });
  render(<App />);
  return backend;
}

describe('settings page', () => {
  it('has four navigation groups and shows only Connection by default', async () => {
    renderSettings();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Connection', 'Preferences', 'Website access', 'Privacy & help']);
    expect(within(nav).getByRole('link', { name: 'Connection' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('region', { name: 'Groq API key' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Model' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Voice' })).toBeNull();
    expect(await screen.findByText('No Groq key is connected.')).toBeVisible();
    expect(screen.getByRole('link', { name: /Get a Groq key/ })).toBeVisible();
  });

  it('switches groups while keeping legacy section targets in the document', () => {
    renderSettings();
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Preferences' }));
    expect(within(nav).getByRole('link', { name: 'Preferences' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('region', { name: 'Preferences' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Voice' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Groq API key' })).toBeNull();
    for (const id of [
      'section-key',
      'section-model',
      'section-preferences',
      'section-voice',
      'section-site-access',
      'section-privacy',
      'section-help',
      'section-help-pdf',
    ]) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
  });

  it('opens the right group for a PDF help deep link and responds to hash changes', () => {
    renderSettings('#section-help-pdf');
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    expect(within(nav).getByRole('link', { name: 'Privacy & help' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByTestId('pdf-help')).toBeVisible();
    window.history.replaceState(null, '', '/#section-site-access');
    fireEvent(window, new Event('hashchange'));
    expect(within(nav).getByRole('link', { name: 'Website access' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(screen.getByRole('region', { name: 'Website access' })).toBeVisible();
  });

  it('clears an unfinished key when leaving Connection', async () => {
    renderSettings();
    const key = await screen.findByLabelText('Your Groq key');
    fireEvent.change(key, { target: { value: 'gsk_unsaved_example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Show key' }));
    expect(key).toHaveAttribute('type', 'text');
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Preferences' }));
    expect(key).not.toBeInTheDocument();
    fireEvent.click(within(nav).getByRole('link', { name: 'Connection' }));
    expect(screen.getByLabelText('Your Groq key')).toHaveValue('');
    expect(screen.getByLabelText('Your Groq key')).toHaveAttribute('type', 'password');
  });

  it('floats Test connection feedback without moving the controls or hiding the storage warning', async () => {
    const user = userEvent.setup();
    renderSettings('', {
      key: { value: 'gsk_TESTabcdefghijklmnop9876', storage: 'local' },
      groq: 'valid',
    });
    expect(screen.queryByTestId('settings-toast')).toBeNull();
    const keySection = await screen.findByRole('region', { name: 'Groq API key' });
    expect(within(keySection).getByText(/Clavis does not encrypt your key/)).toBeVisible();
    const button = await screen.findByRole('button', { name: 'Test connection' });
    await user.click(button);
    const toast = await screen.findByTestId('settings-toast');
    expect(toast).toHaveTextContent('Groq accepted your key ending in 9876');
    expect(toast).toHaveClass('clavis-toast--success');
    expect(button).toBeVisible();
    expect(screen.getAllByText(/Groq accepted your key ending in 9876/)).toHaveLength(1);
    expect(within(keySection).getByText(/Clavis does not encrypt your key/)).toBeVisible();
    await user.click(within(toast).getByRole('button', { name: 'Dismiss notification' }));
    await user.click(button);
    expect(await screen.findByTestId('settings-toast')).toHaveTextContent(
      'Groq accepted your key ending in 9876',
    );
  });

  it('floats preference save feedback and leaves the autosave guidance inline', async () => {
    const user = userEvent.setup();
    renderSettings('#section-preferences');
    expect(screen.queryByTestId('settings-toast')).toBeNull();
    expect(screen.getByText('Changes save automatically.')).toBeVisible();
    await user.click(await screen.findByRole('radio', { name: /Advanced/ }));
    expect(await screen.findByTestId('settings-toast')).toHaveTextContent('Saved.');
    expect(screen.getAllByText('Saved.')).toHaveLength(1);
    expect(screen.getByText('Changes save automatically.')).toBeVisible();
  });

  it('floats a failed save as an actionable error without duplicating it inline', async () => {
    const user = userEvent.setup();
    const backend = renderSettings('#section-preferences');
    await screen.findByRole('radio', { name: /Standard/ });
    backend.state.failNext = 'STORAGE_UNAVAILABLE';
    await user.click(screen.getByRole('radio', { name: /Simple/ }));
    const toast = await screen.findByTestId('settings-toast');
    expect(toast).toHaveClass('clavis-toast--danger');
    expect(within(toast).getByRole('alert')).toHaveTextContent(/protected extension storage/);
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getByRole('radio', { name: /Standard/ })).toBeChecked();
  });
});

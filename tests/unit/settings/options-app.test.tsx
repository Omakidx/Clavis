// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../../entrypoints/options/App';
import {
  createFakeBackend,
  installBackend,
  installCatalog,
  installPermissions,
} from '../ui-client/support';

afterEach(() => cleanup());

describe('settings page', () => {
  it('has one h1, a section for every concern, and jump links to each', async () => {
    installCatalog();
    installBackend(createFakeBackend());
    installPermissions({ granted: false });
    render(<App />);
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    const links = within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent);
    expect(links).toEqual([
      'Groq API key',
      'Model',
      'Preferences',
      'Voice',
      'Website access',
      'Privacy and data',
      'Help and practice',
    ]);
    for (const link of within(nav).getAllByRole('link')) {
      const id = link.getAttribute('href')?.slice(1) ?? '';
      expect(document.getElementById(id), id).not.toBeNull();
    }
    for (const name of [
      'Groq API key',
      'Model',
      'Preferences',
      'Voice',
      'Website access',
      'Privacy and data',
      'Help and practice',
    ]) {
      expect(screen.getByRole('region', { name })).toBeVisible();
    }
    expect(await screen.findByText('No Groq key is connected.')).toBeVisible();
  });
});

// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HelpSection } from '../../../components/settings/HelpSection';
import { PrivacySection } from '../../../components/settings/PrivacySection';
import catalog from '../../../public/_locales/en/messages.json';
import {
  createFakeBackend,
  installBackend,
  installCatalog,
  type FakeBackend,
} from '../ui-client/support';

let backend: FakeBackend;
const onCleared = vi.fn();

function setup() {
  installCatalog();
  backend = createFakeBackend({
    key: { value: 'gsk_TESTprivacysection01', storage: 'local' },
    preferences: { readingLevel: 'simple' },
    onboarding: { completed: true, disclosureAcceptedAt: 10 },
  });
  installBackend(backend);
  onCleared.mockReset();
  render(<PrivacySection onCleared={onCleared} />);
  return userEvent.setup();
}

afterEach(() => cleanup());

describe('privacy section (FR-071, FR-078)', () => {
  it('repeats the approved disclosure and says storage is not encrypted', () => {
    setup();
    for (const key of [
      'disclosureSelect',
      'disclosureListen',
      'disclosureExplain',
      'disclosurePdf',
      'disclosureNoServer',
    ] as const) {
      expect(screen.getByText((content) => content.includes(catalog[key].message))).toBeVisible();
    }
    expect(screen.getByText(/does not encrypt your key/)).toBeVisible();
    expect(screen.getByText(/does not use your operating system's password vault/)).toBeVisible();
    expect(screen.getByRole('link', { name: /Clavis privacy policy/ })).toHaveAttribute(
      'target',
      '_blank',
    );
  });

  it('Clear all data needs confirmation; cancelling sends nothing', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Clear all data' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Clear all Clavis data?' });
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(backend.calls.some((c) => c.type === 'CLEAR_ALL_DATA')).toBe(false);
    expect(backend.state.key).not.toBeNull();
  });

  it('confirming clears everything and tells the page to reload what it shows', async () => {
    const user = setup();
    await user.click(screen.getByRole('button', { name: 'Clear all data' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear all data' }),
    );
    await waitFor(() => expect(backend.state.key).toBeNull());
    expect(backend.state.preferences.readingLevel).toBe('standard');
    expect(backend.state.onboarding.completed).toBe(false);
    expect(await screen.findByText('All Clavis data was removed from this browser.')).toBeVisible();
    expect(onCleared).toHaveBeenCalledTimes(1);
  });

  it('shows a failed clear as an actionable error', async () => {
    const user = setup();
    backend.state.failNext = 'STORAGE_UNAVAILABLE';
    await user.click(screen.getByRole('button', { name: 'Clear all data' }));
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Clear all data' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/protected extension storage/);
    expect(onCleared).not.toHaveBeenCalled();
  });
});

describe('help section (FR-008)', () => {
  it('links to the tutorial, the practice page and the PDF reader', () => {
    installCatalog();
    render(<HelpSection />);
    expect(screen.getByRole('link', { name: 'Run the welcome tutorial again' })).toHaveAttribute(
      'href',
      '/onboarding.html',
    );
    expect(screen.getByRole('link', { name: /Open the practice page/ })).toHaveAttribute(
      'href',
      '/practice.html',
    );
    expect(screen.getByRole('link', { name: /Open the PDF reader/ })).toHaveAttribute(
      'href',
      '/reader.html',
    );
    expect(screen.getByText(/Alt\+Shift\+E/)).toBeVisible();
  });
});

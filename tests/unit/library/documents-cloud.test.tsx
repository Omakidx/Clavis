// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installCatalog } from '../ui-client/support';

vi.mock('../../../lib/config/constants', async (original) => {
  const real = await original<typeof import('../../../lib/config/constants')>();
  return { ...real, FEATURES: { ...real.FEATURES, accountSync: true } };
});

import { Documents } from '../../../components/library/Documents';
import { saveProgress, setStorageState } from '../../../lib/data/documents';

const out = { signedIn: () => Promise.resolve(false) };
const STORED = 'a'.repeat(64);
const LOCAL = 'b'.repeat(64);

let signedIn = true;
let usage: { storageUsedBytes: number; storageQuotaBytes: number } | null = {
  storageUsedBytes: 12 * 1024 * 1024,
  storageQuotaBytes: 50 * 1024 * 1024,
};
const sent: { type: string; [key: string]: unknown }[] = [];

beforeEach(async () => {
  installCatalog();
  sent.length = 0;
  signedIn = true;
  usage = { storageUsedBytes: 12 * 1024 * 1024, storageQuotaBytes: 50 * 1024 * 1024 };
  vi.spyOn(browser.runtime, 'sendMessage').mockImplementation(((message: {
    type: string;
    [key: string]: unknown;
  }) => {
    sent.push(message);
    if (message.type === 'ACCOUNT_GET_STATUS') {
      return Promise.resolve({
        ok: true,
        data: {
          enabled: true,
          signedIn,
          ...(signedIn ? { usage } : {}),
          sync: { state: 'idle', pending: 0, rejected: 0 },
        },
      });
    }
    if (message.type === 'DOCUMENT_REMOVE_FILE') return Promise.resolve({ ok: true, data: {} });
    return Promise.resolve(undefined);
  }) as never);
  vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
  await saveProgress(
    STORED,
    {
      title: 'Stored paper',
      pageCount: 10,
      fileBytes: 5 * 1024 * 1024,
      lastPage: 4,
      pageOffset: 0,
    },
    { ...out, now: () => 1_700_000_100_000 },
  );
  await saveProgress(
    LOCAL,
    { title: 'Local paper', pageCount: 3, fileBytes: 1024, lastPage: 1, pageOffset: 0 },
    { ...out, now: () => 1_700_000_000_000 },
  );
  await setStorageState(STORED, 'stored');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Documents tab with an account', () => {
  it('shows the cloud state, the quota bar, and opens a stored file in the reader with ?doc=', async () => {
    const user = userEvent.setup();
    render(<Documents />);
    const docs = await screen.findAllByTestId('library-doc');
    expect(docs).toHaveLength(2);
    const states = await screen.findAllByTestId('library-doc-cloud');
    expect(states.map((el) => el.getAttribute('data-state'))).toEqual(['stored', 'none']);
    expect(screen.getByTestId('library-quota')).toHaveTextContent('12 MB of 50 MB used');
    await user.click(screen.getAllByTestId('library-doc-open')[0]!);
    expect(browser.tabs.create).toHaveBeenCalledWith({
      url: expect.stringMatching(new RegExp(`/reader\\.html\\?doc=${STORED}$`)),
    });
    await user.click(screen.getAllByTestId('library-doc-open')[1]!);
    expect(browser.tabs.create).toHaveBeenLastCalledWith({
      url: expect.stringMatching(/\/reader\.html$/),
    });
  });

  it('removes only the stored file after confirmation, through the background route', async () => {
    const user = userEvent.setup();
    render(<Documents />);
    await user.click(await screen.findByTestId('library-doc-remove-file'));
    expect(sent.some((m) => m.type === 'DOCUMENT_REMOVE_FILE')).toBe(false);
    await new Promise((r) => setTimeout(r, 600)); // the confirm button ignores clicks right after it appears
    await user.click(await screen.findByTestId('library-dialog-confirm'));
    await vi.waitFor(() =>
      expect(sent.filter((m) => m.type === 'DOCUMENT_REMOVE_FILE')).toEqual([
        { v: 1, type: 'DOCUMENT_REMOVE_FILE', fingerprint: STORED },
      ]),
    );
    expect(screen.getAllByTestId('library-doc')).toHaveLength(2); // progress and highlights stay
  });

  it('uses the server usage, not the local file sizes, and hides the bar when it is unknown', async () => {
    usage = null;
    render(<Documents />);
    await screen.findAllByTestId('library-doc');
    await screen.findAllByTestId('library-doc-cloud');
    expect(screen.queryByTestId('library-quota')).toBeNull();
  });

  it('signed out: no cloud state, no quota bar, no remove button', async () => {
    signedIn = false;
    render(<Documents />);
    await screen.findAllByTestId('library-doc');
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByTestId('library-doc-cloud')).toBeNull();
    expect(screen.queryByTestId('library-quota')).toBeNull();
    expect(screen.queryByTestId('library-doc-remove-file')).toBeNull();
  });
});

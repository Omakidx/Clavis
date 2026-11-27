// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { browser } from 'wxt/browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEYS } from '../../../lib/storage/keys';
import { installCatalog } from '../ui-client/support';

// The reader's account features (design 6.6, 7.7) with the flag on, as in a sync build.
vi.mock('../../../lib/config/constants', async (original) => {
  const real = await original<typeof import('../../../lib/config/constants')>();
  return { ...real, FEATURES: { ...real.FEATURES, accountSync: true } };
});

import { ContinueReading } from '../../../components/reader/ReaderData';
import { CloudSave, openFromAccount } from '../../../components/reader/ReaderCloud';
import { readDocParam } from '../../../components/reader/Reader';
import { notifyAccountStatusChanged } from '../../../lib/data/channel';
import { saveProgress } from '../../../lib/data/documents';
import { putHandoff, takeHandoff } from '../../../lib/data/handoff';
import { setStorageState } from '../../../lib/data/documents';
import type { PdfReaderController } from '../../../lib/pdf/controller';

const FP = 'c'.repeat(64);

const signIn = () =>
  browser.storage.local.set({ [STORAGE_KEYS.syncState]: { accountId: 'a', cursor: '0' } });
const signOut = () => browser.storage.local.remove(STORAGE_KEYS.syncState);

beforeEach(() => {
  installCatalog();
});
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await signOut();
});

describe('?doc= validation', () => {
  it('accepts only 64 lowercase hex characters', () => {
    expect(readDocParam(`?doc=${FP}`)).toEqual({ kind: 'ok', fingerprint: FP });
    expect(readDocParam('')).toEqual({ kind: 'none' });
    for (const bad of [
      'x',
      FP.toUpperCase(),
      FP.slice(1),
      `${FP}0`,
      `${FP}%2F..`,
      '../reader.html',
      '',
    ]) {
      expect(readDocParam(`?doc=${bad}`)).toEqual({ kind: 'invalid' });
    }
  });
});

describe('openFromAccount', () => {
  it('signed out: no message is sent at all', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage');
    const result = await openFromAccount(FP);
    expect(result).toMatchObject({ ok: false, kind: 'signin' });
    expect(send).not.toHaveBeenCalled();
  });

  it('fetches, reads the handoff once and hands back a PDF file', async () => {
    await signIn();
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async (message: {
      type: string;
      fingerprint: string;
    }) => {
      expect(message).toMatchObject({ v: 1, type: 'DOCUMENT_FETCH', fingerprint: FP });
      await putHandoff(FP, new Blob(['%PDF-1.7']), 'download');
      return { ok: true, data: {} };
    }) as never);
    const result = await openFromAccount(FP);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.type).toBe('application/pdf');
      expect(result.file.name).toMatch(/\.pdf$/);
    }
    expect(await takeHandoff(FP, 'download')).toBeNull(); // deleted when read
  });

  it('a failed fetch (no reply) after the background wrote the file leaves the store empty', async () => {
    await signIn();
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async () => {
      await putHandoff(FP, new Blob(['%PDF-1.7']), 'download');
      return undefined; // the reply was lost
    }) as never);
    expect(await openFromAccount(FP)).toMatchObject({ ok: false, kind: 'error' });
    expect(await takeHandoff(FP, 'download')).toBeNull();
  });

  it('maps a server error to the friendly text and a missing handoff to an error', async () => {
    await signIn();
    const send = vi.spyOn(browser.runtime, 'sendMessage');
    send.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'raw server text' },
    } as never);
    const notFound = await openFromAccount(FP);
    expect(notFound).toMatchObject({ ok: false, kind: 'error' });
    expect(JSON.stringify(notFound)).not.toContain('raw server text');
    send.mockResolvedValue({ ok: true, data: {} } as never); // says ok but left no file
    expect(await openFromAccount(FP)).toMatchObject({ ok: false, kind: 'error' });
  });
});

describe('<CloudSave>', () => {
  const controller = { documentId: FP } as unknown as PdfReaderController;
  const file = (bytes: number) => new File([new Uint8Array(bytes)], 'Paper.pdf');

  it('renders nothing while signed out', async () => {
    const { container } = render(
      <CloudSave controller={controller} file={file(10)} fileName="Paper.pdf" showing />,
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  it('offers Save to account, uploads through the handoff and then says Stored', async () => {
    await signIn();
    await saveProgress(FP, {
      title: 'Paper',
      pageCount: 1,
      fileBytes: 10,
      lastPage: 1,
      pageOffset: 0,
    });
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async (message: {
      type: string;
      fingerprint: string;
      title: string;
    }) => {
      expect(message).toMatchObject({ type: 'DOCUMENT_UPLOAD', fingerprint: FP, title: 'Paper' });
      // The bytes are in the handoff store, not in the message.
      expect(JSON.stringify(message)).not.toContain('blob');
      expect(await takeHandoff(FP, 'upload')).not.toBeNull();
      return { ok: true, data: { storage: { state: 'stored', bytes: 10 } } };
    }) as never);
    const user = userEvent.setup();
    render(<CloudSave controller={controller} file={file(10)} fileName="Paper.pdf" showing />);
    await user.click(await screen.findByTestId('cloud-save'));
    await screen.findByTestId('cloud-stored');
    expect(send).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('cloud-status')).toHaveTextContent('Saved to your account.');
  });

  it('shows the friendly error for a quota failure and clears the handoff', async () => {
    await signIn();
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
      ok: false,
      error: { code: 'QUOTA_EXCEEDED', message: 'x' },
    } as never);
    const user = userEvent.setup();
    render(<CloudSave controller={controller} file={file(10)} fileName="Paper.pdf" showing />);
    await user.click(await screen.findByTestId('cloud-save'));
    expect(await screen.findByTestId('cloud-error')).toHaveTextContent('out of storage');
    expect(await takeHandoff(FP, 'upload')).toBeNull();
    expect(screen.queryByTestId('cloud-stored')).toBeNull();
  });

  it('offers nothing for a file over 15 MiB, an empty one, or nothing open', async () => {
    await signIn();
    for (const props of [
      { file: file(15 * 1024 * 1024 + 1), showing: true },
      { file: file(0), showing: true },
      { file: file(10), showing: false },
    ]) {
      const { container, unmount } = render(
        <CloudSave controller={controller} fileName="Paper.pdf" {...props} />,
      );
      await new Promise((r) => setTimeout(r, 20));
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
  });

  it('shows Stored in account when the account already holds the file', async () => {
    await signIn();
    await saveProgress(FP, {
      title: 'Paper',
      pageCount: 1,
      fileBytes: 10,
      lastPage: 1,
      pageOffset: 0,
    });
    await setStorageState(FP, 'stored');
    render(<CloudSave controller={controller} file={file(10)} fileName="Paper.pdf" showing />);
    await screen.findByTestId('cloud-stored');
    expect(screen.queryByTestId('cloud-save')).toBeNull();
  });
});

describe('Continue reading with an account', () => {
  const FP2 = 'd'.repeat(64);

  it('a stored document is a link to ?doc=, the others keep the picker button', async () => {
    await signIn();
    await saveProgress('e'.repeat(64), {
      title: 'Local',
      pageCount: 4,
      fileBytes: 1,
      lastPage: 2,
      pageOffset: 0,
    });
    await saveProgress(FP2, {
      title: 'Cloud',
      pageCount: 10,
      fileBytes: 1,
      lastPage: 5,
      pageOffset: 0,
    });
    await setStorageState(FP2, 'stored');
    render(<ContinueReading onOpen={() => undefined} />);
    const link = await screen.findByTestId('reader-continue-cloud');
    expect(link).toHaveAttribute('href', `?doc=${FP2}`);
    expect(screen.getByRole('button', { name: 'Open Local again' })).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('progressbar', { name: /Cloud/ })).toHaveAttribute('value', '5'),
    );
  });

  it('signed out, a stored document still asks for the file (no account link)', async () => {
    await saveProgress(FP2, {
      title: 'Cloud',
      pageCount: 10,
      fileBytes: 1,
      lastPage: 5,
      pageOffset: 0,
    });
    await setStorageState(FP2, 'stored');
    render(<ContinueReading onOpen={() => undefined} />);
    await screen.findByTestId('reader-continue');
    expect(screen.queryByTestId('reader-continue-cloud')).toBeNull();
  });

  it('notices a sign-in or sign-out while the list is open', async () => {
    await saveProgress(FP2, {
      title: 'Cloud',
      pageCount: 10,
      fileBytes: 1,
      lastPage: 5,
      pageOffset: 0,
    });
    await setStorageState(FP2, 'stored');
    render(<ContinueReading onOpen={() => undefined} />);
    await screen.findByTestId('reader-continue');
    expect(screen.queryByTestId('reader-continue-cloud')).toBeNull();
    await signIn();
    notifyAccountStatusChanged();
    expect(await screen.findByTestId('reader-continue-cloud')).toBeVisible();
    await signOut();
    notifyAccountStatusChanged();
    await waitFor(() => expect(screen.queryByTestId('reader-continue-cloud')).toBeNull());
  });
});

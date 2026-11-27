// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { STORAGE_KEYS } from '../../../lib/storage/keys';

vi.mock('../../../lib/config/constants', async (original) => {
  const real = await original<typeof import('../../../lib/config/constants')>();
  return { ...real, FEATURES: { ...real.FEATURES, accountSync: true } };
});

import { Reader } from '../../../components/reader/Reader';
import { putHandoff, takeHandoff } from '../../../lib/data/handoff';

const FP = 'f'.repeat(64);

beforeEach(async () => {
  window.history.pushState({}, '', `/reader.html?doc=${FP}`);
  await browser.storage.local.set({ [STORAGE_KEYS.syncState]: { accountId: 'a', cursor: '0' } });
  vi.spyOn(browser.i18n, 'getMessage').mockImplementation(((key: string) => key) as never);
});
afterEach(async () => {
  window.history.pushState({}, '', '/reader.html');
  await browser.storage.local.remove(STORAGE_KEYS.syncState);
});

describe('?doc= download that finishes after the user opened a file', () => {
  it('keeps the local file open, drops the late download and shows no mismatch error', async () => {
    // The background answers DOCUMENT_FETCH only when the test says so.
    let finish: () => void = () => undefined;
    const fetched = new Promise<void>((resolve) => (finish = resolve));
    let asked = false;
    vi.spyOn(browser.runtime, 'sendMessage').mockImplementation((async (message: {
      type: string;
    }) => {
      if (message.type !== 'DOCUMENT_FETCH') return undefined;
      asked = true;
      await fetched;
      await putHandoff(FP, new Blob(['late bytes']), 'download');
      return { ok: true, data: {} };
    }) as never);

    const user = userEvent.setup();
    render(<Reader />);
    await vi.waitFor(() => expect(asked).toBe(true), { timeout: 5000 });
    expect(screen.getByTestId('state-cloud')).toHaveTextContent('readerCloudFetching');

    await user.upload(
      screen.getByTestId('file-input'),
      new File(['plain text'], 'mine.pdf', { type: 'application/pdf' }),
    );
    await screen.findByTestId('state-error'); // the local file was opened (and is not a PDF)
    expect(screen.getByTestId('file-name')).toHaveTextContent('mine.pdf');

    await act(async () => {
      finish();
      await new Promise((r) => setTimeout(r, 100));
    });
    expect(screen.getByTestId('file-name')).toHaveTextContent('mine.pdf');
    expect(screen.queryByTestId('state-cloud')).toBeNull();
    expect(document.body).not.toHaveTextContent('errFingerprintMismatch');
    expect(await takeHandoff(FP, 'download')).toBeNull(); // consumed, not left behind
  });
});

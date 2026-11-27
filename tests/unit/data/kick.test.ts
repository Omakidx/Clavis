import { describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { kickSync } from '../../../lib/data/kick';
import { describeError } from '../../../lib/ui-client/errors';
import { STORAGE_KEYS } from '../../../lib/storage/keys';

describe('kickSync', () => {
  it('sends nothing while signed out (there is nothing to sync)', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    await kickSync();
    expect(send).not.toHaveBeenCalled();
  });

  it('sends SYNC_KICK while signed in, with pull only when asked', async () => {
    await browser.storage.local.set({ [STORAGE_KEYS.syncState]: { accountId: 'a', cursor: '0' } });
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(undefined as never);
    await kickSync();
    await kickSync(true);
    expect(send).toHaveBeenNthCalledWith(1, { v: 1, type: 'SYNC_KICK' });
    expect(send).toHaveBeenNthCalledWith(2, { v: 1, type: 'SYNC_KICK', pull: true });
  });

  it('never throws when the worker cannot be reached', async () => {
    await browser.storage.local.set({ [STORAGE_KEYS.syncState]: { accountId: 'a' } });
    vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('no receiver'));
    await expect(kickSync()).resolves.toBeUndefined();
  });
});

describe('describeError for the local data codes', () => {
  it('words NOT_FOUND and LIMIT_EXCEEDED with our own text and carries the reason when there is one', () => {
    vi.spyOn(browser.i18n, 'getMessage').mockImplementation(
      ((key: string) => `msg:${key}`) as never,
    );
    expect(describeError('NOT_FOUND')).toMatchObject({
      message: 'msg:errNotFound',
      action: 'none',
    });
    expect(describeError('LIMIT_EXCEEDED')).toMatchObject({
      message: 'msg:errLimitExceeded',
      action: 'none',
    });
    expect(describeError('SETUP_REQUIRED', undefined, 'disclosure')).toMatchObject({
      reason: 'disclosure',
    });
    expect(describeError('SETUP_REQUIRED')).not.toHaveProperty('reason');
  });
});

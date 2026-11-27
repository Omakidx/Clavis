import { describe, expect, it, vi } from 'vitest';
import { GroqError } from '../../../lib/ai/errors';
import { putWord } from '../../../lib/data/words';
import { wordKey } from '../../../shared/api-contract/words';
import { sampleWord } from '../data/fixtures';
import { REQ_A, REQ_B, createHarness, makeReady, pageSender } from './harness';

const meaning = { title: 'bank', summary: 'A place.', model: 'm' };
const save = {
  v: 1,
  type: 'SAVE_WORD',
  snapshot: { selectionId: REQ_B, source: 'webpage', kind: 'word', text: 'bank' },
  meaning,
};

describe('the background wakes the sync engine after local writes', () => {
  it('after SAVE_WORD and UNSAVE_WORD (but not after an unsave that removed nothing)', async () => {
    const onLocalChange = vi.fn();
    const h = createHarness({ onLocalChange });
    const sender = pageSender('/practice.html');
    const saved = (await h.call(save, sender)) as { data: { wordKey: string } };
    expect(onLocalChange).toHaveBeenCalledTimes(1);
    await h.call({ v: 1, type: 'UNSAVE_WORD', wordKey: saved.data.wordKey }, sender);
    expect(onLocalChange).toHaveBeenCalledTimes(2);
    await h.call({ v: 1, type: 'UNSAVE_WORD', wordKey: saved.data.wordKey }, sender);
    expect(onLocalChange).toHaveBeenCalledTimes(2);
  });

  it('after a chat pair is written (and not when the answer fails)', async () => {
    const onLocalChange = vi.fn();
    const h = createHarness({ onLocalChange });
    const key = await wordKey('bank');
    await putWord(key, sampleWord(), { signedIn: () => Promise.resolve(false) });
    await makeReady(h);
    const send = { v: 1, type: 'WORD_CHAT_SEND', requestId: REQ_A, wordKey: key, message: 'Why?' };
    h.chatProvider.chat.mockRejectedValueOnce(new GroqError('NETWORK_ERROR'));
    await h.call(send, pageSender('/library.html', 8));
    expect(onLocalChange).not.toHaveBeenCalled();
    await h.call({ ...send, requestId: REQ_B }, pageSender('/library.html', 8));
    expect(onLocalChange).toHaveBeenCalledTimes(1);
  });
});

describe('CLEAR_ALL_DATA signs out first (R5)', () => {
  it('runs the sign-out before the storage is cleared, and still clears when it fails', async () => {
    const order: string[] = [];
    const h = createHarness({
      signOutFirst: () => {
        order.push('sign-out');
        return Promise.reject(new Error('offline'));
      },
    });
    await h.local.set({ 'clavis.preferences': { v: 1, data: {} } });
    h.local.remove.mockImplementation((keys: string | string[]) => {
      order.push('clear');
      for (const name of Array.isArray(keys) ? keys : [keys]) h.local.data.delete(name);
      return Promise.resolve();
    });
    const reply = await h.call({ v: 1, type: 'CLEAR_ALL_DATA' }, pageSender('/options.html'));
    expect(reply).toMatchObject({ ok: true });
    expect(order[0]).toBe('sign-out');
    expect(order).toContain('clear');
  });
});

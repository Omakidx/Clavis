import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import {
  NOTHING,
  createPanelClient,
  isFromBackground,
  tabFromSearch,
} from '../../../components/sidepanel/client';
import { allText, sectionText } from '../../../components/sidepanel/text';
import { installCatalog } from '../ui-client/support';
import { makeHandoff } from './support';

const ID = 'abcdefghijklmnopabcdefghijklmnop';

beforeEach(() => {
  installCatalog();
  Object.assign(browser.runtime, {
    id: ID,
    getURL: (path: string) => `chrome-extension://${ID}${path}`,
  });
});
afterEach(() => vi.useRealTimers());

describe('tabFromSearch', () => {
  it('reads the tab the service worker put in the panel path, and nothing else', () => {
    expect(tabFromSearch('?tab=12')).toBe(12);
    for (const search of [
      '',
      '?tab=',
      '?tab=-1',
      '?tab=1e3',
      '?tab=1.5',
      '?tab=abc',
      '?tab=99999999999',
      '?other=1',
    ]) {
      expect(tabFromSearch(search), search).toBeUndefined();
    }
  });
});

describe('isFromBackground', () => {
  it('accepts only the service worker itself: our id, no tab, its own script url', () => {
    const worker = { id: ID, url: `chrome-extension://${ID}/background.js` };
    expect(isFromBackground(worker)).toBe(true);
    expect(isFromBackground({ ...worker, tab: { id: 1 } })).toBe(false);
    expect(isFromBackground({ ...worker, id: 'someone-else' })).toBe(false);
    expect(isFromBackground({ ...worker, url: 'https://example.com/' })).toBe(false);
    expect(isFromBackground({ id: ID, url: `chrome-extension://${ID}/reader.html` })).toBe(false);
    expect(isFromBackground(undefined)).toBe(false);
  });
});

describe('fetchState', () => {
  const reply = (handoff: unknown, revision = 1) => ({ ok: true, data: { revision, handoff } });

  it('asks for exactly its own tab and returns a valid reply', async () => {
    const handoff = makeHandoff();
    const send = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockResolvedValue(reply(handoff) as never);
    const state = await createPanelClient().fetchState(7);
    expect(send).toHaveBeenCalledWith({ v: 1, type: 'GET_SIDE_PANEL_STATE', tabId: 7 });
    expect(state.handoff?.snapshot.text).toBe('bank');
  });

  it('treats a null hand-off as nothing', async () => {
    vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(reply(null, 4) as never);
    expect(await createPanelClient().fetchState(7)).toEqual({ revision: 4, handoff: null });
  });

  it('refuses a reply that is not the contract (extra fields, bad snapshot, an error envelope)', async () => {
    const bad = [
      { ok: true, data: { revision: 1, handoff: { ...makeHandoff(), apiKey: 'x' } } },
      { ok: true, data: { revision: 1, handoff: { ...makeHandoff(), results: [] } } },
      { ok: false, error: { code: 'INVALID_REQUEST', message: 'no' } },
      'nope',
      null,
    ];
    for (const value of bad) {
      vi.useFakeTimers();
      vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue(value as never);
      const pending = createPanelClient().fetchState(7);
      await vi.advanceTimersByTimeAsync(500);
      expect(await pending, JSON.stringify(value)?.slice(0, 40)).toEqual(NOTHING);
      vi.useRealTimers();
    }
  });

  it('asks once more when a sleeping worker did not answer the first time', async () => {
    vi.useFakeTimers();
    const send = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockRejectedValueOnce(new Error('Could not establish connection.'))
      .mockResolvedValue(reply(makeHandoff()) as never);
    const pending = createPanelClient().fetchState(7);
    await vi.advanceTimersByTimeAsync(500);
    expect((await pending).handoff).not.toBeNull();
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('onUpdated', () => {
  const update = { v: 1, type: 'SIDE_PANEL_UPDATED', tabId: 7, revision: 2 };
  const fromWorker = { id: ID, url: `chrome-extension://${ID}/background.js` };

  function listenerOf() {
    const add = vi.spyOn(browser.runtime.onMessage, 'addListener');
    const remove = vi.spyOn(browser.runtime.onMessage, 'removeListener');
    const changed = vi.fn();
    const off = createPanelClient().onUpdated(7, changed);
    const handler = add.mock.calls[0]?.[0] as (message: unknown, sender: unknown) => undefined;
    return { handler, changed, off, remove };
  }

  it('notifies for its own tab when the service worker says so', () => {
    const { handler, changed } = listenerOf();
    handler(update, fromWorker);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('ignores another tab, a malformed message and anyone but the worker', () => {
    const { handler, changed } = listenerOf();
    handler({ ...update, tabId: 8 }, fromWorker);
    handler({ ...update, text: 'x' }, fromWorker);
    handler({ ...update, type: 'OTHER' }, fromWorker);
    handler(update, { ...fromWorker, tab: { id: 1 } });
    handler(update, { id: 'other', url: fromWorker.url });
    expect(changed).not.toHaveBeenCalled();
  });

  it('unsubscribes', () => {
    const { off, remove, handler } = listenerOf();
    off();
    expect(remove).toHaveBeenCalledWith(handler);
  });
});

describe('plain text for the clipboard', () => {
  it('names the section and lists exactly what it shows, nothing for an unloaded one', () => {
    const handoff = makeHandoff({ kind: 'word', modes: ['core'] });
    const result = { ...handoff.results[0]!, selectedText: 'bank' };
    const entry = {
      mode: 'core' as const,
      status: 'ready' as const,
      requestId: result.requestId,
      result,
      error: null,
      acknowledge: false,
    };
    expect(sectionText('core', entry)).toMatch(/^Core\nbank \(noun\)\n\n/);
    expect(sectionText('etymology', undefined)).toBeNull();
    expect(sectionText('core', { ...entry, status: 'loading' as const })).toBeNull();
    expect(allText('bank', ['core', 'etymology'], { core: entry })).toMatch(/^bank\n\nCore\n/);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { registerBackground } from '../../../lib/router/register';
import { resetStorageLockdownForTests } from '../../../lib/security/storage-lockdown';

type Listener = (...args: unknown[]) => unknown;
function event() {
  const listeners: Listener[] = [];
  return { addListener: vi.fn((l: Listener) => void listeners.push(l)), listeners };
}

const ID = 'abcdefghijklmnopabcdefghijklmnop';

function installBrowser() {
  const events = {
    onMessage: event(),
    onStartup: event(),
    onInstalled: event(),
    onAdded: event(),
    onRemoved: event(),
    onClicked: event(),
    onCommand: event(),
    onTabRemoved: event(),
    onTabUpdated: event(),
  };
  const scripting = {
    getRegisteredContentScripts: vi.fn(() => Promise.resolve([])),
    registerContentScripts: vi.fn(() => Promise.resolve()),
    updateContentScripts: vi.fn(() => Promise.resolve()),
    unregisterContentScripts: vi.fn(() => Promise.resolve()),
    executeScript: vi.fn(() => Promise.resolve([])),
  };
  Object.assign(browser, {
    permissions: {
      contains: vi.fn(() => Promise.resolve(false)),
      onAdded: events.onAdded,
      onRemoved: events.onRemoved,
    },
    scripting,
    tabs: {
      sendMessage: vi.fn(),
      query: vi.fn(() => Promise.resolve([])),
      onRemoved: events.onTabRemoved,
      onUpdated: events.onTabUpdated,
    },
    sidePanel: { setOptions: vi.fn(() => Promise.resolve()), open: vi.fn(() => Promise.resolve()) },
    contextMenus: { create: vi.fn(), removeAll: vi.fn(), onClicked: events.onClicked },
    commands: { onCommand: events.onCommand },
  });
  Object.assign(browser.runtime, {
    id: ID,
    getURL: (path: string) => `chrome-extension://${ID}${path}`,
    onStartup: events.onStartup,
    onInstalled: events.onInstalled,
    onMessage: events.onMessage,
  });
  return events;
}

beforeEach(() => {
  resetStorageLockdownForTests();
});

describe('registerBackground', () => {
  it('registers exactly ONE runtime.onMessage listener, plus the other listeners, synchronously', () => {
    const events = installBrowser();
    registerBackground();
    expect(events.onMessage.addListener).toHaveBeenCalledTimes(1);
    for (const name of [
      'onStartup',
      'onInstalled',
      'onAdded',
      'onRemoved',
      'onClicked',
      'onCommand',
      'onTabRemoved',
      'onTabUpdated',
    ] as const) {
      expect(events[name].addListener, name).toHaveBeenCalledTimes(1);
    }
  });

  it('the registered listener fails closed on the key routes before the lockdown ran, and rejects web pages', async () => {
    const events = installBrowser();
    registerBackground();
    const listener = events.onMessage.listeners[0]!;

    // No lockdown was started in this test: whenStorageLockedDown() resolves false.
    const fromOptions = await new Promise((resolve) =>
      listener(
        { v: 1, type: 'GET_KEY_STATUS' },
        {
          id: ID,
          url: `chrome-extension://${ID}/options.html`,
          frameId: 0,
          tab: { id: 1, url: `chrome-extension://${ID}/options.html` },
        },
        resolve,
      ),
    );
    expect(fromOptions).toMatchObject({ ok: false, error: { code: 'STORAGE_UNAVAILABLE' } });

    const fromWeb = await new Promise((resolve) =>
      listener(
        { v: 1, type: 'GET_KEY_STATUS' },
        {
          id: ID,
          url: 'https://example.com/',
          frameId: 0,
          tab: { id: 2, url: 'https://example.com/' },
        },
        resolve,
      ),
    );
    expect(fromWeb).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('abandons the work of a closed tab', () => {
    const events = installBrowser();
    registerBackground();
    expect(() => events.onTabRemoved.listeners[0]!(5)).not.toThrow();
  });

  it("drops a tab's side panel hand-off only when the tab starts loading another page", () => {
    const events = installBrowser();
    registerBackground();
    const updated = events.onTabUpdated.listeners[0]!;
    // Title, favicon, audible and the like change all the time and say nothing about navigation.
    expect(() => updated(5, { title: 'x' })).not.toThrow();
    expect(() => updated(5, { status: 'loading' })).not.toThrow();
    expect(() => updated(5, { status: 'complete' })).not.toThrow();
  });

  it('also drops the hand-off when the url changes without a load (single-page navigation)', async () => {
    const events = installBrowser();
    registerBackground();
    const listener = events.onMessage.listeners[0]!;
    const send = (message: unknown, tabId: number) =>
      new Promise<unknown>((resolve) =>
        listener(
          message,
          {
            id: ID,
            url: 'https://example.com/a',
            frameId: 0,
            tab: { id: tabId, url: 'https://example.com/a' },
          },
          resolve,
        ),
      );
    const handoff = {
      snapshot: {
        selectionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        source: 'webpage',
        kind: 'word',
        text: 'bank',
      },
      results: [
        {
          requestId: '9b2f5c1e-7d1a-4c8e-8b57-2f6a1e4d9c10',
          mode: 'core',
          title: 'bank',
          summary: 'x',
          provider: 'groq',
          model: 'm',
        },
      ],
    };
    const panel = (tab: number) => ({
      id: ID,
      url: `chrome-extension://${ID}/sidepanel.html?tab=${tab}`,
    });
    const ask = (tab: number) =>
      new Promise<{ data: { handoff: unknown } }>((resolve) =>
        listener({ v: 1, type: 'GET_SIDE_PANEL_STATE', tabId: tab }, panel(tab), resolve as never),
      );
    const updated = events.onTabUpdated.listeners[0]!;
    for (const change of [{ url: 'https://example.com/b' }, { status: 'loading' }]) {
      await send({ v: 1, type: 'OPEN_SIDE_PANEL', handoff }, 9);
      expect((await ask(9)).data.handoff).not.toBeNull();
      updated(9, { title: 'unrelated' });
      expect((await ask(9)).data.handoff).not.toBeNull();
      updated(9, change);
      expect((await ask(9)).data.handoff).toBeNull();
      // Reopening needs the throttle interval to pass.
      await new Promise((r) => setTimeout(r, 320));
    }
  });
});

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
    },
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
});

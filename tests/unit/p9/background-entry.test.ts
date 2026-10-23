import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import background from '../../../entrypoints/background';
import { resetStorageLockdownForTests } from '../../../lib/security/storage-lockdown';

// Phase 9, FR-001 ("Open welcome page once per fresh install; later visits via Settings"; the
// acceptance test: "reload/update does not reset completion") and secret boundary rule 1 (storage
// is restricted to trusted contexts before ANY listener exists). `--load-extension` makes every
// browser launch look like an install, so this entry-point logic cannot be driven in a real
// browser (p8-accept-journey records the gap); it is proven here against the real entry point.

type Listener = (...args: unknown[]) => unknown;
const listeners = new Map<string, Listener[]>();
const order: string[] = [];
const eventFor = (name: string) => ({
  addListener: vi.fn((l: Listener) => {
    order.push(`listen:${name}`);
    listeners.set(name, [...(listeners.get(name) ?? []), l]);
  }),
});

const ID = 'abcdefghijklmnopabcdefghijklmnop';
let setAccessLevel: ReturnType<typeof vi.fn>;
let tabsCreate: ReturnType<typeof vi.fn>;

beforeEach(() => {
  listeners.clear();
  order.length = 0;
  resetStorageLockdownForTests();
  tabsCreate = vi.fn(() => Promise.resolve({}));
  setAccessLevel = vi.fn(() => {
    order.push('lockdown');
    return Promise.resolve();
  });
  Object.assign(browser, {
    permissions: {
      contains: vi.fn(() => Promise.resolve(false)),
      onAdded: eventFor('permAdded'),
      onRemoved: eventFor('permRemoved'),
    },
    scripting: {
      getRegisteredContentScripts: vi.fn(() => Promise.resolve([])),
      registerContentScripts: vi.fn(() => Promise.resolve()),
      updateContentScripts: vi.fn(() => Promise.resolve()),
      unregisterContentScripts: vi.fn(() => Promise.resolve()),
      executeScript: vi.fn(() => Promise.resolve([])),
    },
    tabs: {
      create: tabsCreate,
      query: vi.fn(() => Promise.resolve([])),
      sendMessage: vi.fn(),
      onRemoved: eventFor('tabRemoved'),
      onUpdated: eventFor('tabUpdated'),
    },
    sidePanel: { setOptions: vi.fn(() => Promise.resolve()), open: vi.fn(() => Promise.resolve()) },
    contextMenus: { create: vi.fn(), removeAll: vi.fn(), onClicked: eventFor('menu') },
    commands: { onCommand: eventFor('command') },
  });
  Object.assign(browser.runtime, {
    id: ID,
    getURL: (path: string) => `chrome-extension://${ID}${path}`,
    onStartup: eventFor('startup'),
    onInstalled: eventFor('installed'),
    onMessage: eventFor('message'),
  });
  browser.storage.local.setAccessLevel = setAccessLevel as never;
  browser.storage.session.setAccessLevel = setAccessLevel as never;
});

const run = (): void => {
  const definition = background as unknown as { main(): void };
  definition.main();
};

describe('the background entry point', () => {
  it('opens the welcome page once, on a fresh install only', () => {
    run();
    const installed = listeners.get('installed') ?? [];
    expect(installed.length).toBeGreaterThan(0);
    for (const reason of ['update', 'chrome_update', 'shared_module_update']) {
      for (const l of installed) l({ reason });
    }
    expect(tabsCreate).not.toHaveBeenCalled();
    for (const l of installed) l({ reason: 'install' });
    expect(tabsCreate).toHaveBeenCalledTimes(1);
    expect(tabsCreate).toHaveBeenCalledWith({ url: `chrome-extension://${ID}/onboarding.html` });
  });

  it('a browser restart or an extension reload never reopens it (no onStartup handler opens a tab)', () => {
    run();
    for (const l of listeners.get('startup') ?? []) l();
    expect(tabsCreate).not.toHaveBeenCalled();
  });

  it('restricts both storage areas to trusted contexts BEFORE any listener is registered (secret boundary rule 1)', () => {
    run();
    expect(setAccessLevel).toHaveBeenCalledTimes(2);
    expect(setAccessLevel).toHaveBeenCalledWith({ accessLevel: 'TRUSTED_CONTEXTS' });
    const firstListener = order.findIndex((o) => o.startsWith('listen:'));
    expect(order.indexOf('lockdown')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('lockdown')).toBeLessThan(firstListener);
  });

  it('registers every listener synchronously (MV3 drops events registered after an await)', () => {
    run();
    for (const name of [
      'installed',
      'startup',
      'message',
      'permAdded',
      'permRemoved',
      'menu',
      'command',
      'tabRemoved',
      'tabUpdated',
    ]) {
      expect(listeners.get(name)?.length, name).toBeGreaterThan(0);
    }
  });
});

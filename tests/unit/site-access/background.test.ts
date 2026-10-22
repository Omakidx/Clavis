import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { CONTENT_SCRIPT_ID } from '../../../lib/config/constants';
import { registerSiteAccess, setupContextMenu } from '../../../lib/site-access/background';
import { CONTEXT_MENU_ID } from '../../../lib/site-access/injection';
import { injectUiMessage } from '../../../lib/site-access/messages';
import { buildRegisteredScript } from '../../../lib/site-access/registration';

type Listener = (...args: unknown[]) => unknown;

function fakeEvent() {
  const listeners: Listener[] = [];
  return {
    addListener: vi.fn((listener: Listener) => void listeners.push(listener)),
    removeListener: vi.fn(),
    emit: (...args: unknown[]) => listeners.map((listener) => listener(...args)),
  };
}

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';

function install() {
  let granted = false;
  let registered = false;
  const events = {
    onAdded: fakeEvent(),
    onRemoved: fakeEvent(),
    onStartup: fakeEvent(),
    onInstalled: fakeEvent(),
    onMessage: fakeEvent(),
    onClicked: fakeEvent(),
    onCommand: fakeEvent(),
  };
  const api = {
    contains: vi.fn(() => Promise.resolve(granted)),
    getRegistered: vi.fn(() => Promise.resolve(registered ? [{ id: CONTENT_SCRIPT_ID }] : [])),
    register: vi.fn(() => {
      registered = true;
      return Promise.resolve();
    }),
    update: vi.fn(() => Promise.resolve()),
    unregister: vi.fn(() => {
      registered = false;
      return Promise.resolve();
    }),
    executeScript: vi.fn((_injection: unknown) => Promise.resolve([])),
    sendMessage: vi.fn(() => Promise.resolve({ ok: true, shown: true })),
    removeAll: vi.fn(() => Promise.resolve()),
    create: vi.fn((_props: unknown, callback?: () => void) => callback?.()),
  };
  Object.assign(browser, {
    permissions: { contains: api.contains, onAdded: events.onAdded, onRemoved: events.onRemoved },
    scripting: {
      getRegisteredContentScripts: api.getRegistered,
      registerContentScripts: api.register,
      unregisterContentScripts: api.unregister,
      updateContentScripts: api.update,
      executeScript: api.executeScript,
    },
    tabs: { sendMessage: api.sendMessage },
    contextMenus: { create: api.create, removeAll: api.removeAll, onClicked: events.onClicked },
    commands: { onCommand: events.onCommand },
  });
  Object.assign(browser.runtime, {
    id: RUNTIME_ID,
    getURL: (path: string) => `chrome-extension://${RUNTIME_ID}${path}`,
    onStartup: events.onStartup,
    onInstalled: events.onInstalled,
    onMessage: events.onMessage,
  });
  return {
    api,
    events,
    grant: (value: boolean) => void (granted = value),
  };
}

beforeEach(() => {
  vi.spyOn(browser.i18n, 'getMessage').mockReturnValue('Explain with Clavis');
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

describe('registerSiteAccess', () => {
  it('registers every listener synchronously, before any await (MV3 requirement)', () => {
    const { events } = install();
    registerSiteAccess();
    for (const event of Object.values(events)) {
      expect(event.addListener).toHaveBeenCalledTimes(1);
    }
  });

  it('does not register the content script while access is not granted', async () => {
    const { api } = install();
    registerSiteAccess();
    await vi.waitFor(() => expect(api.contains).toHaveBeenCalled());
    await Promise.resolve();
    expect(api.register).not.toHaveBeenCalled();
  });

  it('registers the observer when permissions.onAdded fires after a grant', async () => {
    const { api, events, grant } = install();
    registerSiteAccess();
    await vi.waitFor(() => expect(api.contains).toHaveBeenCalledTimes(1));
    grant(true);
    events.onAdded.emit({ origins: ['http://*/*', 'https://*/*'] });
    await vi.waitFor(() => expect(api.register).toHaveBeenCalledWith([buildRegisteredScript()]));
  });

  it('unregisters when permissions.onRemoved fires after a revoke', async () => {
    const { api, events, grant } = install();
    registerSiteAccess();
    grant(true);
    events.onAdded.emit({});
    await vi.waitFor(() => expect(api.register).toHaveBeenCalledTimes(1));
    grant(false);
    events.onRemoved.emit({ origins: ['http://*/*', 'https://*/*'] });
    await vi.waitFor(() =>
      expect(api.unregister).toHaveBeenCalledWith({ ids: [CONTENT_SCRIPT_ID] }),
    );
  });

  it('reconciles on startup, so a grant made while the worker was stopped is picked up', async () => {
    const { api, events, grant } = install();
    registerSiteAccess();
    grant(true);
    events.onStartup.emit();
    await vi.waitFor(() => expect(api.register).toHaveBeenCalledTimes(1));
  });

  it('rebuilds the context menu and force-registers on install/update', async () => {
    const { api, events, grant } = install();
    registerSiteAccess();
    grant(true);
    events.onInstalled.emit({ reason: 'update' });
    await vi.waitFor(() => expect(api.create).toHaveBeenCalledTimes(1));
    expect(api.removeAll).toHaveBeenCalledTimes(1);
    expect(api.create.mock.calls[0]?.[0]).toMatchObject({
      id: CONTEXT_MENU_ID,
      contexts: ['selection'],
    });
    await vi.waitFor(() => expect(api.register).toHaveBeenCalled());
  });

  it('injects into the current tab when the context menu item is clicked', async () => {
    const { api, events } = install();
    registerSiteAccess();
    events.onClicked.emit(
      { menuItemId: CONTEXT_MENU_ID, frameId: 0, pageUrl: 'https://example.com/' },
      { id: 5, url: 'https://example.com/' },
    );
    await vi.waitFor(() => expect(api.executeScript).toHaveBeenCalledTimes(1));
    expect(api.executeScript.mock.calls[0]?.[0]).toMatchObject({ target: { tabId: 5 } });
  });

  it('injects and focuses the toolbar when the keyboard command fires', async () => {
    const { api, events } = install();
    registerSiteAccess();
    events.onCommand.emit('explain-selection', { id: 6, url: 'https://example.com/' });
    await vi.waitFor(() => expect(api.executeScript).toHaveBeenCalledTimes(1));
    expect(api.executeScript.mock.calls[0]?.[0]).toMatchObject({
      target: { tabId: 6, allFrames: true },
    });
    events.onCommand.emit('another-command', { id: 6 });
    await Promise.resolve();
    expect(api.executeScript).toHaveBeenCalledTimes(1);
  });

  it('does not crash the worker when the manifest declares no commands (browser.commands is undefined)', () => {
    install();
    Object.assign(browser, { commands: undefined });
    expect(() => registerSiteAccess()).not.toThrow();
  });

  it('answers option (a) UI-injection requests and leaves other messages alone', async () => {
    const { api, events } = install();
    registerSiteAccess();
    const sendResponse = vi.fn();
    const handled = events.onMessage.emit(
      injectUiMessage(),
      { id: RUNTIME_ID, url: 'https://example.com/', frameId: 0, tab: { id: 2 } },
      sendResponse,
    );
    expect(handled).toEqual([true]);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true, shown: false }));
    expect(api.executeScript).toHaveBeenCalledTimes(1);

    expect(events.onMessage.emit({ type: 'SOMETHING_ELSE' }, { id: RUNTIME_ID }, vi.fn())).toEqual([
      undefined,
    ]);
  });
});

describe('setupContextMenu', () => {
  it('replaces any old menu with one selection-only "Explain with Clavis" item', async () => {
    const { api } = install();
    await setupContextMenu(browser.contextMenus);
    expect(api.removeAll).toHaveBeenCalledBefore(api.create);
    expect(api.create).toHaveBeenCalledWith(
      { id: CONTEXT_MENU_ID, title: 'Explain with Clavis', contexts: ['selection'] },
      expect.any(Function),
    );
  });
});

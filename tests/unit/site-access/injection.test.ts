import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_MENU_ID,
  classifyInjectError,
  explainInTab,
  filesForVariant,
  handleCommand,
  handleContextMenuClick,
  isInjectableUrl,
  routeInjectionMessage,
  type InjectionDeps,
} from '../../../lib/site-access/injection';
import { injectTabMessage, injectUiMessage } from '../../../lib/site-access/messages';

const RUNTIME_ID = 'abcdefghijklmnopabcdefghijklmnop';
const PREFIX = `chrome-extension://${RUNTIME_ID}/`;

function deps(
  overrides: {
    executeScript?: ReturnType<typeof vi.fn>;
    sendMessage?: ReturnType<typeof vi.fn>;
  } = {},
) {
  const executeScript = overrides.executeScript ?? vi.fn(() => Promise.resolve([{ frameId: 0 }]));
  const sendMessage =
    overrides.sendMessage ?? vi.fn(() => Promise.resolve({ ok: true, shown: true }));
  const value: InjectionDeps = {
    scripting: { executeScript } as never,
    tabs: { sendMessage } as never,
    runtimeId: RUNTIME_ID,
    extensionUrlPrefix: PREFIX,
    files: filesForVariant('a'),
  };
  return { executeScript, sendMessage, value };
}

describe('isInjectableUrl', () => {
  it.each([
    ['https://example.com/a', true],
    ['http://127.0.0.1:8080/', true],
    [undefined, true],
    ['chrome://extensions', false],
    ['chrome-extension://abc/popup.html', false],
    ['about:blank', false],
    ['file:///tmp/a.html', false],
    ['view-source:https://example.com', false],
    ['https://chromewebstore.google.com/detail/x', false],
    ['https://chrome.google.com/webstore/detail/x', false],
    ['https://chrome.google.com/other', true],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isInjectableUrl(url)).toBe(expected);
  });
});

describe('classifyInjectError', () => {
  it.each([
    ['Cannot access a chrome:// URL', 'restricted'],
    ['The extensions gallery cannot be scripted.', 'restricted'],
    [
      'Cannot access contents of the page. Extension manifest must request permission to access the respective host.',
      'no-access',
    ],
    ['No tab with id: 5', 'failed'],
  ])('%s -> %s', (message, reason) => {
    expect(classifyInjectError(new Error(message))).toBe(reason);
  });
});

describe('explainInTab (declined-access path, activeTab)', () => {
  it('injects observer and UI into the clicked frame only, then opens the selection', async () => {
    const { executeScript, sendMessage, value } = deps();
    const result = await explainInTab(value, { tabId: 7, frameId: 3, url: 'https://example.com/' });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [3] },
      files: ['/content-scripts/content.js', '/content-scripts/content-ui.js'],
    });
    expect(sendMessage).toHaveBeenCalledWith(
      7,
      { v: 1, type: 'CLAVIS_OPEN_SELECTION' },
      { frameId: 3 },
    );
    expect(result).toEqual({ ok: true, shown: true });
  });

  it('only injects the observer for the bundled-UI option (c)', () => {
    expect(filesForVariant('c')).toEqual(['/content-scripts/content.js']);
    expect(filesForVariant('b')).toEqual(filesForVariant('a'));
  });

  it('does not even try on restricted pages', async () => {
    const { executeScript, value } = deps();
    for (const url of [
      'chrome://extensions',
      'https://chromewebstore.google.com/x',
      'about:blank',
    ]) {
      expect(await explainInTab(value, { tabId: 1, frameId: 0, url })).toEqual({
        ok: false,
        reason: 'restricted',
      });
    }
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('reports a refused injection instead of throwing', async () => {
    const { value, sendMessage } = deps({
      executeScript: vi.fn(() => Promise.reject(new Error('Cannot access contents of the page.'))),
    });
    expect(await explainInTab(value, { tabId: 1, frameId: 0, url: undefined })).toEqual({
      ok: false,
      reason: 'no-access',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('reports "nothing shown" when no content script answers or nothing is selected', async () => {
    const silent = deps({ sendMessage: vi.fn(() => Promise.reject(new Error('no receiver'))) });
    expect(await explainInTab(silent.value, { tabId: 1, frameId: 0, url: undefined })).toEqual({
      ok: true,
      shown: false,
    });
    const empty = deps({ sendMessage: vi.fn(() => Promise.resolve({ ok: true, shown: false })) });
    expect(await explainInTab(empty.value, { tabId: 1, frameId: 0, url: undefined })).toEqual({
      ok: true,
      shown: false,
    });
  });
});

describe('handleContextMenuClick', () => {
  it('ignores other menu items', () => {
    const { value } = deps();
    expect(handleContextMenuClick(value, { menuItemId: 'other' }, { id: 1 })).toBeUndefined();
  });

  it('injects into the clicked frame of the clicked tab', async () => {
    const { executeScript, value } = deps();
    await handleContextMenuClick(
      value,
      { menuItemId: CONTEXT_MENU_ID, frameId: 2, pageUrl: 'https://a.test/' },
      { id: 9, url: 'https://a.test/' },
    );
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 9, frameIds: [2] } }),
    );
  });

  it('defaults to the top frame and fails softly without a tab', async () => {
    const { executeScript, value } = deps();
    await handleContextMenuClick(value, { menuItemId: CONTEXT_MENU_ID }, { id: 4 });
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 4, frameIds: [0] } }),
    );
    expect(await handleContextMenuClick(value, { menuItemId: CONTEXT_MENU_ID }, undefined)).toEqual(
      {
        ok: false,
        reason: 'failed',
      },
    );
  });
});

describe('handleCommand (keyboard shortcut)', () => {
  it('ignores other commands', () => {
    const { value } = deps();
    expect(handleCommand(value, 'other', { id: 1 })).toBeUndefined();
  });

  it('injects into all reachable frames and asks for focus to move into the toolbar', async () => {
    const { executeScript, sendMessage, value } = deps({
      executeScript: vi.fn(() => Promise.resolve([{ frameId: 0 }, { frameId: 2 }])),
    });
    const result = await handleCommand(value, 'explain-selection', {
      id: 8,
      url: 'https://a.test/',
    });
    expect(result).toEqual({ ok: true, shown: true });
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 8, allFrames: true } }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      8,
      { v: 1, type: 'CLAVIS_OPEN_SELECTION', focus: true },
      { frameId: 2 },
    );
  });

  it('refuses restricted pages and a missing tab without injecting', async () => {
    const { executeScript, value } = deps();
    expect(
      await handleCommand(value, 'explain-selection', { id: 8, url: 'chrome://extensions' }),
    ).toEqual({ ok: false, reason: 'restricted' });
    expect(await handleCommand(value, 'explain-selection', undefined)).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(executeScript).not.toHaveBeenCalled();
  });
});

describe('routeInjectionMessage', () => {
  it('returns undefined for messages it does not own so other listeners can answer', () => {
    const { value } = deps();
    expect(routeInjectionMessage(value, { type: 'TTS_SPEAK' }, { id: RUNTIME_ID })).toBeUndefined();
    expect(routeInjectionMessage(value, 'hello', {})).toBeUndefined();
  });

  it('option (a): injects only the UI file into the sender frame', async () => {
    const { executeScript, value } = deps();
    const result = await routeInjectionMessage(value, injectUiMessage(), {
      id: RUNTIME_ID,
      url: 'https://example.com/page',
      frameId: 5,
      tab: { id: 12 },
    });
    expect(result).toEqual({ ok: true, shown: false });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 12, frameIds: [5] },
      files: ['/content-scripts/content-ui.js'],
    });
  });

  it('option (a): serves about:blank and about:srcdoc frames, which inherit their parent origin', async () => {
    const { executeScript, value } = deps();
    for (const url of ['about:srcdoc', 'about:blank']) {
      const result = await routeInjectionMessage(value, injectUiMessage(), {
        id: RUNTIME_ID,
        url,
        frameId: 4,
        tab: { id: 1 },
      });
      expect(result).toEqual({ ok: true, shown: false });
    }
    expect(executeScript).toHaveBeenCalledTimes(2);
  });

  it('option (a): refuses browser-internal frames', async () => {
    const { executeScript, value } = deps();
    const result = await routeInjectionMessage(value, injectUiMessage(), {
      id: RUNTIME_ID,
      url: 'chrome://extensions/',
      tab: { id: 1 },
    });
    expect(result).toEqual({ ok: false, reason: 'restricted' });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('option (a): rejects senders that are not this extension or have no tab', async () => {
    const { executeScript, value } = deps();
    expect(
      await routeInjectionMessage(value, injectUiMessage(), { id: 'other', tab: { id: 1 } }),
    ).toEqual({ ok: false, reason: 'failed' });
    expect(await routeInjectionMessage(value, injectUiMessage(), { id: RUNTIME_ID })).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('popup fallback: accepts extension pages only, and covers every reachable frame', async () => {
    const { executeScript, sendMessage, value } = deps({
      executeScript: vi.fn(() => Promise.resolve([{ frameId: 0 }, { frameId: 6 }])),
      sendMessage: vi.fn((_tab: number, _msg: unknown, options: { frameId: number }) =>
        Promise.resolve({ ok: true, shown: options.frameId === 6 }),
      ),
    });
    const fromPopup = await routeInjectionMessage(value, injectTabMessage(3, 'https://a.test/'), {
      id: RUNTIME_ID,
      url: `${PREFIX}popup.html`,
    });
    // Only the frame holding the selection reports `shown`; the answer is "any frame".
    expect(fromPopup).toEqual({ ok: true, shown: true });
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 3, allFrames: true } }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);

    const fromWebPage = await routeInjectionMessage(value, injectTabMessage(3), {
      id: RUNTIME_ID,
      url: 'https://evil.test/',
      tab: { id: 8 },
    });
    expect(fromWebPage).toEqual({ ok: false, reason: 'failed' });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('popup fallback: ignores malformed tab ids', () => {
    const { value } = deps();
    const sender = { id: RUNTIME_ID, url: `${PREFIX}popup.html` };
    expect(
      routeInjectionMessage(value, { v: 1, type: 'CLAVIS_INJECT_TAB', tabId: '3' }, sender),
    ).toBeUndefined();
    expect(
      routeInjectionMessage(value, { v: 1, type: 'CLAVIS_INJECT_TAB', tabId: 1.5 }, sender),
    ).toBeUndefined();
  });
});

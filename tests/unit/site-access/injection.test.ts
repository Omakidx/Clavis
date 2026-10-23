import { describe, expect, it, vi } from 'vitest';
import {
  CONTEXT_MENU_ID,
  classifyInjectError,
  explainInTab,
  handleCommand,
  handleContextMenuClick,
  isInjectableUrl,
  isReaderUrl,
  injectTabForPopup,
  type InjectionDeps,
} from '../../../lib/site-access/injection';
import {
  injectTabMessage,
  isOpenSelectionMessage,
  openSelectionMessage,
} from '../../../lib/site-access/messages';

const READER = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/reader.html';

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
    readerUrl: READER,
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
  it('injects the observer (which bundles the toolbar) into the clicked frame only, then opens the selection', async () => {
    const { executeScript, sendMessage, value } = deps();
    const result = await explainInTab(value, { tabId: 7, frameId: 3, url: 'https://example.com/' });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, frameIds: [3] },
      files: ['/content-scripts/content.js'],
    });
    expect(sendMessage).toHaveBeenCalledWith(
      7,
      { v: 1, type: 'CLAVIS_OPEN_SELECTION' },
      { frameId: 3 },
    );
    expect(result).toEqual({ ok: true, shown: true });
  });

  it('the context menu and the popup button also start Explain, the shortcut only focuses (FR-018)', async () => {
    const menu = deps();
    await handleContextMenuClick(
      menu.value,
      { menuItemId: CONTEXT_MENU_ID, frameId: 3 },
      { id: 7, url: 'https://example.com/' },
    );
    expect(menu.sendMessage).toHaveBeenCalledWith(
      7,
      { v: 1, type: 'CLAVIS_OPEN_SELECTION', explain: true },
      { frameId: 3 },
    );
    const popup = deps();
    await injectTabForPopup(popup.value, injectTabMessage(7, 'https://example.com/'));
    expect(popup.sendMessage).toHaveBeenCalledWith(
      7,
      { v: 1, type: 'CLAVIS_OPEN_SELECTION', explain: true },
      { frameId: 0 },
    );
    const key = deps();
    await handleCommand(key.value, 'explain-selection', { id: 7, url: 'https://example.com/' });
    expect(key.sendMessage).toHaveBeenCalledWith(
      7,
      { v: 1, type: 'CLAVIS_OPEN_SELECTION', focus: true },
      { frameId: 0 },
    );
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

describe('injectTabForPopup (activeTab fallback)', () => {
  it('covers every reachable frame and answers "any frame shown"', async () => {
    const { executeScript, sendMessage, value } = deps({
      executeScript: vi.fn(() => Promise.resolve([{ frameId: 0 }, { frameId: 6 }])),
      sendMessage: vi.fn((_tab: number, _msg: unknown, options: { frameId: number }) =>
        Promise.resolve({ ok: true, shown: options.frameId === 6 }),
      ),
    });
    const result = await injectTabForPopup(value, injectTabMessage(3, 'https://a.test/'));
    expect(result).toEqual({ ok: true, shown: true });
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 3, allFrames: true } }),
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it('skips restricted pages without touching the tab', async () => {
    const { executeScript, value } = deps();
    expect(await injectTabForPopup(value, injectTabMessage(3, 'chrome://settings'))).toEqual({
      ok: false,
      reason: 'restricted',
    });
    expect(executeScript).not.toHaveBeenCalled();
  });
});

describe('handleContextMenuClick: cross-origin iframe under activeTab', () => {
  const noAccess = () =>
    new Error('Cannot access contents of the page. Extension manifest must request permission.');
  const click = { menuItemId: CONTEXT_MENU_ID, frameId: 5 };
  const tab = { id: 9, url: 'https://top.example/page' };

  it('injects the observer into the top frame and sends a notice there', async () => {
    const executeScript = vi
      .fn()
      .mockRejectedValueOnce(noAccess()) // the iframe: refused by Chrome
      .mockResolvedValue([{ frameId: 0 }]); // the top frame: covered by the grant
    const { sendMessage, value } = deps({ executeScript });
    const result = await handleContextMenuClick(value, click, tab);

    expect(executeScript).toHaveBeenNthCalledWith(1, {
      target: { tabId: 9, frameIds: [5] },
      files: ['/content-scripts/content.js'],
    });
    expect(executeScript).toHaveBeenNthCalledWith(2, {
      target: { tabId: 9, frameIds: [0] },
      files: ['/content-scripts/content.js'],
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      9,
      { v: 1, type: 'CLAVIS_SHOW_NOTICE', reason: 'frame-no-access' },
      { frameId: 0 },
    );
    // No toolbar was shown for the frame the user clicked in.
    expect(result).toEqual({ ok: false, reason: 'no-access' });
  });

  it('does nothing extra when the top frame (frameId 0) itself is refused', async () => {
    const { executeScript, sendMessage, value } = deps({
      executeScript: vi.fn(() => Promise.reject(noAccess())),
    });
    expect(await handleContextMenuClick(value, { ...click, frameId: 0 }, tab)).toEqual({
      ok: false,
      reason: 'no-access',
    });
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('does not fall back for other failures (restricted, failed)', async () => {
    for (const message of ['Cannot access a chrome:// URL', 'Frame with ID 5 was removed.']) {
      const { executeScript, sendMessage, value } = deps({
        executeScript: vi.fn(() => Promise.reject(new Error(message))),
      });
      const result = await handleContextMenuClick(value, click, tab);
      expect(result).toMatchObject({ ok: false });
      expect(executeScript).toHaveBeenCalledTimes(1);
      expect(sendMessage).not.toHaveBeenCalled();
    }
  });

  it('does not fall back when the top page is restricted', async () => {
    const { executeScript, sendMessage, value } = deps({
      executeScript: vi.fn(() => Promise.reject(noAccess())),
    });
    // A subframe URL check passes (tab.url is the top page), so use a Web Store top page.
    const result = await handleContextMenuClick(
      value,
      { ...click, pageUrl: 'https://ok.example/' },
      { id: 9, url: 'https://chromewebstore.google.com/detail/x' },
    );
    expect(result).toEqual({ ok: false, reason: 'restricted' });
    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('keeps the original failure if the top frame cannot be injected either', async () => {
    const { sendMessage, value } = deps({
      executeScript: vi.fn(() => Promise.reject(noAccess())),
    });
    expect(await handleContextMenuClick(value, click, tab)).toEqual({
      ok: false,
      reason: 'no-access',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('tolerates the top frame going away before the notice is delivered', async () => {
    const executeScript = vi
      .fn()
      .mockRejectedValueOnce(noAccess())
      .mockResolvedValue([{ frameId: 0 }]);
    const { value } = deps({
      executeScript,
      sendMessage: vi.fn(() => Promise.reject(new Error('Receiving end does not exist.'))),
    });
    await expect(handleContextMenuClick(value, click, tab)).resolves.toEqual({
      ok: false,
      reason: 'no-access',
    });
  });
});

describe('the reader page (an extension page that hosts the toolbar itself)', () => {
  const readerTab = { id: 4, url: `${READER}?file=blob%3Aabc#page=2` };

  it('isReaderUrl matches this extension reader only, ignoring query and fragment', () => {
    expect(isReaderUrl(READER, READER)).toBe(true);
    expect(isReaderUrl(READER, `${READER}?x=1#y`)).toBe(true);
    for (const url of [
      undefined,
      '',
      'not a url',
      'chrome-extension://otherextensionidotherextensionid/reader.html',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/reader.html.evil',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/sub/reader.html',
      'https://abcdefghijklmnopabcdefghijklmnop/reader.html',
      'https://evil.example/reader.html',
    ]) {
      expect(isReaderUrl(READER, url), String(url)).toBe(false);
    }
  });

  it('the keyboard command asks the reader top frame to open the toolbar WITH focus, and injects nothing', async () => {
    const { executeScript, sendMessage, value } = deps();
    const result = await handleCommand(value, 'explain-selection', readerTab);
    expect(result).toEqual({ ok: true, shown: true });
    expect(executeScript).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      4,
      { v: 1, type: 'CLAVIS_OPEN_SELECTION', focus: true },
      { frameId: 0 },
    );
  });

  it('reports shown:false when there is no selection or the reader does not answer', async () => {
    const none = deps({ sendMessage: vi.fn(() => Promise.resolve({ ok: true, shown: false })) });
    expect(await handleCommand(none.value, 'explain-selection', readerTab)).toEqual({
      ok: true,
      shown: false,
    });
    const gone = deps({ sendMessage: vi.fn(() => Promise.reject(new Error('no receiver'))) });
    expect(await handleCommand(gone.value, 'explain-selection', readerTab)).toEqual({
      ok: true,
      shown: false,
    });
  });

  it('the popup path and the context menu use the same route: explain, no focus', async () => {
    const popup = deps();
    expect(await injectTabForPopup(popup.value, injectTabMessage(4, readerTab.url))).toEqual({
      ok: true,
      shown: true,
    });
    expect(popup.sendMessage).toHaveBeenCalledWith(
      4,
      { v: 1, type: 'CLAVIS_OPEN_SELECTION', explain: true },
      { frameId: 0 },
    );
    expect(popup.executeScript).not.toHaveBeenCalled();

    const menu = deps();
    await handleContextMenuClick(
      menu.value,
      { menuItemId: CONTEXT_MENU_ID, frameId: 0 },
      readerTab,
    );
    expect(menu.sendMessage).toHaveBeenCalledWith(
      4,
      { v: 1, type: 'CLAVIS_OPEN_SELECTION', explain: true },
      { frameId: 0 },
    );
    expect(menu.executeScript).not.toHaveBeenCalled();
  });

  it('every other extension page stays restricted and is never injected or messaged', async () => {
    for (const url of [
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/options.html',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/onboarding.html',
      'chrome-extension://otherextensionidotherextensionid/reader.html',
      'chrome://extensions',
    ]) {
      const { executeScript, sendMessage, value } = deps();
      expect(await handleCommand(value, 'explain-selection', { id: 4, url }), url).toEqual({
        ok: false,
        reason: 'restricted',
      });
      expect(executeScript).not.toHaveBeenCalled();
      expect(sendMessage).not.toHaveBeenCalled();
    }
  });
});

describe('CLAVIS_OPEN_SELECTION', () => {
  it('builds and checks the explain flag (the toolbar-only shortcut message stays unchanged)', () => {
    expect(openSelectionMessage()).toEqual({ v: 1, type: 'CLAVIS_OPEN_SELECTION' });
    expect(openSelectionMessage({ focus: true })).toEqual({
      v: 1,
      type: 'CLAVIS_OPEN_SELECTION',
      focus: true,
    });
    expect(openSelectionMessage({ explain: true })).toEqual({
      v: 1,
      type: 'CLAVIS_OPEN_SELECTION',
      explain: true,
    });
    for (const good of [
      openSelectionMessage(),
      openSelectionMessage({ focus: true, explain: true }),
    ]) {
      expect(isOpenSelectionMessage(good)).toBe(true);
    }
    for (const bad of [
      { v: 1, type: 'CLAVIS_OPEN_SELECTION', explain: 'yes' },
      { v: 2, type: 'CLAVIS_OPEN_SELECTION', explain: true },
      { v: 1, type: 'CLAVIS_OPEN_SELECTION', focus: 1 },
      null,
    ]) {
      expect(isOpenSelectionMessage(bad)).toBe(false);
    }
  });
});

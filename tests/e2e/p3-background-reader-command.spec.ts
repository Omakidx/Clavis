import { expect, test } from './fixtures';
import { openReader, waitForPhase, waitForRendersToSettle } from './p7-reader-support/helpers';
import { CONTEXT_WORD, contextPdf } from './p7-reader-support/pdfs';
import { gotoPage, selectWordByDoubleClick } from './p7-reader-support/select';
import { tb } from './spike-b-support/toolbar';

// Phase 7: the real keyboard command (Alt+Shift+E) and the popup path in the PDF reader.
// /reader.html is an extension page: Clavis never injects into it, it asks the reader (which
// mounts the shared toolbar itself) to open the toolbar for the current selection.
// The command is delivered by dispatching the real `commands.onCommand` event inside the service
// worker, so the real listener (handleCommand) runs.

test.describe.configure({ timeout: 90_000 });

async function openReaderWithSelection(
  context: import('@playwright/test').BrowserContext,
  extensionId: string,
) {
  const session = await openReader(context, extensionId);
  await session.page.getByTestId('file-input').setInputFiles({
    name: 'context.pdf',
    mimeType: 'application/pdf',
    buffer: await contextPdf(),
  });
  await waitForPhase(session.page, 'ready');
  await gotoPage(session.page, 2);
  await waitForRendersToSettle(session.page, { quietMs: 500 });
  await selectWordByDoubleClick(session.page, CONTEXT_WORD, 2);
  await tb(session.page).waitShown();
  return session;
}

test('Alt+Shift+E in the reader opens the toolbar with focus, without injecting anything', async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  const { page } = await openReaderWithSelection(context, extensionId);
  // Dismiss the toolbar the selection opened, so the command has something to (re)open.
  await page.keyboard.press('Escape');
  await tb(page).waitHidden();
  // Escape cleared the focus, not the selection; make sure the selection is still there.
  expect(await page.evaluate(() => getSelection()?.toString().trim())).toBe(CONTEXT_WORD);

  const injected = await serviceWorker.evaluate(async (readerUrl) => {
    // Spy on injection: it must never be attempted for an extension page.
    const scripting = chrome.scripting as unknown as {
      executeScript: (...a: unknown[]) => unknown;
    };
    const original = scripting.executeScript;
    let calls = 0;
    scripting.executeScript = (...args: unknown[]) => {
      calls += 1;
      return original.apply(chrome.scripting, args);
    };
    const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(readerUrl));
    if (tab?.id === undefined) throw new Error('reader tab not found');
    (
      chrome.commands.onCommand as unknown as { dispatch(command: string, tab: object): void }
    ).dispatch('explain-selection', tab);
    await new Promise((resolve) => setTimeout(resolve, 600));
    scripting.executeScript = original;
    return calls;
  }, `chrome-extension://${extensionId}/reader.html`);
  expect(injected).toBe(0);

  await tb(page).waitShown();
  // Keyboard users land inside the toolbar.
  await expect.poll(() => tb(page).focusedAction()).toBe('explain');
});

test('a reader tab with no selection is told so quietly: no toolbar, nothing injected', async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  const session = await openReader(context, extensionId);
  const result = await serviceWorker.evaluate(async (readerUrl) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(readerUrl));
    if (tab?.id === undefined) throw new Error('reader tab not found');
    return chrome.tabs.sendMessage(
      tab.id,
      { v: 1, type: 'CLAVIS_OPEN_SELECTION', focus: true },
      {
        frameId: 0,
      },
    );
  }, `chrome-extension://${extensionId}/reader.html`);
  expect(result).toMatchObject({ ok: true, shown: false });
  expect(await tb(session.page).hostCount()).toBe(0);
});

test('other extension pages are still never injected or messaged by the command', async ({
  context,
  serviceWorker,
  extensionId,
}) => {
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/options.html`);
  const outcome = await serviceWorker.evaluate(async (optionsUrl) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url?.startsWith(optionsUrl));
    if (tab?.id === undefined) throw new Error('options tab not found');
    const scripting = chrome.scripting as unknown as {
      executeScript: (...a: unknown[]) => unknown;
    };
    const tabs = chrome.tabs as unknown as { sendMessage: (...a: unknown[]) => unknown };
    const origScript = scripting.executeScript;
    const origSend = tabs.sendMessage;
    const seen = { executeScript: 0, sendMessage: 0 };
    scripting.executeScript = (...a: unknown[]) => {
      seen.executeScript += 1;
      return origScript.apply(chrome.scripting, a);
    };
    tabs.sendMessage = (...a: unknown[]) => {
      seen.sendMessage += 1;
      return origSend.apply(chrome.tabs, a);
    };
    (
      chrome.commands.onCommand as unknown as { dispatch(command: string, tab: object): void }
    ).dispatch('explain-selection', tab);
    await new Promise((resolve) => setTimeout(resolve, 500));
    scripting.executeScript = origScript;
    tabs.sendMessage = origSend;
    return seen;
  }, `chrome-extension://${extensionId}/options.html`);
  expect(outcome).toEqual({ executeScript: 0, sendMessage: 0 });
});

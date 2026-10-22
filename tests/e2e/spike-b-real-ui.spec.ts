import { expect, test, type Frame, type Page } from '@playwright/test';
import { launchExtension, type LaunchedExtension } from './spike-b-support/extension';
import {
  openClavisPopup,
  realUiEnabled,
  rightClickBox,
  xdotool,
} from './spike-b-support/native-ui';
import { dblclickText, frameOffset, textBox } from './spike-b-support/page';
import { SEL, tb } from './spike-b-support/toolbar';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { gotoSiteAccessStep } from './p3-ui-support/pages';

// Spike B with Chrome's REAL native UI, no manifest patching and no stand-ins:
// the permission prompt (D-02), the context menu and the toolbar icon (FR-018, activeTab).
//
//   CLAVIS_E2E_REAL_UI=1 CLAVIS_EXTENSION_DIR=.output-spike-b/chrome-mv3 \
//     xvfb-run -a -s "-screen 0 1920x1080x24" npx playwright test tests/e2e/spike-b-real-ui.spec.ts
//
// Opt-in because it needs a display, xdotool and ImageMagick's `import`; skipped otherwise.
test.skip(!realUiEnabled, 'opt-in: set CLAVIS_E2E_REAL_UI=1 and run under xvfb-run -a');

let server: FixtureServer;
let ext: LaunchedExtension | undefined;

test.beforeAll(async () => {
  server = await startFixtureServer();
});

test.afterAll(async () => {
  await server?.close();
});

test.afterEach(async () => {
  await ext?.close();
  ext = undefined;
});

/** Launch visible Chromium and settle: wait for the install-time onboarding tab, then use it. */
async function launch(
  options: { command?: boolean } = {},
): Promise<{ ext: LaunchedExtension; onboarding: Page }> {
  ext = await launchExtension({ headed: true, ...options });
  const deadline = Date.now() + 8000;
  let onboarding: Page | undefined;
  while (onboarding === undefined && Date.now() < deadline) {
    onboarding = ext.context.pages().find((page) => page.url().endsWith('/onboarding.html'));
    if (onboarding === undefined) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (onboarding === undefined) throw new Error('onboarding tab never opened');
  for (const page of ext.context.pages()) if (page !== onboarding) await page.close();
  await onboarding.bringToFront();
  // The wizard: accept the data disclosure and go to the website-access step.
  await gotoSiteAccessStep(onboarding);
  return { ext, onboarding };
}

/**
 * Press "Explain on this page" in the open Clavis popup, by keyboard. The popup now starts with a
 * status block and, while Groq is not connected, a "Connect Groq" button, so the fixed-coordinate
 * click on its "first button" no longer lands here. On a fresh profile the tab order is
 * Connect Groq, then Explain on this page.
 */
function pressPopupExplainHere(): void {
  xdotool('key', 'Tab');
  xdotool('key', 'Tab');
  xdotool('key', 'Return');
}

async function registeredCount(extension: LaunchedExtension): Promise<number> {
  return (await extension.serviceWorker.evaluate(
    'chrome.scripting.getRegisteredContentScripts().then((s) => s.length)',
  )) as number;
}

async function openArticle(extension: LaunchedExtension): Promise<Page> {
  const page = await extension.context.newPage();
  await page.goto(`${server.origin}/article.html`);
  await page.waitForTimeout(500);
  return page;
}

test('Allow in the real permission prompt registers the observer; revoking unregisters it', async () => {
  const { ext: extension, onboarding } = await launch();

  // A tab opened BEFORE the grant, to document what the grant does to already-open tabs.
  const early = await openArticle(extension);
  await onboarding.bringToFront();
  // newPage() activates the new tab; switch back to the onboarding tab for the prompt.
  xdotool('key', 'ctrl+1');
  await expect(onboarding.getByRole('button', { name: 'Enable on websites' })).toBeVisible();

  await onboarding.getByRole('button', { name: 'Enable on websites' }).click();
  await expect(onboarding.getByRole('status')).toHaveText(/Waiting for your answer/);
  await onboarding.waitForTimeout(800);
  // The prompt opens with "Deny" focused: Tab moves to "Allow", Space presses it.
  xdotool('key', 'Tab');
  xdotool('key', 'space');

  await expect(onboarding.getByRole('status')).toHaveText(/Website access is on/, {
    timeout: 10_000,
  });
  expect(
    await extension.serviceWorker.evaluate(
      `chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })`,
    ),
  ).toBe(true);
  await expect.poll(() => registeredCount(extension)).toBe(1);

  // New tab: the registered observer runs with no further action.
  const fresh = await openArticle(extension);
  await dblclickText(fresh, fresh, 'cartographer');
  await tb(fresh).waitShown();

  // Chrome itself does not inject registered scripts into tabs that were already open; since
  // Phase 3 the background injects the observer into them after a grant, so no reload is needed.
  await early.bringToFront();
  await dblclickText(early, early, 'cartographer');
  await tb(early).waitShown();
  // A reload still works (the registered script takes over; only one observer runs per frame).
  await early.reload();
  await early.waitForTimeout(500);
  await dblclickText(early, early, 'cartographer');
  await tb(early).waitShown();

  // Revoke (what Settings will do): onRemoved unregisters, and new pages are untouched.
  const removed = await onboarding.evaluate(() =>
    chrome.permissions.remove({ origins: ['http://*/*', 'https://*/*'] }),
  );
  expect(removed).toBe(true);
  await expect.poll(() => registeredCount(extension)).toBe(0);
  const after = await openArticle(extension);
  await dblclickText(after, after, 'cartographer');
  await after.waitForTimeout(600);
  await tb(after).expectNoHost();
});

test('Deny in the real permission prompt leaves site access off and nothing registered', async () => {
  const { ext: extension, onboarding } = await launch();
  await onboarding.getByRole('button', { name: 'Enable on websites' }).click();
  await expect(onboarding.getByRole('status')).toHaveText(/Waiting for your answer/);
  await onboarding.waitForTimeout(800);
  xdotool('key', 'Return'); // "Deny" has the initial focus.
  await expect(onboarding.getByRole('status')).toHaveText(/Website access stayed off/, {
    timeout: 10_000,
  });
  expect(
    await extension.serviceWorker.evaluate(
      `chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })`,
    ),
  ).toBe(false);
  expect(await registeredCount(extension)).toBe(0);
  // The button is usable again after a denial.
  await expect(onboarding.getByRole('button', { name: 'Enable on websites' })).toBeEnabled();
});

test('declined access: the right-click "Explain with Clavis" item injects into the current tab only', async () => {
  const { ext: extension, onboarding } = await launch();
  // Open the article first: closing the last tab would close the window.
  const page = await openArticle(extension);
  await onboarding.close();
  await dblclickText(page, page, 'cartographer');
  await page.waitForTimeout(500);
  // Declined: no observer, so selecting alone shows nothing.
  await tb(page).expectNoHost();

  await rightClickBox(page, await textBox(page, 'cartographer'));
  await page.waitForTimeout(700);
  // The extension item sits just above "Inspect": Up, Up from the unfocused menu.
  xdotool('key', 'Up');
  xdotool('key', 'Up');
  xdotool('key', 'Return');

  await tb(page).waitShown();
  expect(await registeredCount(extension)).toBe(0);
  expect(
    await extension.serviceWorker.evaluate(
      `chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })`,
    ),
  ).toBe(false);

  // Only that tab was touched: another tab still has no observer.
  const other = await openArticle(extension);
  await dblclickText(other, other, 'cartographer');
  await other.waitForTimeout(600);
  await tb(other).expectNoHost();
});

test('declined access: the toolbar icon (popup button) injects into the current tab', async () => {
  const { ext: extension, onboarding } = await launch();
  // Open the article first: closing the last tab would close the window.
  const page = await openArticle(extension);
  await onboarding.close();
  await dblclickText(page, page, 'cartographer');
  await page.waitForTimeout(500);
  await tb(page).expectNoHost();

  await openClavisPopup(page);
  pressPopupExplainHere();
  await tb(page).waitShown();
  expect(await registeredCount(extension)).toBe(0);
});

test('keyboard shortcut (proposed command): works without site access, and focus lands in the toolbar', async () => {
  const { ext: extension, onboarding } = await launch({ command: true });
  const page = await openArticle(extension);
  await onboarding.close();
  await dblclickText(page, page, 'cartographer');
  await page.waitForTimeout(500);
  await tb(page).expectNoHost();

  xdotool('key', 'alt+shift+e');
  await tb(page).waitShown();
  // Keyboard users land on the first action, then can activate it without a mouse.
  await expect.poll(() => tb(page).focusedAction()).toBe('listen');
  xdotool('key', 'Right');
  await expect.poll(() => tb(page).focusedAction()).toBe('explain');
  xdotool('key', 'Return');
  await tb(page).waitShown(SEL.card);
  expect(await tb(page).attr(SEL.card, 'data-action')).toBe('explain');
  expect(await registeredCount(extension)).toBe(0);
});

/** Right-click `word` inside a frame and choose "Explain with Clavis" (Up, Up from the unfocused menu). */
async function explainFromFrameMenu(page: Page, frame: Frame, word: string): Promise<void> {
  await dblclickText(page, frame, word);
  await page.waitForTimeout(500);
  const [box, offset] = await Promise.all([textBox(frame, word), frameOffset(frame)]);
  await rightClickBox(page, { ...box, x: box.x + offset.x, y: box.y + offset.y });
  await page.waitForTimeout(700);
  xdotool('key', 'Up');
  xdotool('key', 'Up');
  xdotool('key', 'Return');
}

async function openFramesPage(extension: LaunchedExtension, onboarding: Page): Promise<Page> {
  const page = await extension.context.newPage();
  await page.goto(`${server.origin}/iframe.html`);
  await page.waitForLoadState('load');
  await onboarding.close();
  return page;
}

test('declined access: right-click in a SAME-origin iframe injects into that frame only', async () => {
  const { ext: extension, onboarding } = await launch();
  const page = await openFramesPage(extension, onboarding);
  const frame = await (await page.locator('#same').elementHandle())!.contentFrame();
  await explainFromFrameMenu(page, frame as Frame, 'lighthouse');
  await tb(frame as Frame).waitShown();
  await tb(page).expectNoHost();
});

test('declined access LIMIT: Chrome refuses activeTab injection into a CROSS-origin iframe', async () => {
  const { ext: extension, onboarding } = await launch();
  const page = await openFramesPage(extension, onboarding);
  // Record what executeScript answers, to prove the refusal comes from Chrome and not from us.
  await extension.serviceWorker.evaluate(() => {
    const scripting = chrome.scripting as unknown as {
      executeScript: (injection: unknown) => Promise<unknown>;
    };
    const original = scripting.executeScript.bind(chrome.scripting);
    const log: string[] = [];
    (globalThis as unknown as { __errors: string[] }).__errors = log;
    scripting.executeScript = (injection) =>
      original(injection).catch((error: Error) => {
        log.push(error.message);
        throw error;
      });
  });
  const frame = await (await page.locator('#cross').elementHandle())!.contentFrame();
  await explainFromFrameMenu(page, frame as Frame, 'harbour');
  await page.waitForTimeout(1200);
  await tb(frame as Frame).expectNoHost();
  const errors = (await extension.serviceWorker.evaluate(
    () => (globalThis as unknown as { __errors: string[] }).__errors,
  )) as string[];
  expect(errors.join('\n')).toMatch(/Cannot access contents of the page/);
});

test('declined access: the popup button and the shortcut still work on a page that embeds cross-origin iframes', async () => {
  const { ext: extension, onboarding } = await launch({ command: true });
  const page = await openFramesPage(extension, onboarding);
  await dblclickText(page, page, 'anchor');
  await page.waitForTimeout(500);
  await tb(page).expectNoHost();

  // Shortcut first (all frames): the inaccessible cross-origin frame must not sink the whole call.
  xdotool('key', 'alt+shift+e');
  await tb(page).waitShown();
  await page.keyboard.press('Escape');
  await tb(page).waitHidden();

  // Then the toolbar icon + popup button (same all-frames call).
  await dblclickText(page, page, 'frames');
  await openClavisPopup(page);
  pressPopupExplainHere();
  await tb(page).waitShown();
});

test("Chrome's own Site access switch (On click / On all sites) unregisters and re-registers the observer", async () => {
  const { ext: extension, onboarding } = await launch();
  await onboarding.getByRole('button', { name: 'Enable on websites' }).click();
  await onboarding.waitForTimeout(800);
  xdotool('key', 'Tab');
  xdotool('key', 'space');
  await expect(onboarding.getByRole('status')).toHaveText(/Website access is on/, {
    timeout: 10_000,
  });
  await expect.poll(() => registeredCount(extension)).toBe(1);

  // What chrome://extensions > Clavis > Site access does, through the same private API.
  const settings = await extension.context.newPage();
  await settings.goto('chrome://extensions');
  const setHostAccess = (mode: 'ON_CLICK' | 'ON_ALL_SITES') =>
    settings.evaluate(
      ({ id, hostAccess }) =>
        (
          chrome as unknown as {
            developerPrivate: {
              updateExtensionConfiguration(o: object): Promise<void>;
            };
          }
        ).developerPrivate.updateExtensionConfiguration({ extensionId: id, hostAccess }),
      { id: extension.extensionId, hostAccess: mode },
    );

  await setHostAccess('ON_CLICK');
  await expect.poll(() => registeredCount(extension)).toBe(0);
  const withheld = await openArticle(extension);
  await dblclickText(withheld, withheld, 'cartographer');
  await withheld.waitForTimeout(600);
  await tb(withheld).expectNoHost();

  await setHostAccess('ON_ALL_SITES');
  await expect.poll(() => registeredCount(extension)).toBe(1);
  const restored = await openArticle(extension);
  await dblclickText(restored, restored, 'cartographer');
  await tb(restored).waitShown();
});

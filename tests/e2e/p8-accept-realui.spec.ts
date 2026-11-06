import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { extensionPath } from './fixtures';
import { startPdfServer, type PdfServer } from './p7-accept-support/server';
import { fixturePath, waitForPhase } from './p7-reader-support/helpers';
import { selectWordByDoubleClick } from './p7-reader-support/select';
import { CARD, cardOf } from './p5-card-support/harness';
import { realPanelUrls, tabIdOf } from './p8-sidepanel-support/panel';
import {
  contentOrigin,
  moveAndClick,
  realUiEnabled,
  rightClickBox,
  browserWindow,
  xdotool,
} from './spike-b-support/native-ui';
import { dblclickText, textBox } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import { tagAnswers } from './p8-accept-support/answers';
import { walkOnboarding } from './p8-accept-support/onboarding';
import { startWorld, type World } from './p8-accept-support/world';

// Phase 8 acceptance with Chrome's REAL native UI (no manifest patching, no stand-ins): the permission
// prompt, the context menu, the toolbar icon and popup, the keyboard shortcut and the browser's own
// find bar, driven with xdotool. Opt in; one worker; a display is needed:
//
//   CLAVIS_E2E_REAL_UI=1 CLAVIS_EXTENSION_DIR=.output-p8-accept/chrome-mv3 \
//     xvfb-run -a -s "-screen 0 1920x1080x24" npx playwright test tests/e2e/p8-accept-realui.spec.ts --workers=1
test.skip(!realUiEnabled, 'opt-in: set CLAVIS_E2E_REAL_UI=1 and run under xvfb-run -a');
test.describe.configure({ mode: 'serial', timeout: 180_000 });

const registered = async (world: World): Promise<number> =>
  (await world.ext.serviceWorker.evaluate(
    'chrome.scripting.getRegisteredContentScripts().then((s) => s.length)',
  )) as number;

const hasAccess = async (world: World): Promise<boolean> =>
  (await world.ext.serviceWorker.evaluate(
    `chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })`,
  )) as boolean;

async function openArticle(world: World, query = ''): Promise<Page> {
  const page = await world.ext.context.newPage();
  await page.goto(`${world.server.origin}/article.html${query}`);
  await page.waitForTimeout(500);
  return page;
}

/**
 * Open the real Clavis popup from Chrome's Extensions menu. Chrome lists the extension in two
 * layouts (with and without a "Full access" heading once it has been used on a site), so the entry
 * is at one of two heights: try the first, and when the service worker reports no popup context
 * the menu is still open, so click the second.
 */
async function openPopup(world: World, page: Page): Promise<void> {
  const open = async (): Promise<boolean> =>
    ((await world.ext.serviceWorker.evaluate(
      `chrome.runtime.getContexts({ contextTypes: ['POPUP'] }).then((c) => c.length)`,
    )) as number) > 0;
  const win = browserWindow();
  const puzzleX = win.x + win.width - 113;
  const puzzleY = win.y + 63;
  moveAndClick(puzzleX, puzzleY);
  await page.waitForTimeout(800);
  for (const [dx, dy] of [
    [-202, 141],
    [-226, 164],
  ] as const) {
    moveAndClick(puzzleX + dx, puzzleY + dy);
    await page.waitForTimeout(1200);
    if (await open()) {
      await page.waitForTimeout(800); // let the popup finish drawing before any key is sent
      return;
    }
  }
  throw new Error('the Clavis popup did not open');
}

/**
 * The page whose address matches, once it exists. The real popup also shows up as a page (and goes
 * away again), so "the next new page" is not necessarily the one a press opened.
 */
async function pageAt(world: World, address: RegExp): Promise<Page> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const found = world.ext.context.pages().find((p) => !p.isClosed() && address.test(p.url()));
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`no page opened at ${String(address)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Real mouse click on an element of the card (closed shadow root): screen coordinates via xdotool. */
async function realClickCard(page: Page, selector: string): Promise<void> {
  const box = await cardOf(page).toolbar.box(selector);
  const origin = await contentOrigin(page);
  moveAndClick(origin.x + box.x + box.width / 2, origin.y + box.y + box.height / 2);
}

/**
 * Press Tab `n` times then Enter in the real popup (its Playwright page is not exposed). The keys
 * are spaced out: the popup renders its status first and keys sent into that are lost.
 */
async function popupPress(page: Page, tabs: number): Promise<void> {
  await pressTabs(page, tabs);
  await page.waitForTimeout(600);
  xdotool('key', 'Return');
}

async function pressTabs(page: Page, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    xdotool('key', 'Tab');
    await page.waitForTimeout(150);
  }
}

/** The popup's focusable controls in Tab order, read on the same page opened as a tab. */
async function popupFocusOrder(
  world: World,
  options: { openHelp?: boolean } = {},
): Promise<string[]> {
  const probe = await world.ext.context.newPage();
  await probe.goto(`chrome-extension://${world.ext.extensionId}/popup.html`);
  await probe.getByTestId('popup-groq').waitFor();
  if (options.openHelp === true)
    await probe.getByText('Using Clavis without website access').click();
  await probe.waitForTimeout(800);
  const order = await probe.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('button, a[href], summary, [tabindex="0"]'))
      .filter((el) => el.getBoundingClientRect().width > 0 && !(el as HTMLButtonElement).disabled)
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()),
  );
  await probe.close();
  return order;
}

/** The Tab count that reaches a named control in the popup, counted on the same page opened as a tab. */
async function tabsToPopupControl(world: World, name: string | RegExp): Promise<number> {
  const probe = await world.ext.context.newPage();
  await probe.goto(`chrome-extension://${world.ext.extensionId}/popup.html`);
  await probe.getByTestId('popup-groq').waitFor();
  await probe.waitForTimeout(800);
  const order = await probe.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('button, a[href], summary, [tabindex="0"]'))
      .filter((el) => el.getBoundingClientRect().width > 0 && !(el as HTMLButtonElement).disabled)
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()),
  );
  await probe.close();
  const index = order.findIndex((label) =>
    typeof name === 'string' ? label === name : name.test(label),
  );
  if (index === -1) throw new Error(`popup has no control "${String(name)}": ${order.join(' | ')}`);
  return index + 1;
}

test.describe('journey 1 with the real prompt: Allow, automatic toolbar, keyboard only', () => {
  let world: World;
  test.beforeAll(async () => {
    world = await startWorld({ granted: false, headed: true });
    await tagAnswers(world.ext.context);
  });
  test.afterAll(async () => {
    await world?.close();
  });

  test('onboarding: "Enable on websites" -> Chrome asks -> Allow registers the observer, also in tabs that were open', async () => {
    const early = await openArticle(world);
    await world.onboarding.bringToFront();
    xdotool('key', 'ctrl+1');
    await walkOnboarding(world.onboarding, world.ext.context, {
      access: 'enable',
      key: 'connect',
      onPrompt: async () => {
        await world.onboarding.waitForTimeout(800);
        xdotool('key', 'Tab'); // "Deny" has the initial focus; Allow is next.
        xdotool('key', 'space');
      },
    });
    expect(await hasAccess(world)).toBe(true);
    await expect.poll(() => registered(world)).toBe(1);
    await expect(world.onboarding.getByTestId('setup-summary')).toContainText('On');
    // No help for the declined path when access was granted.
    await expect(world.onboarding.getByTestId('site-access-help')).toHaveCount(0);

    // The tab that was open before the grant gets the toolbar with no reload.
    await early.bringToFront();
    await dblclickText(early, early, 'cartographer');
    await tb(early).waitShown();
    await early.close();
  });

  /** Select `word` with the keyboard alone: the browser's find bar, then Escape leaves the match selected. */
  async function selectByFind(page: Page, word: string): Promise<void> {
    await page.bringToFront();
    await page.waitForTimeout(500);
    xdotool('key', 'ctrl+f');
    await page.waitForTimeout(400);
    xdotool('key', 'ctrl+a');
    xdotool('type', '--delay', '40', word);
    xdotool('key', 'Return');
    await page.waitForTimeout(200);
    xdotool('key', 'Escape');
    await expect
      .poll(() => page.evaluate(() => getSelection()?.toString() ?? ''), { timeout: 5000 })
      .toBe(word);
  }

  /** Alt+Shift+E, then Enter on the first Lookup action: selection to card, no mouse. */
  async function explainByKeyboard(page: Page): Promise<ReturnType<typeof cardOf>> {
    xdotool('key', 'alt+shift+e');
    await expect.poll(() => tb(page).focusedAction()).toBe('explain');
    xdotool('key', 'Return');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    await expect.poll(() => card.focused()).toBe('card:explain');
    return card;
  }

  test('keyboard only: a keyboard selection shows the toolbar; Close keeps focus on Explain; Escape dismisses everything and focus is not lost', async () => {
    const page = await openArticle(world, '?keys=1');
    await selectByFind(page, 'cartographer');
    // A keyboard selection shows the toolbar by itself (FR-010) ...
    await tb(page).waitShown();
    // ... and Alt+Shift+E puts focus in it (FR-016).
    const card = await explainByKeyboard(page);

    // Tab moves to Close; Enter closes the card and focus stays on the toolbar's Explain button.
    xdotool('key', 'Tab');
    await expect.poll(() => card.focused()).toBe('card-close:');
    xdotool('key', 'Return');
    await card.waitGone(CARD.card);
    await expect.poll(() => tb(page).focusedAction()).toBe('explain');
    expect(await tb(page).isShown()).toBe(true);
    // Enter there asks again and the card is back with focus in it.
    xdotool('key', 'Return');
    await card.waitFor(CARD.ready('core'));
    await expect.poll(() => card.focused()).toBe('card:explain');

    // Escape dismisses the card AND the toolbar (UJ-02), and focus goes back to the page, not to a hidden node.
    xdotool('key', 'Escape');
    await card.waitGone(CARD.card);
    await tb(page).waitHidden();
    expect(
      await page.evaluate(() => ({
        body: document.activeElement === document.body,
        selection: getSelection()?.toString() ?? '',
      })),
    ).toEqual({ body: true, selection: 'cartographer' });
    await page.close();
  });

  test('keyboard only: the whole path, with the card tab order, Copy by key and Open in side panel by key', async () => {
    const page = await openArticle(world, '?keys=2');
    await selectByFind(page, 'plaster');
    await tb(page).waitShown();
    const card = await explainByKeyboard(page);

    // Tab order inside the card: Close, the tab, the answer, Copy, Open in side panel.
    const order: Array<string | null | undefined> = [];
    for (let i = 0; i < 5; i += 1) {
      xdotool('key', 'Tab');
      await page.waitForTimeout(80);
      order.push(await card.focused());
    }
    expect(order).toEqual([
      'card-close:',
      'card-tab:core',
      'card-panel:core',
      'card-copy:',
      'card-side-panel:',
    ]);
    // Shift+Tab goes back to Copy; Enter copies and it is announced (not mouse-only).
    xdotool('key', 'shift+Tab');
    await page.waitForTimeout(80);
    expect(await card.focused()).toBe('card-copy:');
    xdotool('key', 'Return');
    await expect.poll(() => card.text(CARD.live), { timeout: 5000 }).toBe('Copied');
    xdotool('key', 'Tab');
    await page.waitForTimeout(80);
    expect(await card.focused()).toBe('card-side-panel:');

    // Enter on "Open in side panel" opens this tab's real panel (a key press is a user gesture).
    // Chrome then moves keyboard focus into the panel, which is where the person goes next.
    const tabId = await tabIdOf(world.ext.serviceWorker, page);
    xdotool('key', 'Return');
    await expect
      .poll(() => card.text(CARD.live), { timeout: 8000 })
      .toBe('Opened in the side panel.');
    await expect
      .poll(() => realPanelUrls(world.ext.serviceWorker))
      .toContainEqual(expect.stringMatching(new RegExp(`/sidepanel\\.html\\?tab=${tabId}$`)));
    await page.close();
  });

  test('a real mouse click on Open in side panel (Copy first) works too', async () => {
    const page = await openArticle(world, '?mouse=1');
    await page.bringToFront();
    await dblclickText(page, page, 'plaster');
    await tb(page).waitShown();
    await tb(page).click('explain');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    await realClickCard(page, CARD.copy);
    await expect.poll(() => card.text(CARD.copy), { timeout: 5000 }).toMatch(/^Copied$|^Copy$/);
    await realClickCard(page, CARD.sidePanel);
    await expect
      .poll(() => card.text(CARD.live), { timeout: 8000 })
      .toBe('Opened in the side panel.');
    await page.close();
  });
});

/** The ways to use Clavis on one page that the in-product help names, read from the help itself. */
interface HelpPaths {
  menuItem: string;
  iconButton: string;
  shortcut: string;
  enableButton: string;
  toolbarSetting: string;
}

/** Pull the labels out of the words a person reads, so the tests press what the help says to press. */
function pathsFrom(help: string): HelpPaths {
  const flat = help.replace(/\s+/g, ' ');
  const grab = (re: RegExp, what: string): string => {
    const found = re.exec(flat)?.[1];
    if (found === undefined) throw new Error(`the help does not say ${what}: ${flat}`);
    return found;
  };
  return {
    menuItem: grab(/right-click it and choose (.+?)\./, 'what to choose in the right-click menu'),
    iconButton: grab(/click the Clavis icon and choose (.+?)\./, 'what to choose after the icon'),
    shortcut: grab(/press (Alt\+Shift\+[A-Z])\b/, 'which keys to press'),
    enableButton: grab(
      /Choose (.+?) under Website access in Settings/,
      'which button turns access on',
    ),
    toolbarSetting: grab(/is set to ([A-Z][a-z]+)\./, 'what the toolbar setting must be'),
  };
}

test.describe('journey 2 with the real browser UI: site access declined, found from the help alone', () => {
  let world: World;
  let paths: HelpPaths;
  test.beforeAll(async () => {
    world = await startWorld({ granted: false, headed: true });
    await tagAnswers(world.ext.context);
  });
  test.afterAll(async () => {
    await world?.close();
  });

  test('"Not now" in setup; the help shows where the spec says (setup end, popup, Settings) and says the same thing', async () => {
    await walkOnboarding(world.onboarding, world.ext.context, { access: 'skip', key: 'connect' });
    expect(await hasAccess(world)).toBe(false);
    expect(await registered(world)).toBe(0);

    const onboardingHelp = await world.onboarding.getByTestId('site-access-help').innerText();
    paths = pathsFrom(onboardingHelp);

    const popup = await world.ext.context.newPage();
    await popup.goto(`chrome-extension://${world.ext.extensionId}/popup.html`);
    await popup.getByText('Using Clavis without website access').click();
    const popupHelp = await popup.getByTestId('site-access-help').innerText();
    // The popup is where the icon path starts: it has the button the help names, enabled.
    await expect(popup.getByRole('button', { name: paths.iconButton })).toBeEnabled();
    await popup.close();

    const settings = await world.ext.context.newPage();
    await settings.goto(
      `chrome-extension://${world.ext.extensionId}/options.html#section-site-access`,
    );
    const settingsHelp = await settings.getByTestId('site-access-help').first().innerText();
    // The button the help names is on this screen, and so is the toolbar setting it mentions.
    await expect(settings.getByRole('button', { name: paths.enableButton })).toBeVisible();
    await settings.getByRole('link', { name: 'Preferences', exact: true }).click();
    await expect(
      settings.getByRole('group', { name: 'When to show the toolbar' }).getByRole('radio', {
        name: new RegExp(`^${paths.toolbarSetting}`),
      }),
    ).toBeVisible();
    await settings.close();

    expect(pathsFrom(popupHelp)).toEqual(paths);
    expect(pathsFrom(settingsHelp)).toEqual(paths);
    // The wording the help uses is the wording of the controls: the right-click item is the
    // context-menu title the extension registers, and the key is the one the manifest suggests.
    const catalog = JSON.parse(
      readFileSync(path.join(extensionPath, '_locales/en/messages.json'), 'utf8'),
    ) as Record<string, { message: string }>;
    expect(paths.menuItem).toBe(catalog['toolbarContextMenuTitle']?.message);
    expect(paths.iconButton).toBe(catalog['popupInjectButton']?.message);
    const manifest = JSON.parse(
      readFileSync(path.join(extensionPath, 'manifest.json'), 'utf8'),
    ) as {
      commands: Record<string, { suggested_key: { default: string } }>;
    };
    expect(manifest.commands['explain-selection']?.suggested_key.default).toBe(paths.shortcut);
    await world.onboarding.close();
  });

  test('right-click -> the item the help names: the card opens for the selection on that tab only (FR-018), with no further press', async () => {
    test.skip(paths === undefined, 'needs the help text from the previous test');
    const page = await openArticle(world, '?menu=1');
    await dblclickText(page, page, 'cartographer');
    await page.waitForTimeout(500);
    await tb(page).expectNoHost();
    await rightClickBox(page, await textBox(page, 'cartographer'));
    await page.waitForTimeout(700);
    // The extension's item sits just above "Inspect" (the same Up, Up as the shipped spike spec).
    xdotool('key', 'Up');
    xdotool('key', 'Up');
    xdotool('key', 'Return');
    await tb(page).waitShown();
    expect(await registered(world)).toBe(0);
    expect(await hasAccess(world)).toBe(false);
    // The item itself starts Explain: the core answer arrives without pressing the button.
    await cardOf(page).waitFor(CARD.ready('core'));
    const other = await openArticle(world, '?menu=other');
    await dblclickText(other, other, 'cartographer');
    await other.waitForTimeout(600);
    await tb(other).expectNoHost();
    await other.close();
    await page.close();
  });

  test('the Clavis icon -> the popup button the help names: toolbar and card for the selection', async () => {
    test.skip(paths === undefined, 'needs the help text from the previous test');
    const page = await openArticle(world, '?icon=1');
    await dblclickText(page, page, 'cartographer');
    await page.waitForTimeout(500);
    await tb(page).expectNoHost();
    const tabs = await tabsToPopupControl(world, paths.iconButton);
    await openPopup(world, page);
    await popupPress(page, tabs);
    await tb(page).waitShown();
    // The popup button starts Explain too (FR-018).
    await cardOf(page).waitFor(CARD.ready('core'));
    expect(await registered(world)).toBe(0);
    await page.close();
  });

  test('the keys the help names: focus lands in the toolbar, and Explain by keyboard gives the card', async () => {
    test.skip(paths === undefined, 'needs the help text from the previous test');
    const page = await openArticle(world, '?keys=1');
    await dblclickText(page, page, 'cartographer');
    await page.waitForTimeout(500);
    await tb(page).expectNoHost();
    xdotool('key', paths.shortcut.toLowerCase());
    await tb(page).waitShown();
    await expect.poll(() => tb(page).focusedAction()).toBe('explain');
    xdotool('key', 'Return');
    await cardOf(page).waitFor(CARD.ready('core'));
    expect(await registered(world)).toBe(0);
    await page.close();
  });

  test('how to turn the automatic toolbar on, as the help says: Enable on websites, then "Automatically"; "Only when I ask" keeps it hidden', async () => {
    test.skip(paths === undefined, 'needs the help text from the previous test');
    // From the popup help's own button ("Turn on website access") to Settings > Website access.
    const page = await openArticle(world, '?auto=1');
    const order = await popupFocusOrder(world, { openHelp: true });
    const summary = order.indexOf('Using Clavis without website access');
    const turnOn = order.indexOf('Turn on website access');
    expect(summary, 'the popup has the help summary').toBeGreaterThan(-1);
    expect(turnOn, 'the popup help has its button').toBeGreaterThan(summary);
    await openPopup(world, page);
    await pressTabs(page, summary + 1);
    xdotool('key', 'space');
    await page.waitForTimeout(300);
    await pressTabs(page, turnOn - summary);
    xdotool('key', 'Return');
    const settings = await pageAt(world, /options\.html#section-site-access$/);
    await settings.bringToFront();
    await settings.getByRole('button', { name: paths.enableButton }).click();
    await expect(settings.getByRole('status').first()).toContainText('Waiting for your answer');
    await settings.waitForTimeout(800);
    xdotool('key', 'Tab');
    xdotool('key', 'space');
    await expect(settings.getByTestId('site-access-status')).toContainText('Website access is on', {
      timeout: 10_000,
    });
    await expect.poll(() => registered(world)).toBe(1);

    // Automatic: a page loaded now shows the toolbar with no further action.
    const auto = await openArticle(world, '?auto=2');
    await dblclickText(auto, auto, 'cartographer');
    await tb(auto).waitShown();
    await auto.close();

    // "Only when I ask": the toolbar stays hidden by itself even with access on (the help warns of it) ...
    await settings.getByRole('radio', { name: /^Only when I ask/ }).check();
    await settings.waitForTimeout(600);
    const quiet = await openArticle(world, '?auto=3');
    await dblclickText(quiet, quiet, 'cartographer');
    await quiet.waitForTimeout(800);
    await tb(quiet).expectNoHost();
    // ... while the shortcut still opens it.
    xdotool('key', paths.shortcut.toLowerCase());
    await tb(quiet).waitShown();
    await quiet.close();
    await page.close();
    await settings.close();
  });
});

test.describe('journey 3 with the real browser UI: a PDF in Chrome, the popup notice, the help, the Clavis reader', () => {
  let world: World;
  let pdfServer: PdfServer;
  test.beforeAll(async () => {
    pdfServer = await startPdfServer();
    world = await startWorld({ granted: false, headed: true });
    await tagAnswers(world.ext.context);
    await walkOnboarding(world.onboarding, world.ext.context, { access: 'skip', key: 'connect' });
    await world.onboarding.close();
  });
  test.afterAll(async () => {
    await world?.close();
    await pdfServer?.close();
  });

  test('popup on a PDF tab -> help -> the Clavis reader -> choose the file -> select -> Explain -> side panel', async () => {
    const pdfTab = await world.ext.context.newPage();
    await pdfTab.goto(`${pdfServer.origin}/basic-1page.pdf`).catch(() => undefined);
    await pdfTab.waitForTimeout(1500);
    expect(pdfTab.url()).toMatch(/\.pdf$/);

    // The popup, on that tab, says it looks like a PDF: its first button is the help (a key is saved,
    // so there is no Connect Groq above it and Explain on this page is hidden for a PDF).
    const helpTab = await tabsToPopupControlOnPdf(world, 'How to read PDFs with Clavis');
    await openPopup(world, pdfTab);
    await popupPress(pdfTab, helpTab);
    const settings = await pageAt(world, /options\.html#section-help-pdf$/);
    await expect(settings.getByTestId('pdf-help')).toBeInViewport();
    const help = (await settings.getByTestId('pdf-help').innerText()).replace(/\s+/g, ' ');
    expect(help).toContain("can't add a toolbar to");
    // Step 1 of the help: "Click the Clavis icon and choose Open PDF reader".
    const stepButton = /choose (Open PDF reader)/.exec(help)?.[1];
    expect(stepButton).toBe('Open PDF reader');

    // Chrome drops the one-tab grant when the tab navigates, and lists the extension in the menu
    // as on first use again: load the PDF anew, as a person would after switching tabs.
    // (The probe page that counts Tab presses is made before the popup opens: a new tab would close it.)
    const readerTabs = await tabsToPopupControlOnPdf(world, stepButton as string);
    await pdfTab.bringToFront();
    await pdfTab.goto(`${pdfServer.origin}/basic-1page.pdf`).catch(() => undefined);
    await pdfTab.waitForTimeout(1500);
    await openPopup(world, pdfTab);
    await popupPress(pdfTab, readerTabs);
    const reader = await pageAt(world, /\/reader\.html$/);
    await reader.waitForURL(/reader\.html$/);
    await expect(reader.getByTestId('state-empty')).toBeVisible();

    // Step 2: "Choose the PDF from your computer".
    await reader.bringToFront();
    const chooser = reader.waitForEvent('filechooser');
    await reader.getByRole('button', { name: /Choose a PDF/ }).click();
    await (await chooser).setFiles(fixturePath('text-1page.pdf'));
    await waitForPhase(reader, 'ready');

    // Step 3: "Select a word or a sentence, then use Listen or Explain, just as on a web page."
    await selectWordByDoubleClick(reader, 'quick');
    await tb(reader).waitShown();
    await tb(reader).click('explain');
    const card = cardOf(reader);
    await card.waitFor(CARD.ready('core'));
    const tabId = await tabIdOf(world.ext.serviceWorker, reader);
    await realClickCard(reader, CARD.sidePanel);
    await expect
      .poll(() => card.text(CARD.live), { timeout: 8000 })
      .toBe('Opened in the side panel.');
    await expect
      .poll(() => realPanelUrls(world.ext.serviceWorker))
      .toContainEqual(expect.stringMatching(new RegExp(`/sidepanel\\.html\\?tab=${tabId}$`)));
    await reader.close();
    await settings.close();
    await pdfTab.close();
  });
});

/** Tab count to a control of the popup when its tab is a PDF (the tab's address is faked for the probe only). */
async function tabsToPopupControlOnPdf(world: World, name: string | RegExp): Promise<number> {
  const probe = await world.ext.context.newPage();
  await probe.addInitScript(() => {
    chrome.tabs.query = (() =>
      Promise.resolve([
        { id: 1, url: 'http://127.0.0.1/basic-1page.pdf' },
      ])) as unknown as typeof chrome.tabs.query;
  });
  await probe.goto(`chrome-extension://${world.ext.extensionId}/popup.html`);
  await probe.getByTestId('popup-pdf-help').waitFor();
  await probe.waitForTimeout(500);
  const order = await probe.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('button, a[href], summary, [tabindex="0"]'))
      .filter((el) => el.getBoundingClientRect().width > 0 && !(el as HTMLButtonElement).disabled)
      .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()),
  );
  await probe.close();
  const index = order.findIndex((label) =>
    typeof name === 'string' ? label === name : name.test(label),
  );
  if (index === -1) throw new Error(`popup has no control "${String(name)}": ${order.join(' | ')}`);
  return index + 1;
}

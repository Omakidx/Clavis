import { expect, test, type Page } from '@playwright/test';
import { clavisKeys, readStorage, send } from './p3-support/background';
import { CARD, cardOf } from './p5-card-support/harness';
import { machineHasVoices } from './p7-reader-support/ai';
import { openPanelPage, panelOptions, realPanelUrls, tabIdOf } from './p8-sidepanel-support/panel';
import { ListenProbe, LISTEN } from './p6-listen-support/listen';
import { dblclickText } from './spike-b-support/page';
import { SEL, tb } from './spike-b-support/toolbar';
import { tagAnswers, type ChatCall } from './p8-accept-support/answers';
import { ACCEPT_KEY } from './p8-accept-support/world';
import { restartableProfile } from './p8-accept-support/restart';
import { walkOnboarding } from './p8-accept-support/onboarding';
import { openWebpage, startWorld, type World } from './p8-accept-support/world';

// Phase 8 acceptance, journey 1 (UJ-01 .. UJ-03, FR-001, FR-002, FR-017, FR-019, FR-042): a person
// who just installed Clavis, using only what the screens tell them, on a fresh profile with the
// PRODUCTION build. Groq is answered by the test (fake gsk_TEST key, no external network).
//
//   WXT_OUT_DIR=.output-p8-accept npx wxt build
//   CLAVIS_EXTENSION_DIR=.output-p8-accept/chrome-mv3 npx playwright test tests/e2e/p8-accept-journey.spec.ts
test.describe.configure({ mode: 'serial', timeout: 120_000 });

/** Words that only a developer should ever see. None may appear on a page a person reads. */
const DEVELOPER_TEXT =
  /coming soon|not implemented|\bTODO\b|\bFIXME\b|lorem ipsum|\bspike\b|\bphase \d|npm |npx |wxt|devtools|developer mode|localhost|\bplaceholder\b/i;

const APPROVED_FIRST_SEND =
  "Send this to Groq? Clavis will send the selected text and a little of the text around it to Groq to explain it. You'll only be asked once.";

const chats = (world: World): number =>
  world.groqUrls.filter((u) => u.endsWith('/chat/completions')).length;
const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim();

let world: World;
let calls: ChatCall[];
let practice: Page;

// Part 1: a new user who answers "Not now" to website access. The practice page needs no website
// access (it hosts the same toolbar and card), so the whole select -> Explain -> panel flow works.
test.describe('part 1: onboarding with "Not now", then the practice page', () => {
  test.beforeAll(async () => {
    world = await startWorld({ granted: false });
    calls = await tagAnswers(world.ext.context);
    // Record what the card writes to the clipboard (see the Copy step), before any page loads.
    await world.ext.context.addInitScript(() => {
      const top = window.top as unknown as { __copied?: string[] };
      top.__copied ??= [];
      const clipboard = navigator.clipboard as Clipboard | undefined;
      if (clipboard === undefined) return;
      const original = clipboard.writeText.bind(clipboard);
      clipboard.writeText = (text: string) => {
        top.__copied?.push(text);
        return original(text);
      };
    });
  });
  test.afterAll(async () => {
    await world?.close();
  });

  test('install opens the welcome page once; a new user finishes setup using only the screens', async () => {
    const welcomeTabs = world.ext.context
      .pages()
      .filter((p) => p.url().endsWith('/onboarding.html'));
    expect(welcomeTabs).toHaveLength(1);

    const walked = await walkOnboarding(world.onboarding, world.ext.context, {
      access: 'skip',
      key: 'connect',
      practice: true,
    });
    practice = walked.practice as Page;
    expect(practice.url()).toBe(`chrome-extension://${world.ext.extensionId}/practice.html`);

    // Nothing a developer would say, on the last screen of setup.
    expect(await world.onboarding.locator('body').innerText()).not.toMatch(DEVELOPER_TEXT);
    // The summary says what was set up; connecting the key only checked it with Groq (no Explain yet).
    await expect(world.onboarding.getByTestId('setup-summary')).toContainText('Connected');
    await expect(world.onboarding.getByTestId('setup-summary')).toContainText(
      'Off (use right-click)',
    );
    expect(chats(world)).toBe(0);
    expect(world.groqUrls.every((u) => u.endsWith('/models'))).toBe(true);
    // The wizard's own state survives: a second install tab is not opened by anything else.
    expect(
      world.ext.context.pages().filter((p) => p.url().endsWith('/onboarding.html')),
    ).toHaveLength(1);
  });

  test('practice page: select, Listen, Explain, card, side panel, load another mode, Copy, close', async () => {
    test.skip(practice === undefined, 'needs the previous test');
    await practice.bringToFront();
    await expect.poll(() => practice.frames().some((f) => f.url() === 'about:srcdoc')).toBe(true);
    const frame = practice.frames().find((f) => f.url() === 'about:srcdoc')!;
    await frame.waitForSelector('article p');
    const toolbar = tb(frame);

    // Select: the toolbar appears with Listen and Explain, and nothing has been sent anywhere.
    await dblclickText(practice, frame, 'bank');
    await toolbar.waitShown();
    expect(chats(world)).toBe(0);
    await expect(toolbar.isShown(SEL.action('listen'))).resolves.toBe(true);
    await expect(toolbar.isShown(SEL.action('explain'))).resolves.toBe(true);

    // Listen: without an on-device voice it says so (FR-023); with one it plays. Never a Groq call.
    const listen = new ListenProbe(practice, frame);
    await listen.click('listen');
    if (await machineHasVoices(world.ext.context, world.ext.extensionId)) {
      await listen.until(
        () => listen.listenButton(),
        (b) => b?.state !== 'idle',
        'Listen started',
      );
    } else {
      const message = await listen.until(
        () => toolbar.text(LISTEN.message),
        (text) => (text ?? '').length > 0,
        'a no-voice message',
      );
      expect(message).toContain("Voice isn't available on this device.");
      expect(await listen.exists(LISTEN.voiceSettings)).toBe(true);
    }
    expect(chats(world)).toBe(0);

    // The no-voice note stacks above the card and the practice article's frame is short, so the
    // person dismisses it and selects again (the clipped card is DEFECT P1, own test below).
    await practice.keyboard.press('Escape');
    await toolbar.waitHidden();
    await dblclickText(practice, frame, 'bank');
    await toolbar.waitShown();

    // Explain: the data notice was acknowledged during setup, so no question; one request.
    await toolbar.click('explain');
    const card = cardOf(practice, frame);
    await card.waitFor(CARD.ready('core'));
    expect(await card.exists(CARD.disclosure)).toBe(false);
    expect(calls).toEqual([{ mode: 'core', word: 'bank' }]);
    expect(await card.text(CARD.panel('core'))).toContain('Definition of bank.');

    // Open in side panel: Chrome made a panel for THIS tab only; opening it sends nothing.
    const tabId = await tabIdOf(world.ext.serviceWorker, practice);
    await card.click(CARD.sidePanel);
    await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
    expect(await realPanelUrls(world.ext.serviceWorker)).toEqual([
      expect.stringMatching(new RegExp(`/sidepanel\\.html\\?tab=${tabId}$`)),
    ]);
    expect(await panelOptions(world.ext.serviceWorker, tabId)).toMatchObject({ enabled: true });
    const panel = await openPanelPage(world.ext.context, world.ext.extensionId, tabId);
    await expect(panel.getByTestId('panel-selected')).toHaveText('bank');
    await expect(panel.getByTestId('panel-section').first()).toContainText('Definition of bank.');
    await panel.waitForTimeout(300);
    expect(calls).toHaveLength(1);

    // Load another mode in the panel: exactly one more request, for this selection.
    const related = panel.locator('[data-testid="panel-section"][data-mode="related_words"]');
    await related.getByTestId('panel-load').click();
    await expect(related).toHaveAttribute('data-status', 'ready');
    expect(calls).toEqual([
      { mode: 'core', word: 'bank' },
      { mode: 'related_words', word: 'bank' },
    ]);
    await expect(related).toContainText('bank-alike');
    expect(await panel.locator('body').innerText()).not.toMatch(DEVELOPER_TEXT);

    // Copy (card): the text the card shows for the open tab goes to the clipboard (FR-019). An
    // extension page's origin cannot be granted clipboard-read, so the write is recorded instead
    // (webpages read the real clipboard: part 2).
    await practice.bringToFront();
    await card.click(CARD.copy);
    await expect.poll(() => card.text(CARD.copy)).toBe('Copied');
    const written = await practice.evaluate(
      () => (window as unknown as { __copied: string[] }).__copied,
    );
    const shown = (await card.toolbar.evalIn<string[]>(
      CARD.panel('core'),
      `function () { return Array.from(this.querySelectorAll('p:not(.ec__label), li')).map((e) => e.textContent); }`,
    )) as string[];
    expect(written).toHaveLength(1);
    expect(shown.length).toBeGreaterThan(3);
    for (const line of shown) expect(normalize(written[0] ?? '')).toContain(normalize(line));

    // Close: the card goes, the selection's toolbar stays; Escape then dismisses the toolbar.
    await card.click(CARD.close);
    await card.waitGone(CARD.card);
    expect(await toolbar.isShown()).toBe(true);
    await practice.keyboard.press('Escape');
    await toolbar.waitHidden();
    await panel.close();
  });
});

// Part 2: a person who closed the welcome page without doing the setup (website access is on:
// the stand-in for the Chrome prompt). They find Settings from the Clavis popup, paste a key,
// and meet the first-send question inside the card.
test.describe('part 2: setup skipped, key from the popup, first-send question, two tabs', () => {
  test.beforeAll(async () => {
    world = await startWorld({ granted: true });
    calls = await tagAnswers(world.ext.context);
    await world.onboarding.close();
  });
  test.afterAll(async () => {
    await world?.close();
  });

  test('popup -> Connect Groq -> paste key; Explain asks once before sending, then shows the card', async () => {
    const popup = await world.ext.context.newPage();
    await popup.goto(`chrome-extension://${world.ext.extensionId}/popup.html`);
    await expect(popup.getByTestId('popup-groq')).toHaveText('Setup needed');
    const opened = world.ext.context.waitForEvent('page');
    await popup.getByRole('button', { name: 'Connect Groq' }).click();
    const settings = await opened;
    await settings.waitForLoadState();
    await expect(settings.getByRole('region', { name: 'Groq API key' })).toBeInViewport();
    await settings.getByLabel('Your Groq key', { exact: true }).fill(ACCEPT_KEY);
    await settings.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(settings.getByText(/Connected\. Groq accepted your key ending in/)).toBeVisible({
      timeout: 20_000,
    });
    await settings.close();
    await popup.close();
    world.groqUrls.length = 0;

    const { page, dispose } = await openWebpage(world);
    try {
      await dblclickText(page, page, 'cartographer');
      await tb(page).waitShown();
      await tb(page).click('explain');
      const card = cardOf(page);
      await card.waitFor(CARD.disclosure);
      // The approved wording (D-16), and nothing has been sent while the question is open.
      expect(normalize((await card.text(CARD.disclosure)) ?? '')).toContain(APPROVED_FIRST_SEND);
      expect(await card.text(CARD.confirm)).toBe('Lookup');
      expect(await card.text(CARD.cancel)).toBe('Cancel');
      await page.waitForTimeout(700);
      expect(chats(world)).toBe(0);
      await card.click(CARD.confirm);
      await card.waitFor(CARD.ready('core'));
      expect(chats(world)).toBe(1);
      expect(calls).toEqual([{ mode: 'core', word: 'cartographer' }]);

      // Copy on a web page: the real clipboard holds what the card shows (FR-019).
      await world.ext.context.grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: world.server.origin,
      });
      await card.click(CARD.copy);
      await expect.poll(() => card.text(CARD.copy)).toBe('Copied');
      const shown = (await card.toolbar.evalIn<string[]>(
        CARD.panel('core'),
        `function () { return Array.from(this.querySelectorAll('p:not(.ec__label), li')).map((e) => e.textContent); }`,
      )) as string[];
      const clipboard = normalize(await page.evaluate(() => navigator.clipboard.readText()));
      expect(shown.length).toBeGreaterThan(3);
      for (const line of shown) expect(clipboard).toContain(normalize(line));
    } finally {
      await dispose();
    }
  });

  test('two tabs: each tab shows only its own explanation; leaving, closing and Clear all data drop it', async () => {
    const a = await openWebpage(world, 'article.html?tab=a');
    const b = await openWebpage(world, 'article.html?tab=b');
    const select = async (page: Page, word: string): Promise<ReturnType<typeof cardOf>> => {
      await page.bringToFront();
      await dblclickText(page, page, word);
      await tb(page).waitShown();
      await tb(page).click('explain');
      const card = cardOf(page);
      await card.waitFor(CARD.ready('core'));
      await card.click(CARD.sidePanel);
      await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
      return card;
    };
    await select(a.page, 'cartographer');
    await select(b.page, 'plaster');
    const idA = await tabIdOf(world.ext.serviceWorker, a.page);
    const idB = await tabIdOf(world.ext.serviceWorker, b.page);
    expect(idA).not.toBe(idB);

    // The real panels, one per tab.
    const urls = await realPanelUrls(world.ext.serviceWorker);
    expect(urls.some((u) => u.endsWith(`?tab=${idA}`))).toBe(true);
    expect(urls.some((u) => u.endsWith(`?tab=${idB}`))).toBe(true);

    const panelA = await openPanelPage(world.ext.context, world.ext.extensionId, idA);
    const panelB = await openPanelPage(world.ext.context, world.ext.extensionId, idB);
    await expect(panelA.getByTestId('panel-selected')).toHaveText('cartographer');
    await expect(panelB.getByTestId('panel-selected')).toHaveText('plaster');
    await expect(panelA.locator('body')).not.toContainText('plaster');
    await expect(panelB.locator('body')).not.toContainText('cartographer');
    await expect(panelA.getByTestId('panel-section').first()).toContainText(
      'Definition of cartographer.',
    );
    await expect(panelB.getByTestId('panel-section').first()).toContainText(
      'Definition of plaster.',
    );

    // A tab that never opened a panel has nothing, and says to select again.
    const c = await openWebpage(world, 'article.html?tab=c');
    const idC = await tabIdOf(world.ext.serviceWorker, c.page);
    const panelC = await openPanelPage(world.ext.context, world.ext.extensionId, idC);
    await expect(panelC.getByTestId('panel-empty')).toContainText('select it again');
    await expect(panelC.locator('body')).not.toContainText('cartographer');
    await expect(panelC.locator('body')).not.toContainText('plaster');

    // Navigation drops it for that tab only.
    await a.page.goto(`${world.server.origin}/long.html`);
    await expect(panelA.getByTestId('panel-empty')).toContainText('select it again');
    await expect(panelB.getByTestId('panel-selected')).toHaveText('plaster');

    // Closing a tab drops its hand-off: a panel asking for that tab id finds nothing.
    await b.dispose();
    const afterClose = await openPanelPage(world.ext.context, world.ext.extensionId, idB);
    await expect(afterClose.getByTestId('panel-empty')).toBeVisible();
    await expect(afterClose.locator('body')).not.toContainText('plaster');
    await afterClose.close();

    // Clear all data (Settings, as a person finds it) empties every panel, and nothing was ever stored.
    await select(c.page, 'library');
    const panelC2 = await openPanelPage(world.ext.context, world.ext.extensionId, idC);
    await expect(panelC2.getByTestId('panel-selected')).toHaveText('library');
    for (const area of ['local', 'session'] as const) {
      const stored = JSON.stringify(await readStorage(world.ext.serviceWorker, area));
      expect(stored, area).not.toContain('library');
      expect(await clavisKeys(world.ext.serviceWorker, area)).not.toContain('clavis.sidepanel');
    }
    const settings = await world.ext.context.newPage();
    await settings.goto(`chrome-extension://${world.ext.extensionId}/options.html`);
    await settings.getByRole('link', { name: 'Privacy & help' }).click();
    await settings.getByRole('button', { name: 'Clear all data', exact: true }).click();
    await settings
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Clear all data', exact: true })
      .click();
    await expect(
      settings.getByText('All Clavis data was removed from this browser.'),
    ).toBeVisible();
    await expect(panelC2.getByTestId('panel-empty')).toContainText('select it again');
    await settings.close();
    for (const p of [panelA, panelB, panelC, panelC2]) await p.close();
    await a.dispose();
    await c.dispose();
  });
});

// UJ-01 "Setup state must survive reloading the extension" (FR-001: reload or update does not reset
// completion). The profile is closed and opened again, like quitting and starting Chrome. (Chrome
// treats an extension loaded with --load-extension as freshly installed on every launch, so it
// shows the welcome page again here; that is the test harness, not the product. What a restart
// must keep is the stored setup, which is asserted.)
test('UJ-01: setup state survives a browser restart', async () => {
  const profile = await restartableProfile();
  try {
    const first = await profile.launch();
    const welcome = await waitForPage(first.context, /\/onboarding\.html$/);
    await send(welcome, { v: 1, type: 'ACCEPT_DISCLOSURE' });
    await send(welcome, { v: 1, type: 'UPDATE_ONBOARDING', siteAccessChoice: 'declined' });
    await send(welcome, { v: 1, type: 'UPDATE_ONBOARDING', completed: true });
    await send(welcome, { v: 1, type: 'SET_API_KEY', apiKey: ACCEPT_KEY, storage: 'local' });
    await profile.close();

    const second = await profile.launch();
    const probe = await second.context.newPage();
    await probe.goto(`chrome-extension://${second.extensionId}/options.html`);
    const settings = await send(probe, { v: 1, type: 'GET_SETTINGS' });
    expect(settings?.data?.onboarding).toMatchObject({
      completed: true,
      siteAccessChoice: 'declined',
    });
    expect(settings?.data?.onboarding?.['disclosureAcceptedAt']).toBeTruthy();
    const key = await send(probe, { v: 1, type: 'GET_KEY_STATUS' });
    expect(key?.data).toMatchObject({ hasKey: true, storage: 'local' });
    // Settings still offers the tutorial again (FR-008).
    await probe.getByRole('link', { name: 'Privacy & help' }).click();
    await expect(probe.getByRole('link', { name: 'Run the welcome tutorial again' })).toBeVisible();
  } finally {
    await profile.dispose();
  }
});

async function waitForPage(context: import('@playwright/test').BrowserContext, address: RegExp) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const found = context.pages().find((p) => address.test(p.url()));
    if (found !== undefined) return found;
    if (Date.now() > deadline) throw new Error(`no page at ${String(address)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

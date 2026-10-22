import { expect, test, type Page } from '@playwright/test';
import {
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from './spike-b-support/extension';
import { dblclickText, trackWorlds } from './spike-b-support/page';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { SEL, tb } from './spike-b-support/toolbar';

// Security review HIGH-1: a web page must not be able to drive the toolbar, read its card,
// or learn anything from it beyond "a div appeared".
let server: FixtureServer;
let ext: LaunchedExtension;

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchExtension({ grantedSiteAccess: true });
  await waitForRegistration(ext.serviceWorker);
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

interface PageLog {
  attachShadow: number;
  defines: string[];
  created: string[];
  seen: string[];
  upgraded: string[];
  leaks: string[];
}

const readLog = (page: Page): Promise<PageLog> =>
  page.evaluate(() => (window as unknown as { __log: PageLog }).__log);

async function openHostile(): Promise<{ page: Page; dispose(): Promise<void> }> {
  const page = await ext.context.newPage();
  const worlds = await trackWorlds(page);
  await page.goto(`${server.origin}/hostile.html`);
  await worlds.waitForObserver();
  return {
    page,
    async dispose() {
      await worlds.dispose();
      await page.close();
    },
  };
}

test('a page-made selection with synthetic events never raises the toolbar', async () => {
  const { page, dispose } = await openHostile();
  try {
    await page.evaluate(() =>
      (window as unknown as { attackProgrammatically(n: string): void }).attackProgrammatically(
        'secret phrase',
      ),
    );
    await page.waitForTimeout(800);
    expect(await page.evaluate(() => getSelection()?.toString())).toBe('secret phrase');
    // The toolbar was never even created: no host, nothing to click or read.
    await tb(page).expectNoHost();
  } finally {
    await dispose();
  }
});

test('with a toolbar showing, page scripts get no shadow root, cannot click it and cannot read the card', async () => {
  const { page, dispose } = await openHostile();
  try {
    await dblclickText(page, page, 'selected');
    await tb(page).waitShown();

    // The page looks for the root and fires synthetic clicks and keys at everything.
    expect(await page.evaluate(() => document.querySelector('clavis-toolbar-root'))).toBeNull();
    expect(await tb(page).pageSeesShadowRoot()).toBe(false);
    const results = await page.evaluate(() =>
      (window as unknown as { attackToolbar(): Record<string, unknown> }).attackToolbar(),
    );
    expect(results['hostShadowRoot']).toBe('null');
    await page.waitForTimeout(300);

    // No action fired (no card), the synthetic Escape did not dismiss it, and the page's own
    // observers saw only an empty div.
    expect(await tb(page).isShown(SEL.card)).toBe(false);
    expect(await tb(page).isShown()).toBe(true);
    const log = await readLog(page);
    expect(log.leaks).toEqual([]);

    // A real click still works, and the card text is invisible to the page.
    await tb(page).click('explain');
    await tb(page).waitShown(SEL.card);
    expect(await tb(page).text(SEL.cardText)).toBe('selected');
    const pageView = await page.evaluate(() => {
      const host = document.querySelector(':root > div[popover]') as HTMLElement;
      return {
        html: host.innerHTML,
        text: host.textContent,
        shadow: host.shadowRoot === null,
        attributes: Array.from(host.attributes, (a) => a.name).sort(),
      };
    });
    expect(pageView).toEqual({
      html: '',
      text: '',
      shadow: true,
      attributes: ['popover', 'style'],
    });
    expect((await readLog(page)).leaks).toEqual([]);
  } finally {
    await dispose();
  }
});

test('a page that pre-defines likely tags and patches attachShadow/createElement/customElements gets nothing, and the toolbar still works', async () => {
  const { page, dispose } = await openHostile();
  try {
    await dblclickText(page, page, 'visitor');
    await tb(page).waitShown();
    await tb(page).click('listen');
    await tb(page).waitShown(SEL.card);
    expect(await tb(page).attr(SEL.card, 'data-action')).toBe('listen');

    const log = await readLog(page);
    // The extension's own world has its own prototypes: the page's patches never ran for it.
    expect(log.attachShadow).toBe(0);
    expect(log.created).toEqual([]);
    expect(log.defines).toEqual([]);
    // No pre-defined custom element was ever instantiated (the host is a plain div) ...
    expect(log.upgraded).toEqual([]);
    // ... so there was no ElementInternals to read a root through, and the page only ever
    // saw one added element: the div host.
    expect(log.leaks).toEqual([]);
    expect(log.seen.filter((tag) => tag !== 'SCRIPT')).toEqual(['DIV']);
  } finally {
    await dispose();
  }
});

test('a real keyboard selection and the Escape key still work on the hostile page', async () => {
  const { page, dispose } = await openHostile();
  try {
    await dblclickText(page, page, 'ordinary');
    await tb(page).waitShown();
    await page.keyboard.down('Shift');
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Shift');
    await tb(page).waitShown();
    await page.keyboard.press('Escape');
    await tb(page).waitHidden();
  } finally {
    await dispose();
  }
});

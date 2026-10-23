import { expect, test, type Page } from '@playwright/test';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  activeTabId,
  expectHidden,
  expectShown,
  logWorkerMessages,
  observerRunsIn,
  resetPage,
  selectText,
} from './p4-matrix-support/actions';
import {
  openPath,
  startHarness,
  type Harness,
  type OpenedFixture,
} from './p4-matrix-support/harness';
import { manifest } from './p4-matrix-support/manifest';
import { hostShown } from './p4-matrix-support/page';
import { clickAction, readCardText, toolbar } from './p4-matrix-support/toolbar';
import { openExtensionPage, send } from './p3-support/background';

// Site access, restricted pages and the Groq boundary: FR-015 (respect permissions and exclusions,
// on-demand behaviour), FR-017 (no transmission on highlight alone), FR-018 (no all-sites access)
// and the "Site access" row of the verification matrix.
//
// Chrome's permission prompt, context menu and toolbar icon are native UI that Playwright cannot
// drive; those are covered by the opt-in real-UI spec. Here access is stood in as granted by the
// test manifest copy, and the on-demand injection route that the popup button uses is called
// directly from an extension page.

const PLAIN = 'plain-baseline.html';
const WORD = { context: 'sat on the bank of the river', text: 'bank' } as const;

// ------------------------------------------------------------------ granted build
test.describe('site access granted', () => {
  let harness: Harness;
  let options: Page;

  test.beforeAll(async () => {
    harness = await startHarness();
    options = await openExtensionPage(harness.ext.context, harness.ext.extensionId, 'options');
    await harness.ext.context.route('https://api.groq.com/**', (route) =>
      route.abort('blockedbyclient'),
    );
  });
  test.afterAll(async () => {
    await harness?.close();
  });

  const registered = (): Promise<Array<{ id: string; excludeMatches: string[] }>> =>
    harness.ext.serviceWorker.evaluate(() =>
      chrome.scripting
        .getRegisteredContentScripts()
        .then((scripts) =>
          scripts.map((s) => ({ id: s.id, excludeMatches: [...(s.excludeMatches ?? [])].sort() })),
        ),
    );
  const update = (patch: object) => send(options, { v: 1, type: 'UPDATE_PREFERENCES', patch });

  async function plainPage(host = harness.server.origin, query = ''): Promise<Page> {
    const page = await harness.ext.context.newPage();
    await page.goto(`${host}/${PLAIN}${query}`);
    return page;
  }

  const tabIdOf = (url: string): Promise<number> =>
    harness.ext.serviceWorker.evaluate(
      (target) =>
        chrome.tabs.query({}).then((tabs) => tabs.find((t) => t.url === target)?.id as number),
      url,
    );

  test.describe('FR-015 restricted and unsupported pages get no injection', () => {
    test('chrome:// pages, extension pages, data: URLs, about:blank and file: URLs never run the observer', async () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'clavis-p4-'));
      const file = path.join(dir, 'local.html');
      writeFileSync(file, '<p style="font:24px sans-serif">local file text for selection</p>');
      try {
        const urls = [
          'chrome://version',
          `chrome-extension://${harness.ext.extensionId}/options.html`,
          'data:text/html,<p style="font:24px sans-serif">a data url page for selection</p>',
          'about:blank',
          `file://${file}`,
        ];
        for (const url of urls) {
          const page = await harness.ext.context.newPage();
          try {
            await page.goto(url);
            expect(await observerRunsIn(page, 700), url).toBe(false);
            await page.mouse.dblclick(40, 30);
            await page.waitForTimeout(250);
            await toolbar(page).expectNoHost();
          } finally {
            await page.close();
          }
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    test('the Chrome Web Store is excluded in the registration itself (nothing to inject, nothing to refuse)', async () => {
      const [script] = await registered();
      expect(script?.excludeMatches).toEqual(
        expect.arrayContaining([
          'https://chrome.google.com/webstore/*',
          'https://chromewebstore.google.com/*',
        ]),
      );
    });

    test('a restricted tab refuses the on-demand injection route with a clean error, not an exception', async () => {
      const page = await harness.ext.context.newPage();
      await page.goto('chrome://version');
      await page.bringToFront();
      const tabId = await activeTabId(harness.ext.serviceWorker);
      const helper = await openExtensionPage(harness.ext.context, harness.ext.extensionId, 'popup');
      const reply = await send(helper, {
        v: 1,
        type: 'CLAVIS_INJECT_TAB',
        tabId,
        url: 'chrome://version',
      });
      expect(reply).toEqual({ ok: false, reason: 'restricted' });
      await helper.close();
      await page.close();
    });
  });

  test.describe('FR-015 respect disabled sites (preferences.disabledSites)', () => {
    test('a disabled host gets no toolbar on its next load; another host is unaffected; re-enabling restores it', async () => {
      await update({ disabledSites: ['127.0.0.1'] });
      try {
        const disabled = await plainPage();
        expect(
          await observerRunsIn(disabled, 1200),
          'observer must not run on a disabled site',
        ).toBe(false);
        await selectText(disabled, disabled, WORD, 'dblclick');
        await disabled.waitForTimeout(500);
        await toolbar(disabled).expectNoHost();

        const other = await plainPage(harness.server.crossOrigin);
        expect(await observerRunsIn(other, 5000), 'localhost is a different host').toBe(true);
        await selectText(other, other, WORD, 'dblclick');
        expect(await expectShown(other), 'toolbar on a site that is not disabled').toBe(true);
        await other.close();

        await update({ disabledSites: [] });
        await disabled.reload();
        expect(await observerRunsIn(disabled, 5000)).toBe(true);
        await selectText(disabled, disabled, WORD, 'dblclick');
        expect(await expectShown(disabled), 're-enabled').toBe(true);
        await disabled.close();
      } finally {
        await update({ disabledSites: [] });
      }
    });
  });

  test.describe('FR-015 tooltip behaviour: automatic or on-demand', () => {
    test('on-demand: no automatic toolbar on selection; the injection route (popup button) then shows it for the current selection in that tab only', async () => {
      await update({ tooltipBehavior: 'on-demand' });
      try {
        const page = await plainPage();
        const second = await plainPage(harness.server.origin, '?second');
        expect(await observerRunsIn(page, 800), 'no observer in on-demand mode').toBe(false);
        await selectText(page, page, WORD, 'dblclick');
        await page.waitForTimeout(500);
        await toolbar(page).expectNoHost();

        // The popup button's route. With no selection it says so and shows nothing.
        const helper = await openExtensionPage(
          harness.ext.context,
          harness.ext.extensionId,
          'popup',
        );
        const tabId = await tabIdOf(page.url());
        const reply = await send(helper, {
          v: 1,
          type: 'CLAVIS_INJECT_TAB',
          tabId,
          url: page.url(),
        });
        expect(reply).toEqual({ ok: true, shown: true });
        expect(await expectShown(page), 'toolbar for the existing selection').toBe(true);
        await clickAction(page, 'explain');
        expect(await readCardText(page)).toBe('bank');

        // Current tab only: the second tab with the same URL has no observer and no toolbar.
        expect(await observerRunsIn(second, 600)).toBe(false);
        await toolbar(second).expectNoHost();
        await helper.close();
        await second.close();
        await page.close();
      } finally {
        await update({ tooltipBehavior: 'automatic' });
      }
    });

    test('on-demand without a selection: the route injects but shows nothing and says so', async () => {
      await update({ tooltipBehavior: 'on-demand' });
      try {
        const page = await plainPage();
        const helper = await openExtensionPage(
          harness.ext.context,
          harness.ext.extensionId,
          'popup',
        );
        const tabId = await tabIdOf(page.url());
        const reply = await send(helper, {
          v: 1,
          type: 'CLAVIS_INJECT_TAB',
          tabId,
          url: page.url(),
        });
        expect(reply).toEqual({ ok: true, shown: false });
        await toolbar(page).expectNoHost();
        await helper.close();
        await page.close();
      } finally {
        await update({ tooltipBehavior: 'automatic' });
      }
    });

    test('automatic mode is restored: the next page shows the toolbar again', async () => {
      const page = await plainPage();
      expect(await observerRunsIn(page, 5000)).toBe(true);
      await selectText(page, page, WORD, 'dblclick');
      expect(await expectShown(page)).toBe(true);
      await page.close();
    });
  });

  test.describe("FR-015 controls reflect the user's site access", () => {
    test('with access granted the popup does not offer "Explain on this page"', async () => {
      const popup = await openExtensionPage(harness.ext.context, harness.ext.extensionId, 'popup');
      await popup.waitForLoadState('load');
      await popup.waitForTimeout(500);
      await expect(popup.getByRole('button', { name: 'Explain on this page' })).toHaveCount(0);
      await popup.close();
    });
  });

  test.describe("FR-009 / site access matrix: revoke and grant again from Chrome's own switch", () => {
    async function setHostAccess(access: 'ON_CLICK' | 'ON_ALL_SITES'): Promise<void> {
      const page = await harness.ext.context.newPage();
      try {
        await page.goto('chrome://extensions');
        await page.evaluate(
          async ([id, hostAccess]) => {
            const api = (
              chrome as unknown as {
                developerPrivate: { updateExtensionConfiguration(o: object): Promise<void> };
              }
            ).developerPrivate;
            await api.updateExtensionConfiguration({ extensionId: id, hostAccess });
          },
          [harness.ext.extensionId, access] as const,
        );
      } finally {
        await page.close();
      }
    }

    test('revoking stops the toolbar on the next page load; granting again brings it back', async () => {
      await setHostAccess('ON_CLICK');
      try {
        await expect.poll(async () => (await registered()).length, { timeout: 8000 }).toBe(0);
        const revoked = await plainPage();
        expect(await observerRunsIn(revoked, 800), 'no observer without access').toBe(false);
        await selectText(revoked, revoked, WORD, 'dblclick');
        await revoked.waitForTimeout(400);
        await toolbar(revoked).expectNoHost();
        await revoked.close();
      } finally {
        await setHostAccess('ON_ALL_SITES');
      }
      await expect.poll(async () => (await registered()).length, { timeout: 8000 }).toBe(1);
      const granted = await plainPage();
      expect(await observerRunsIn(granted, 6000)).toBe(true);
      await selectText(granted, granted, WORD, 'dblclick');
      expect(await expectShown(granted)).toBe(true);
      await granted.close();
    });
  });

  // ---------------------------------------------------------------- FR-017
  test.describe('FR-017 never transmit text on highlight alone', () => {
    test('selecting, growing, scrolling, dismissing and re-selecting sends nothing to Groq, nothing but the page, and no AI or TTS message to the background', async () => {
      const log = await logWorkerMessages(harness.ext.serviceWorker);
      const groqBefore = harness.groqRequests.length;
      const requestsBefore = harness.allRequests.length;
      const selectedTexts: string[] = [];

      for (const id of ['plain-baseline', 'news-article', 'rtl-arabic']) {
        const fixture = manifest.fixtures.find((f) => f.id === id);
        if (fixture === undefined) throw new Error(id);
        const opened: OpenedFixture = await openPath(
          harness.ext.context,
          harness.server,
          fixture.file,
          fixture,
        );
        try {
          for (const target of fixture.targets.slice(0, 4)) {
            const method =
              target.paragraph !== undefined
                ? 'triple'
                : target.kind === 'word'
                  ? 'dblclick'
                  : 'drag';
            await selectText(
              opened.page,
              opened.page,
              target.paragraph !== undefined
                ? { paragraph: target.paragraph, startsWith: target.startsWith ?? '' }
                : { context: target.context ?? target.text ?? '', text: target.text ?? '' },
              method,
              fixture.forwardKey ?? 'ArrowRight',
            );
            expect(await expectShown(opened.page), `${id}/${target.id}`).toBe(true);
            selectedTexts.push(await opened.page.evaluate(() => getSelection()?.toString() ?? ''));
            await opened.page.mouse.wheel(0, 40);
            await opened.page.keyboard.press('Escape');
            await expectHidden(opened.page);
            await resetPage(opened.page);
          }
        } finally {
          await opened.close();
        }
      }
      await harness.ext.context.waitForEvent('request', { timeout: 300 }).catch(() => undefined);

      expect(harness.groqRequests.slice(groqBefore), 'requests to api.groq.com').toEqual([]);
      const foreign = harness.allRequests
        .slice(requestsBefore)
        .filter(
          (url) => !url.startsWith(harness.server.origin) && !url.startsWith('chrome-extension://'),
        )
        .filter((url) => !/^(data|blob|about):/.test(url));
      expect(foreign, 'requests to anything but the fixture server and the extension').toEqual([]);

      const messages = await log.read();
      const aiOrTts = messages.filter((m) => /^(AI|TTS|EXPLAIN|LISTEN)/i.test(m.type ?? ''));
      expect(aiOrTts, 'AI or TTS messages on selection alone').toEqual([]);
      const carrying = messages.filter((m) =>
        selectedTexts.some(
          (text) =>
            text.trim().length > 2 && m.json.includes(JSON.stringify(text.trim()).slice(1, -1)),
        ),
      );
      expect(carrying, 'a message carrying selected text').toEqual([]);
      expect(
        messages.filter((m) => m.fromTab),
        'any message from a page at all',
      ).toEqual([]);
    });

    test('Listen never calls Groq', async () => {
      const groqBefore = harness.groqRequests.length;
      const page = await plainPage();
      await selectText(page, page, WORD, 'dblclick');
      expect(await expectShown(page)).toBe(true);
      await clickAction(page, 'listen');
      await page.waitForTimeout(500);
      expect(harness.groqRequests.slice(groqBefore)).toEqual([]);
      await page.close();
    });

    test('control: the request tracker does see a Groq request made by the service worker', async () => {
      const before = harness.groqRequests.length;
      // Offline: the request is observed, then refused before it leaves the machine.
      await harness.ext.context.route('https://api.groq.com/**', (route) => route.abort());
      await harness.ext.serviceWorker.evaluate(() =>
        fetch('https://api.groq.com/openai/v1/models').catch(() => null),
      );
      await expect.poll(() => harness.groqRequests.length).toBeGreaterThan(before);
    });
  });

  test('the toolbar host is on the page only after a selection (nothing before)', async () => {
    const page = await plainPage();
    expect(await observerRunsIn(page, 5000)).toBe(true);
    await page.waitForTimeout(300);
    await toolbar(page).expectNoHost();
    expect(await hostShown(page)).toBe(false);
    await page.close();
  });
});

// ------------------------------------------------------------------ declined build
test.describe('site access declined (FR-015, FR-018, UJ-02b)', () => {
  let harness: Harness;

  test.beforeAll(async () => {
    harness = await startHarness({ grantedSiteAccess: false });
  });
  test.afterAll(async () => {
    await harness?.close();
  });

  test('nothing is registered or injected: selecting text shows no automatic toolbar', async () => {
    expect(
      await harness.ext.serviceWorker.evaluate(
        `chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })`,
      ),
    ).toBe(false);
    expect(
      await harness.ext.serviceWorker.evaluate('chrome.scripting.getRegisteredContentScripts()'),
    ).toEqual([]);
    const opened = await openPath(harness.ext.context, harness.server, PLAIN, undefined, {
      noObserver: true,
    });
    try {
      expect(await observerRunsIn(opened.page, 600)).toBe(false);
      await selectText(opened.page, opened.page, WORD, 'dblclick');
      await opened.page.waitForTimeout(500);
      await toolbar(opened.page).expectNoHost();
    } finally {
      await opened.close();
    }
  });

  test('the toolbar-icon path is offered: the popup shows "Explain on this page"', async () => {
    const popup = await openExtensionPage(harness.ext.context, harness.ext.extensionId, 'popup');
    await expect(popup.getByRole('button', { name: 'Explain on this page' })).toBeVisible();
    await popup.close();
  });

  test('without an activeTab grant (no real icon or menu gesture) the injection route refuses cleanly and injects nothing', async () => {
    const opened = await openPath(harness.ext.context, harness.server, PLAIN, undefined, {
      noObserver: true,
    });
    try {
      await selectText(opened.page, opened.page, WORD, 'dblclick');
      await opened.page.bringToFront();
      const tabId = await activeTabId(harness.ext.serviceWorker);
      const helper = await openExtensionPage(harness.ext.context, harness.ext.extensionId, 'popup');
      const reply = await send(helper, {
        v: 1,
        type: 'CLAVIS_INJECT_TAB',
        tabId,
        url: opened.page.url(),
      });
      expect(reply).toEqual({ ok: false, reason: 'no-access' });
      await toolbar(opened.page).expectNoHost();
      await helper.close();
    } finally {
      await opened.close();
    }
  });

  test('a web page cannot reach the injection routes', async () => {
    const opened = await openPath(harness.ext.context, harness.server, PLAIN, undefined, {
      noObserver: true,
    });
    try {
      const reachable = await opened.page.evaluate(
        () =>
          typeof (window as unknown as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome
            ?.runtime?.sendMessage,
      );
      expect(reachable).not.toBe('function');
    } finally {
      await opened.close();
    }
  });
});

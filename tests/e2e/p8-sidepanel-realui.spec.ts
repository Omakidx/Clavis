import { expect, test, type Page } from '@playwright/test';
import { CARD, cardOf, startCardHarness, type CardHarness } from './p5-card-support/harness';
import {
  contentOrigin,
  moveAndClick,
  realUiEnabled,
  screenshotRoot,
} from './spike-b-support/native-ui';
import { dblclickText } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import { panelOptions, realPanelUrls, tabIdOf } from './p8-sidepanel-support/panel';

// Phase 8 (FR-042) with the REAL side panel: real Chromium, a real mouse (xdotool) pressing the
// card's "Open in side panel" button, which lives in a content script's closed shadow root. Proves
// the gesture reaches chrome.sidePanel.open() through the router, and that the real (tab-less)
// panel can ask for its hand-off and draw it.
//
//   npm run build   # or WXT_OUT_DIR=.output-p8-explain, with CLAVIS_EXTENSION_DIR pointing at it
//   CLAVIS_E2E_REAL_UI=1 xvfb-run -a -s "-screen 0 1920x1080x24" \
//     npx playwright test tests/e2e/p8-sidepanel-realui.spec.ts --workers=1
test.skip(!realUiEnabled, 'opt-in: set CLAVIS_E2E_REAL_UI=1 and run under xvfb-run -a');

let h: CardHarness;
test.beforeAll(async () => {
  h = await startCardHarness({ headed: true });
});
test.afterAll(async () => {
  await h?.close();
});

/** Real mouse click on an element of the card (closed shadow root): screen coordinates via xdotool. */
async function realClickCard(page: Page, selector: string): Promise<void> {
  const box = await cardOf(page).toolbar.box(selector);
  const origin = await contentOrigin(page);
  moveAndClick(origin.x + box.x + box.width / 2, origin.y + box.y + box.height / 2);
}

test('a real click on Open in side panel opens the real panel for this tab, and it shows the explanation', async () => {
  const { page, dispose } = await h.open();
  try {
    await page.bringToFront();
    await page.waitForTimeout(500);
    await dblclickText(page, page, 'cartographer');
    await tb(page).waitShown();
    await tb(page).click('explain');
    const card = cardOf(page);
    await card.waitFor(CARD.ready('core'));
    const tabId = await tabIdOf(h.ext.serviceWorker, page);
    h.groq.reset();

    await realClickCard(page, CARD.sidePanel);
    await expect
      .poll(() => card.text(CARD.live), { timeout: 10_000 })
      .toBe('Opened in the side panel.');
    await expect
      .poll(() => realPanelUrls(h.ext.serviceWorker))
      .toEqual([expect.stringMatching(new RegExp(`/sidepanel\\.html\\?tab=${tabId}$`))]);
    expect(await panelOptions(h.ext.serviceWorker, tabId)).toMatchObject({ enabled: true });

    // The real panel is a tab-less extension page. Chrome may or may not hand it to Playwright as a
    // page; when it does, read it, otherwise fall back to the worker's view of its contexts.
    const panelPage = await expect
      .poll(
        () => h.ext.context.pages().find((p) => p.url().includes('/sidepanel.html')) !== undefined,
        { timeout: 5000 },
      )
      .toBe(true)
      .then(
        () => h.ext.context.pages().find((p) => p.url().includes('/sidepanel.html')),
        () => undefined,
      );
    if (panelPage !== undefined) {
      await expect(panelPage.getByTestId('panel-selected')).toHaveText('cartographer');
      await expect(panelPage.getByTestId('panel-section').first()).toContainText(
        'We sat on the bank.',
      );
    }
    // Nothing was sent to Groq by opening the panel.
    expect(h.groq.calls).toEqual([]);
    // The real panel is not a Playwright page; keep a screenshot of the screen as evidence.
    if (panelPage === undefined) {
      await page.waitForTimeout(1500);
      screenshotRoot(test.info().outputPath('real-side-panel.png'));
    }
  } finally {
    await dispose();
  }
});

test('a hand-off sent by a script long after any click does not open a panel (no user gesture)', async () => {
  const { page, world, dispose } = await h.open('article.html?second=1');
  try {
    await page.bringToFront();
    await page.waitForTimeout(500);
    const tabId = await tabIdOf(h.ext.serviceWorker, page);
    // A compromised content script can send the message itself. Chrome keeps a user gesture for
    // about five seconds; with none, sidePanel.open() refuses and the worker forgets the hand-off.
    await page.waitForTimeout(6000);
    const reply = await world.evaluate<{ ok: boolean; error?: { code: string } }>(`
      chrome.runtime.sendMessage({
        v: 1,
        type: 'OPEN_SIDE_PANEL',
        handoff: {
          snapshot: {
            selectionId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
            source: 'webpage',
            kind: 'word',
            text: 'forged',
          },
          results: [
            {
              requestId: '9b2f5c1e-7d1a-4c8e-8b57-2f6a1e4d9c10',
              mode: 'core',
              title: 'forged',
              summary: 'forged',
              provider: 'groq',
              model: 'openai/gpt-oss-20b',
            },
          ],
        },
      })
    `);
    expect(reply).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect((await panelOptions(h.ext.serviceWorker, tabId)).enabled).not.toBe(true);
    const panel = await h.ext.context.newPage();
    await panel.goto(`chrome-extension://${h.ext.extensionId}/sidepanel.html?tab=${tabId}`);
    await expect(panel.getByTestId('panel-empty')).toBeVisible();
    await expect(panel.getByText('forged')).toHaveCount(0);
    await panel.close();
  } finally {
    await dispose();
  }
});

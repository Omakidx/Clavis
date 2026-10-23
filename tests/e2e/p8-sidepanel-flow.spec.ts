import { expect, test } from '@playwright/test';
import { clavisKeys, readStorage } from './p3-support/background';
import {
  CARD,
  explainWord,
  selectWord,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';
import { machineHasVoices } from './p7-reader-support/ai';
import { openPanelPage, panelOptions, realPanelUrls, tabIdOf } from './p8-sidepanel-support/panel';
import { tb } from './spike-b-support/toolbar';

// Phase 8, FR-042: "Open in side panel" from the card of a web page, in the BUILT extension. The
// card (content script, closed shadow root) sends the hand-off to the service worker on a trusted
// click; the worker holds it by tab and opens a per-tab panel. Groq is answered by the test with a
// fake gsk_TEST key. The panel page is also opened as an ordinary tab so locators can read it.
let h: CardHarness;
test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => {
  h = await startCardHarness();
});
test.afterAll(async () => {
  await h?.close();
});

const panelSections = (panel: import('@playwright/test').Page) =>
  panel.getByTestId('panel-section');

test('the card opens a PER-TAB panel and hands over what it loaded; opening it sends nothing', async () => {
  const { page, dispose } = await h.open();
  try {
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    await card.click(CARD.tab('etymology'));
    await card.waitFor(CARD.ready('etymology'));
    const tabId = await tabIdOf(h.ext.serviceWorker, page);
    h.groq.reset();

    await card.click(CARD.sidePanel);
    await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');

    // Chrome really created a panel, for this tab only (path carries the tab id).
    expect(await realPanelUrls(h.ext.serviceWorker)).toEqual([
      expect.stringMatching(new RegExp(`/sidepanel\\.html\\?tab=${tabId}$`)),
    ]);
    expect(await panelOptions(h.ext.serviceWorker, tabId)).toMatchObject({
      enabled: true,
      path: `sidepanel.html?tab=${tabId}`,
    });

    const panel = await openPanelPage(h.ext.context, h.ext.extensionId, tabId);
    await expect(panel.getByTestId('panel-selected')).toHaveText('cartographer');
    await expect(panel.getByRole('heading', { level: 1 })).toHaveText('Clavis explanation');
    await expect(panelSections(panel)).toHaveCount(3);
    await expect(panelSections(panel).nth(0)).toHaveAttribute('data-status', 'ready');
    await expect(panelSections(panel).nth(1)).toHaveAttribute('data-status', 'ready');
    await expect(panelSections(panel).nth(2)).toHaveAttribute('data-status', 'idle');
    await expect(panelSections(panel).nth(0)).toContainText('We sat on the bank.');
    await expect(panelSections(panel).nth(1)).toContainText('From Old Norse banki');
    // Opening cost nothing: no request to Groq at all (D-05, FR-017).
    await panel.waitForTimeout(400);
    expect(h.groq.calls).toEqual([]);

    // The remaining mode loads only when asked: one request, with the card's context.
    await panelSections(panel).nth(2).getByTestId('panel-load').click();
    await expect(panelSections(panel).nth(2)).toHaveAttribute('data-status', 'ready');
    expect(h.groq.chats()).toHaveLength(1);
    expect(h.groq.chats()[0]?.body?.messages[1]?.content).toContain('(mode: related_words)');
    expect(h.groq.chats()[0]?.body?.messages[1]?.content).toContain('cartographer');
    await expect(panelSections(panel).nth(2)).toContainText('shore');

    // The card still works and its tabs were not touched by what the panel loaded.
    expect(await card.status('related_words')).toBe('idle');

    // Another tab's panel has nothing of this tab's explanation.
    const other = await h.open('article.html?other=1');
    try {
      const otherId = await tabIdOf(h.ext.serviceWorker, other.page);
      const otherPanel = await openPanelPage(h.ext.context, h.ext.extensionId, otherId);
      await expect(otherPanel.getByTestId('panel-empty')).toBeVisible();
      await expect(otherPanel.getByText('cartographer')).toHaveCount(0);
      await otherPanel.close();
    } finally {
      await other.dispose();
    }

    // The explanation lives in the worker's memory only: nothing in extension storage.
    for (const area of ['local', 'session'] as const) {
      expect(JSON.stringify(await readStorage(h.ext.serviceWorker, area))).not.toContain(
        'cartographer',
      );
      expect(await clavisKeys(h.ext.serviceWorker, area)).not.toContain('clavis.sidepanel');
    }
    await panel.close();
  } finally {
    await dispose();
  }
});

test('a new selection and a second press update an open panel; leaving the page empties it', async () => {
  const { page, dispose } = await h.open();
  try {
    let card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    const tabId = await tabIdOf(h.ext.serviceWorker, page);
    await card.click(CARD.sidePanel);
    await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
    const panel = await openPanelPage(h.ext.context, h.ext.extensionId, tabId);
    await expect(panel.getByTestId('panel-selected')).toHaveText('cartographer');

    // Another word, another card, the panel follows without being reopened.
    await page.bringToFront();
    await page.waitForTimeout(400);
    await selectWord(page, 'bank');
    await tb(page).click('explain');
    card = (await import('./p5-card-support/harness')).cardOf(page);
    await card.waitFor(CARD.ready('core'));
    await page.waitForTimeout(400);
    await card.click(CARD.sidePanel);
    await expect(panel.getByTestId('panel-selected')).toHaveText('bank');
    await expect(panel.getByText('Now showing the explanation of bank.')).toBeAttached();

    // The tab loads another page: the panel's explanation no longer belongs to it.
    await page.goto(`${h.server.origin}/long.html`);
    await expect(panel.getByTestId('panel-empty')).toBeVisible();
    await expect(panel.getByTestId('panel-empty')).toContainText('select it again');
    await panel.close();
  } finally {
    await dispose();
  }
});

test('a panel with nothing waiting (worker restarted, never opened from a card) says to select again', async () => {
  const { page, dispose } = await h.open();
  try {
    const tabId = await tabIdOf(h.ext.serviceWorker, page);
    const panel = await openPanelPage(h.ext.context, h.ext.extensionId, tabId);
    await expect(panel.getByTestId('panel-empty')).toContainText('Open in side panel');
    await expect(panel.getByTestId('panel-empty')).toContainText('select it again');
    // Opened without a tab in its path: still just the empty state, no error.
    const bare = await h.ext.context.newPage();
    await bare.goto(`chrome-extension://${h.ext.extensionId}/sidepanel.html`);
    await expect(bare.getByTestId('panel-empty')).toBeVisible();
    await panel.close();
    await bare.close();
  } finally {
    await dispose();
  }
});

test('Listen in the panel speaks only the selected text; without a voice it says so', async () => {
  test.skip(await machineHasVoices(h.ext.context, h.ext.extensionId), 'this machine has voices');
  const { page, dispose } = await h.open();
  try {
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    const tabId = await tabIdOf(h.ext.serviceWorker, page);
    await card.click(CARD.sidePanel);
    await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
    const panel = await openPanelPage(h.ext.context, h.ext.extensionId, tabId);
    h.groq.reset();
    await panel.getByTestId('panel-listen').click();
    await expect(panel.getByTestId('panel-listen-status')).toContainText(
      "Voice isn't available on this device.",
    );
    await expect(panel.getByRole('button', { name: 'Voice settings' })).toBeVisible();
    // Listen never touches Groq.
    expect(h.groq.calls).toEqual([]);
    await panel.close();
  } finally {
    await dispose();
  }
});

test('a web page cannot open, frame or fetch the panel', async () => {
  const { page, dispose } = await h.open();
  try {
    const outcome = await page.evaluate(async (id) => {
      try {
        const response = await fetch(`chrome-extension://${id}/sidepanel.html?tab=1`);
        return `fetched ${response.status}`;
      } catch (error) {
        return `blocked ${(error as Error).name}`;
      }
    }, h.ext.extensionId);
    expect(outcome).toMatch(/^blocked/);
  } finally {
    await dispose();
  }
});

// Last: a 401 marks the stored key invalid for every later test of this profile.
test('the panel reports provider problems like the card: Update key opens Settings at the key section', async () => {
  const { page, dispose } = await h.open();
  try {
    const card = await explainWord(page, 'cartographer');
    await card.waitFor(CARD.ready('core'));
    const tabId = await tabIdOf(h.ext.serviceWorker, page);
    await card.click(CARD.sidePanel);
    await expect.poll(() => card.text(CARD.live)).toBe('Opened in the side panel.');
    const panel = await openPanelPage(h.ext.context, h.ext.extensionId, tabId);
    h.groq.chatStatus.current = 401;
    await panelSections(panel).nth(1).getByTestId('panel-load').click();
    const error = panelSections(panel).nth(1).getByTestId('panel-error');
    await expect(error).toHaveAttribute('data-code', 'INVALID_API_KEY');
    const opened = h.ext.context.waitForEvent('page');
    await error.getByRole('button', { name: 'Update key' }).click();
    const settings = await opened;
    await expect.poll(() => settings.url()).toMatch(/options\.html#section-key$/);
    await settings.close();
    await panel.close();
  } finally {
    h.groq.chatStatus.current = undefined;
    await dispose();
  }
});

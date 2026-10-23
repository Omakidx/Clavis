import { expect, test, type Page } from '@playwright/test';
import { send } from './p3-support/background';
import {
  CARD,
  cardOf,
  selectWord,
  startCardHarness,
  type CardHarness,
} from './p5-card-support/harness';
import { tabIdOf } from './p8-sidepanel-support/panel';
import { SEL, tb } from './spike-b-support/toolbar';

// FR-018 (decision O-1): the context menu item and the popup's "Explain on this page" start Explain
// for the current selection, so the card opens with the core request (or the first-send question).
// The popup's route is driven here from an extension page; the real context menu and toolbar icon
// are in spike-b-real-ui, p4-matrix-realui and p8-accept-realui (xvfb). Alt+Shift+E keeps opening
// the toolbar with focus on Listen (lib/site-access/injection.ts handleCommand).
test.describe.configure({ mode: 'serial' });

async function askFromPopup(h: CardHarness, page: Page): Promise<void> {
  const tabId = await tabIdOf(h.ext.serviceWorker, page);
  const popup = await h.ext.context.newPage();
  await popup.goto(`chrome-extension://${h.ext.extensionId}/popup.html`);
  const reply = await send(popup, {
    v: 1,
    type: 'CLAVIS_INJECT_TAB',
    tabId,
    url: page.url(),
  });
  expect(reply).toMatchObject({ ok: true, shown: true });
  await popup.close();
}

test('with the question already answered: the card opens and sends exactly one core request', async () => {
  const h = await startCardHarness();
  try {
    const { page, dispose } = await h.open();
    try {
      await selectWord(page, 'cartographer');
      await page.waitForTimeout(300);
      expect(h.groq.chats()).toHaveLength(0);
      await askFromPopup(h, page);
      const card = cardOf(page);
      await card.waitFor(CARD.ready('core'));
      expect(h.groq.chats()).toHaveLength(1);
      expect(h.groq.chats()[0]?.body?.messages[1]?.content).toContain('(mode: core)');
      expect(await card.text(CARD.text)).toBe('cartographer');
      // Nothing is focused by this path (a mouse path), and the toolbar is still there.
      expect(await tb(page).isShown(SEL.toolbar)).toBe(true);
      expect(await card.focused()).toBeNull();
    } finally {
      await dispose();
    }
  } finally {
    await h.close();
  }
});

test('before the first send was confirmed: the card asks, nothing is sent, and nothing is acknowledged for the user', async () => {
  const h = await startCardHarness({ acknowledged: false });
  try {
    const { page, dispose } = await h.open();
    try {
      await selectWord(page, 'cartographer');
      await askFromPopup(h, page);
      const card = cardOf(page);
      await card.waitFor(CARD.disclosure);
      await page.waitForTimeout(700);
      expect(h.groq.chats()).toHaveLength(0);
      const settings = await send(h.options, { v: 1, type: 'GET_SETTINGS' });
      expect(settings?.data?.onboarding?.['disclosureAcceptedAt']).toBeNull();
      // Only a real click in the card confirms, and then exactly one request goes out.
      await card.click(CARD.confirm);
      await card.waitFor(CARD.ready('core'));
      expect(h.groq.chats()).toHaveLength(1);
    } finally {
      await dispose();
    }
  } finally {
    await h.close();
  }
});

test('with no selection the popup path shows nothing and sends nothing', async () => {
  const h = await startCardHarness();
  try {
    const { page, dispose } = await h.open();
    try {
      const tabId = await tabIdOf(h.ext.serviceWorker, page);
      const popup = await h.ext.context.newPage();
      await popup.goto(`chrome-extension://${h.ext.extensionId}/popup.html`);
      const reply = await send(popup, { v: 1, type: 'CLAVIS_INJECT_TAB', tabId, url: page.url() });
      expect(reply).toMatchObject({ ok: true, shown: false });
      await page.waitForTimeout(400);
      expect(h.groq.chats()).toHaveLength(0);
      await popup.close();
    } finally {
      await dispose();
    }
  } finally {
    await h.close();
  }
});

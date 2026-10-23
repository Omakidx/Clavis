import { expect, test } from '@playwright/test';
import { openExtensionPage } from './p3-support/background';
import { CARD, cardOf } from './p5-card-support/harness';
import {
  finishAudio,
  installScriptedTts,
  listenOf,
  scriptedCalls,
} from './p6-listen-support/listen';
import { ACCEPT_KEY, openWebpage, startWorld, type World } from './p8-accept-support/world';
import { dblclickText } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';
import { installLedger, type Ledger } from './p9-support/ledger';
import { walkOnboardingAccessAlreadyGranted } from './p9-support/onboarding';
import { pause } from './p9-support/card';

// Phase 9, "E2E tests for full setup -> grant site access -> highlight -> Listen -> Explain -> open
// tab -> dismiss" (UJ-01, UJ-02, success measure "First-run setup"). A brand-new profile, the
// PRODUCTION build, the real welcome wizard (typed key, Connect), a real mouse selection on a web
// page, Listen through a (scripted) voice, Explain, a lazy tab, and dismiss, with the request ledger
// counting everything. Chrome's own permission prompt is the one step headless Chromium cannot
// click: the manifest copy lists the optional origins as granted (the established stand-in); the
// prompt itself is clicked for real in p8-accept-realui.spec.ts (journey 1, xvfb).
//
// With access already granted the wizard's access step says so and lets the person go on (Q3,
// fixed; p9-onboarding-access.spec.ts). Everything is the person's path.

test.describe.configure({ timeout: 90_000 });

let world: World;
let ledger: Ledger;
test.beforeAll(async () => {
  world = await startWorld({ granted: true });
  ledger = await installLedger(world.ext.context);
});
test.afterAll(async () => {
  await world?.close();
});

test('new profile: setup, site access, highlight, Listen, Explain, a second tab, dismiss', async () => {
  // ---- setup ------------------------------------------------------------------------------------
  const settings = await openExtensionPage(world.ext.context, world.ext.extensionId, 'options');
  await walkOnboardingAccessAlreadyGranted(world.onboarding, settings, ACCEPT_KEY);
  await settings.close();
  expect(ledger.models()).toHaveLength(1);
  expect(ledger.chats()).toHaveLength(0);
  await installScriptedTts(world.ext.serviceWorker);

  // ---- highlight: the toolbar appears by itself and sends nothing ------------------------------------
  const { page, dispose } = await openWebpage(world);
  await page.bringToFront();
  const mark = ledger.mark();
  await dblclickText(page, page, 'cartographer');
  await tb(page).waitShown();
  await pause(600);
  expect(ledger.since(mark)).toEqual([]);

  // ---- Listen: the voice speaks the word, the card of Explain is not needed, nothing is sent --------
  await listenOf(page).click('listen');
  await expect.poll(async () => (await scriptedCalls(world.ext.serviceWorker)).length).toBe(1);
  expect((await scriptedCalls(world.ext.serviceWorker))[0]?.chars).toBe('cartographer'.length);
  await finishAudio(world.ext.serviceWorker);
  expect(ledger.since(mark)).toEqual([]);

  // ---- Explain: one request; a lazy tab: one more ------------------------------------------------------
  await tb(page).click('explain');
  const card = cardOf(page);
  await card.waitFor(CARD.ready('core'));
  expect(ledger.chats(mark)).toHaveLength(1);
  await card.click(CARD.tab('etymology'));
  await card.waitFor(CARD.ready('etymology'));
  expect(ledger.chats(mark)).toHaveLength(2);
  // Back to the first tab: served from memory.
  await card.click(CARD.tab('core'));
  await pause(300);
  expect(ledger.chats(mark)).toHaveLength(2);

  // ---- dismiss: Escape closes the card and the toolbar; nothing remains ------------------------------
  await page.keyboard.press('Escape');
  await tb(page).waitHidden();
  expect(await card.exists(CARD.card).catch(() => false)).toBe(false);
  await pause(500);
  expect(ledger.chats(mark)).toHaveLength(2);
  expect(ledger.blocked).toEqual([]);
  await dispose();
});

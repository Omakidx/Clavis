import { expect, test, type Page } from '@playwright/test';
import { CARD, cardOf } from './p5-card-support/harness';
import { openPanelPage, panelOptions, tabIdOf } from './p8-sidepanel-support/panel';
import { tagAnswers } from './p8-accept-support/answers';
import { walkOnboarding } from './p8-accept-support/onboarding';
import { startWorld, type World } from './p8-accept-support/world';
import {
  contentOrigin,
  moveAndClick,
  realUiEnabled,
  rightClickBox,
  xdotool,
} from './spike-b-support/native-ui';
import { dblclickText, textBox } from './spike-b-support/page';
import { tb } from './spike-b-support/toolbar';

// Phase 9 audit I6, with Chrome's REAL activeTab grant (the native context menu): the user declined
// all-sites access, so the only host access is the temporary one the right-click item grants.
// Question: does a same-document navigation (history.pushState, a single-page app's route change)
// still reach tabs.onUpdated WITH its `url` under activeTab alone, so the side-panel hand-off is
// dropped (lib/router/register.ts)? Opt in; one worker; a display is needed:
//
//   CLAVIS_E2E_REAL_UI=1 CLAVIS_EXTENSION_DIR=.output-p9-fix/chrome-mv3 \
//     xvfb-run -a -s "-screen 0 1920x1080x24" npx playwright test \
//     tests/e2e/p9fix-i6-activetab-navigation.spec.ts --workers=1
test.skip(!realUiEnabled, 'opt-in: set CLAVIS_E2E_REAL_UI=1 and run under xvfb-run -a');
test.describe.configure({ timeout: 120_000 });

let world: World;
test.beforeAll(async () => {
  world = await startWorld({ granted: false, headed: true });
  await tagAnswers(world.ext.context);
});
test.afterAll(async () => {
  await world?.close();
});

async function realClickCard(page: Page, selector: string): Promise<void> {
  const box = await cardOf(page).toolbar.box(selector);
  const origin = await contentOrigin(page);
  moveAndClick(origin.x + box.x + box.width / 2, origin.y + box.y + box.height / 2);
}

test('activeTab only: a same-document navigation reports its url to tabs.onUpdated and empties the side-panel hand-off', async () => {
  await walkOnboarding(world.onboarding, world.ext.context, { access: 'skip', key: 'connect' });
  const worker = world.ext.serviceWorker;
  // Record every tabs.onUpdated notification exactly as Chrome delivers it to this extension.
  await worker.evaluate(() => {
    const log: { tabId: number; info: Record<string, unknown> }[] = [];
    (globalThis as unknown as { __updates: typeof log }).__updates = log;
    chrome.tabs.onUpdated.addListener((tabId, info) => {
      log.push({ tabId, info: { ...info } });
    });
  });
  const updatesOf = (tabId: number): Promise<Record<string, unknown>[]> =>
    worker.evaluate(
      (id) =>
        (
          globalThis as unknown as {
            __updates: { tabId: number; info: Record<string, unknown> }[];
          }
        ).__updates
          .filter((u) => u.tabId === id)
          .map((u) => u.info),
      tabId,
    );

  const page = await world.ext.context.newPage();
  await page.goto(`${world.server.origin}/article.html?i6=1`);
  await page.waitForTimeout(500);
  await dblclickText(page, page, 'cartographer');
  await page.waitForTimeout(500);
  await tb(page).expectNoHost();
  // The real native item grants activeTab for this tab and opens the card.
  await rightClickBox(page, await textBox(page, 'cartographer'));
  await page.waitForTimeout(700);
  xdotool('key', 'Up');
  xdotool('key', 'Up');
  xdotool('key', 'Return');
  await tb(page).waitShown();
  const card = cardOf(page);
  await card.waitFor(CARD.ready('core'));
  const tabId = await tabIdOf(worker, page);

  await realClickCard(page, CARD.sidePanel);
  await expect
    .poll(() => card.text(CARD.live), { timeout: 10_000 })
    .toBe('Opened in the side panel.');
  expect(await panelOptions(worker, tabId)).toMatchObject({ enabled: true });
  const panel = await openPanelPage(world.ext.context, world.ext.extensionId, tabId);
  await expect(panel.getByTestId('panel-selected')).toHaveText('cartographer');
  await panel.close();

  // The tab's own page changes its url without loading anything.
  const before = (await updatesOf(tabId)).length;
  await page.evaluate(() => history.pushState({}, '', '/article.html?i6=1&route=2'));
  await expect.poll(async () => (await updatesOf(tabId)).length).toBeGreaterThan(before);
  const after = (await updatesOf(tabId)).slice(before);
  test
    .info()
    .annotations.push({ type: 'onUpdated after pushState', description: JSON.stringify(after) });
  // Chrome reported the new url (activeTab is still granted to this tab) ...
  expect(after.some((info) => typeof info['url'] === 'string')).toBe(true);
  // ... so the hand-off is gone: a panel opened for this tab now has nothing waiting.
  const again = await openPanelPage(world.ext.context, world.ext.extensionId, tabId);
  await expect(again.getByTestId('panel-selected')).toHaveCount(0);
  await again.close();
  await page.close();
});

import { expect, test, type Page } from '@playwright/test';
import { send } from './p3-support/background';
import {
  loadFixture,
  openFixtureReady,
  openReader,
  waitForPhase,
} from './p7-reader-support/helpers';
import { axePage } from './p8-accept-support/axe';
import { setUpKey } from './p8-accept-support/setup';
import { ACCEPT_KEY, startWorld, type World } from './p8-accept-support/world';

// Phase 8, accessibility sweep of every extension page (NFR accessibility, "controls work at 200%
// zoom", FR-016): axe in light and dark at 1000, 360 and 320 px, no horizontal scroll, for each
// step or state a person can reach: onboarding (all eight steps), popup (setup needed, connected,
// no site access, PDF tab), Settings, the practice page and the PDF reader (empty, loaded, damaged,
// password, image-only). The card and the side panel are in p8-accept-a11y.spec.ts.
test.describe.configure({ mode: 'serial', timeout: 240_000 });

const WIDTHS = [1000, 360, 320] as const;
const SCHEMES = ['light', 'dark'] as const;
let world: World;

test.beforeAll(async () => {
  world = await startWorld({ granted: false });
});
test.afterAll(async () => {
  await world?.close();
});

async function sweep(page: Page, label: string): Promise<void> {
  for (const scheme of SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 800 });
      const at = `${label}, ${scheme}, ${width}px`;
      expect(await axePage(page), `axe: ${at}`).toEqual([]);
      const [scroll, client] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      expect(scroll, `horizontal scroll: ${at}`).toBeLessThanOrEqual(client);
    }
  }
}

test('onboarding: every step', async () => {
  const page = world.onboarding;
  const next = page.getByRole('button', { name: 'Next', exact: true });
  await sweep(page, 'onboarding 1 welcome');
  await next.click();
  await sweep(page, 'onboarding 2 disclosure');
  await page.getByRole('button', { name: 'I understand' }).click();
  await next.click();
  await sweep(page, 'onboarding 3 website access');
  await page.getByRole('button', { name: "Not now — I'll use right-click instead" }).click();
  await next.click();
  await sweep(page, 'onboarding 4 get a key');
  await page.getByRole('button', { name: 'I have my key' }).click();
  await sweep(page, 'onboarding 5 connect');
  await page.getByLabel('Your Groq key', { exact: true }).fill(ACCEPT_KEY);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('[data-outcome]')).toHaveAttribute('data-outcome', 'valid', {
    timeout: 20_000,
  });
  await sweep(page, 'onboarding 5 connected');
  await page.getByRole('button', { name: 'Continue' }).click();
  await sweep(page, 'onboarding 6 preferences');
  await next.click();
  await sweep(page, 'onboarding 7 practice');
  await next.click();
  await sweep(page, 'onboarding 8 done, access declined (shows the help)');
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByText('Setup is complete.')).toBeVisible();
  await sweep(page, 'onboarding 8 finished');
});

test('popup: connected, site access off with its help open, and on a tab that looks like a PDF', async () => {
  await setUpKey(world);
  const popup = await world.ext.context.newPage();
  await popup.goto(`chrome-extension://${world.ext.extensionId}/popup.html`);
  await expect(popup.getByTestId('popup-groq')).toHaveText('Connected');
  await sweep(popup, 'popup connected');
  await popup.getByText('Using Clavis without website access').click();
  await sweep(popup, 'popup connected, help open');

  // Key not working.
  const admin = await world.ext.context.newPage();
  await admin.goto(`chrome-extension://${world.ext.extensionId}/options.html`);
  expect((await send(admin, { v: 1, type: 'REMOVE_API_KEY' }))?.ok).toBe(true);
  await admin.close();
  await popup.reload();
  await expect(popup.getByTestId('popup-groq')).toHaveText('Setup needed');
  await sweep(popup, 'popup setup needed');
  await setUpKey(world);

  const pdf = await world.ext.context.newPage();
  await pdf.addInitScript(() => {
    chrome.tabs.query = (() =>
      Promise.resolve([
        { id: 1, url: 'https://example.com/a.pdf' },
      ])) as unknown as typeof chrome.tabs.query;
  });
  await pdf.goto(`chrome-extension://${world.ext.extensionId}/popup.html`);
  await expect(pdf.getByTestId('popup-pdf-help')).toBeVisible();
  await sweep(pdf, 'popup pdf notice');
});

test('Settings: the whole page, and with the sections a person opens', async () => {
  const page = await world.ext.context.newPage();
  await page.goto(`chrome-extension://${world.ext.extensionId}/options.html`);
  await expect(page.getByTestId('voice-counts')).toBeVisible({ timeout: 15_000 });
  await sweep(page, 'settings');
  await page.goto(`chrome-extension://${world.ext.extensionId}/options.html#section-help-pdf`);
  await expect(page.getByTestId('pdf-help')).toBeInViewport();
  await sweep(page, 'settings at the PDF help');
});

test('practice page', async () => {
  const page = await world.ext.context.newPage();
  await page.goto(`chrome-extension://${world.ext.extensionId}/practice.html`);
  await expect(page.getByTestId('practice-result')).toBeVisible();
  await sweep(page, 'practice');
});

test('PDF reader: empty, loaded, damaged, password and image-only', async () => {
  const { page } = await openReader(world.ext.context, world.ext.extensionId);
  await sweep(page, 'reader empty');
  await openFixtureReady(page, 'text-1page.pdf');
  await sweep(page, 'reader loaded');
  await loadFixture(page, 'corrupt.pdf');
  await expect(page.getByTestId('state-error')).toBeVisible();
  await sweep(page, 'reader damaged file');
  await loadFixture(page, 'encrypted.pdf');
  await expect(page.getByTestId('password-prompt')).toBeVisible();
  await sweep(page, 'reader password prompt');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await loadFixture(page, 'image-only.pdf');
  await waitForPhase(page, 'image-only');
  await sweep(page, 'reader image-only');
});

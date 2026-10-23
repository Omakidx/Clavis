import { expect, test, type Page } from '@playwright/test';
import { openExtensionPage, send } from './p3-support/background';
import { startWorld, type World } from './p8-accept-support/world';

// Phase 9, UJ-01 / FR-001 / FR-009 ("Request optional all-sites access during onboarding"): the
// welcome wizard must always be completable. The Phase 8 acceptance report left one situation
// unreproduced and "a risk to check by hand": website access is ALREADY granted when the "Website
// access" step is shown (the person switched Site access to "On all sites" on chrome://extensions
// first, or runs the tutorial again after "Clear all data", which clears Clavis's records but not
// Chrome's permission, or the grant arrives while the step is open).
//
// The `granted` world is exactly that state: Chrome reports the optional origins as granted.

test.describe.configure({ mode: 'serial', timeout: 60_000 });

let world: World;
test.beforeAll(async () => {
  world = await startWorld({ granted: true });
});
test.afterAll(async () => {
  await world?.close();
});

const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true });

async function toAccessStep(page: Page): Promise<void> {
  await next(page).click();
  // The data notice is acknowledged once; a second visit shows it as already confirmed.
  const understand = page.getByRole('button', { name: 'I understand' });
  await understand.or(page.getByText("You've already confirmed this")).waitFor();
  if (await understand.isVisible()) await understand.click();
  await next(page).click();
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(
    'Show Clavis when you select text',
  );
}

test('with website access already granted, the access step says so (no question is asked twice)', async () => {
  await toAccessStep(world.onboarding);
  // Nothing to ask: neither "Enable on websites" nor "Not now" is offered once Chrome says yes.
  await expect(world.onboarding.getByRole('button', { name: 'Enable on websites' })).toHaveCount(0);
  await expect(
    world.onboarding.getByRole('button', { name: "Not now — I'll use right-click instead" }),
  ).toHaveCount(0);
});

// Q3 (Medium; UJ-01, FR-009; found by this suite, fixed in Phase 9): with access already granted the
// step used to show no button, never record the choice and so never offer Next. It now says
// "Website access is on", records "granted" and offers Next.
test('with website access already granted, the access step records it and offers a way forward', async () => {
  const page = await openExtensionPage(world.ext.context, world.ext.extensionId, 'onboarding');
  try {
    await toAccessStep(page);
    await expect(page.getByRole('status')).toContainText('Website access is on');
    // A person who has to continue finds a Next button ...
    await expect(next(page)).toBeVisible({ timeout: 3000 });
    // ... and the choice is on record.
    await expect
      .poll(async () => {
        const reply = (await send(page, { v: 1, type: 'GET_SETTINGS' })) as
          { data?: { onboarding?: { siteAccessChoice?: string } } } | undefined;
        return reply?.data?.onboarding?.siteAccessChoice;
      })
      .toBe('granted');
    await next(page).click();
    await expect(page.getByRole('heading', { level: 2 })).toHaveText(/key/i);
  } finally {
    await page.close();
  }
});

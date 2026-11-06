import { expect, type Page } from '@playwright/test';
import { CANARY } from './secrets';

const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true });

/**
 * Walk the welcome wizard of a profile where website access is ALREADY granted (the manifest-copy
 * stand-in): the "Website access" step then says so and lets the person go on (Phase 9 Q3, fixed).
 * Every step is used exactly as a person uses it, including typing the key into the masked field
 * and pressing Connect. (The p8 `walkOnboarding` asks for the Enable/Not now buttons, which this
 * state rightly does not show, and types its own key; hence this variant.) `_options` is unused,
 * kept so callers need not change.
 */
export async function walkOnboardingAccessAlreadyGranted(
  page: Page,
  _options: Page,
  key: string = CANARY,
): Promise<void> {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome to Clavis');
  await next(page).click();
  await page.getByRole('button', { name: 'I understand' }).click();
  await next(page).click();
  // 3 Website access: already on, so nothing is asked and Next is there.
  await expect(page.getByRole('status')).toContainText('Website access is on');
  await next(page).click();
  // 4 Get and connect a key
  await page.getByLabel('Your Groq key', { exact: true }).fill(key);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.locator('[data-outcome]')).toHaveAttribute('data-outcome', 'valid', {
    timeout: 20_000,
  });
  await page.getByRole('button', { name: 'Continue' }).click();
  // 5 Preferences, 6 Practice, 7 Done
  await next(page).click();
  await next(page).click();
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByText('Setup is complete. You can close this tab.')).toBeVisible();
}

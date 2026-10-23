import { expect, type BrowserContext, type Page } from '@playwright/test';
import { ACCEPT_KEY } from './world';

export interface WalkOptions {
  /** Press "Enable on websites" (the prompt is answered by the stand-in) or the "Not now" button. */
  access: 'enable' | 'skip';
  /** Paste a key and press Connect, or press "Set up later". */
  key: 'connect' | 'later';
  /** Open the practice page from the wizard and return it. */
  practice?: boolean;
  /**
   * Answer Chrome's own permission prompt after "Enable on websites" was pressed (real-UI specs:
   * the prompt cannot be clicked from Playwright). Without it, the stand-in grant answers.
   */
  onPrompt?: () => Promise<void>;
}

export interface WalkResult {
  practice: Page | undefined;
}

const next = (page: Page) => page.getByRole('button', { name: 'Next', exact: true });

/**
 * Walk the welcome wizard the way a new person does, using only what the screens say: every
 * button is found by its visible label, nothing is called directly.
 */
export async function walkOnboarding(
  page: Page,
  context: BrowserContext,
  options: WalkOptions,
): Promise<WalkResult> {
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome to Clavis');

  // 1 Welcome -> 2 Your data (the disclosure must be acknowledged before Next appears)
  await next(page).click();
  await expect(next(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'I understand' }).click();
  await next(page).click();

  // 3 Website access
  if (options.access === 'enable') {
    await page.getByRole('button', { name: 'Enable on websites' }).click();
    if (options.onPrompt !== undefined) {
      await expect(page.getByRole('status')).toContainText('Waiting for your answer');
      await options.onPrompt();
    }
    await expect(page.getByRole('status')).toContainText('Website access is on', {
      timeout: 10_000,
    });
  } else {
    await page.getByRole('button', { name: "Not now — I'll use right-click instead" }).click();
    await expect(page.getByRole('status')).toContainText('Right-click selected text');
  }
  await next(page).click();

  // 4 Get a key, 5 Connect
  await page.getByRole('button', { name: 'I have my key' }).click();
  if (options.key === 'connect') {
    await page.getByLabel('Your Groq key', { exact: true }).fill(ACCEPT_KEY);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.locator('[data-outcome]')).toHaveAttribute('data-outcome', 'valid', {
      timeout: 20_000,
    });
    await page.getByRole('button', { name: 'Continue' }).click();
  } else {
    await page.getByRole('button', { name: 'Set up later' }).click();
  }

  // 6 Preferences (they save as they change; nothing to do), 7 Practice
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Choose your preferences');
  await next(page).click();
  await expect(page.getByRole('heading', { level: 2 })).toHaveText('Try it on a practice page');
  let practice: Page | undefined;
  if (options.practice === true) {
    const opened = context.waitForEvent('page');
    await page.getByRole('link', { name: /Open the practice page/ }).click();
    practice = await opened;
    await practice.waitForLoadState();
  }
  await page.bringToFront();
  await next(page).click();

  // 8 Done
  await expect(page.getByRole('heading', { level: 2 })).toHaveText("You're ready");
  await page.getByRole('button', { name: 'Finish setup' }).click();
  await expect(page.getByText('Setup is complete. You can close this tab.')).toBeVisible();
  return { practice };
}

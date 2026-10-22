import type { BrowserContext, Page } from '@playwright/test';

/** A fake key. Fake keys in tests MUST start with `gsk_TEST` (never a real key). */
export const FAKE_KEY = 'gsk_TESTe2eNotARealKey0000abcd';
export const FAKE_KEY_LAST4 = 'abcd';

export type ExtensionPageName = 'onboarding' | 'options' | 'popup' | 'practice' | 'reader';

export interface TrackedPage {
  page: Page;
  /** Uncaught page errors; every spec asserts this stays empty. */
  errors: string[];
}

/** Open one of the extension's own pages in a new tab, collecting page errors. */
export async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  name: ExtensionPageName,
): Promise<TrackedPage> {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/${name}.html`);
  return { page, errors };
}

/** The install-time onboarding tab is not under test; close it so tabs do not pile up. */
export async function closeInstallTabs(context: BrowserContext, keep: Page[] = []): Promise<void> {
  for (const page of context.pages()) {
    if (!keep.includes(page) && page.url().endsWith('/onboarding.html')) await page.close();
  }
}

/** Text of a page including every input value, to prove a secret is not rendered anywhere. */
export async function visibleTextAndValues(page: Page): Promise<string> {
  return page.evaluate(() => {
    const values = Array.from(document.querySelectorAll('input, textarea')).map(
      (el) => (el as HTMLInputElement).value,
    );
    return `${document.documentElement.outerHTML}\n${document.body.innerText}\n${values.join('\n')}`;
  });
}

/**
 * Walk the onboarding wizard from step 1 to the website-access step: Next, accept the data
 * disclosure ("I understand", skipped if already accepted), Next.
 */
export async function gotoSiteAccessStep(page: Page): Promise<void> {
  const next = page.getByRole('button', { name: 'Next', exact: true });
  await next.click();
  // A profile shared between tests may have acknowledged the disclosure already.
  const understand = page.getByRole('button', { name: 'I understand' });
  await understand.or(page.getByText("You've already confirmed this")).waitFor();
  if (await understand.isVisible()) await understand.click();
  await next.click();
  await page.getByRole('button', { name: 'Enable on websites' }).waitFor();
}

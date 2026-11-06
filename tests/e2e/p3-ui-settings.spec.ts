import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import {
  FAKE_KEY,
  FAKE_KEY_LAST4,
  openExtensionPage,
  visibleTextAndValues,
} from './p3-ui-support/pages';

// Settings in the built extension. Needs the Phase 3 background routes: re-run after integration.

async function connectFakeKey(page: Page, storage: 'local' | 'session' = 'local') {
  await page.getByLabel('Your Groq key', { exact: true }).fill(FAKE_KEY);
  if (storage === 'session')
    await page.getByRole('radio', { name: /Only for this session/ }).check();
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByTestId('key-facts')).toBeVisible({ timeout: 20_000 });
}

async function openGroup(page: Page, name: string) {
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name })
    .click();
}

test.describe('settings page', () => {
  test('connect, show only the last four, then remove the key after confirmation', async ({
    context,
    extensionId,
  }) => {
    const { page, errors } = await openExtensionPage(context, extensionId, 'options');
    await expect(page.getByText('No Groq key is connected.')).toBeVisible();
    await expect(page.getByText(/Clavis does not encrypt your key/).first()).toBeVisible();

    await connectFakeKey(page);
    const facts = page.getByTestId('key-facts');
    await expect(facts).toContainText(`Ending in ${FAKE_KEY_LAST4}`);
    await expect(facts).toContainText('On this device until you remove it');
    expect(await visibleTextAndValues(page)).not.toContain(FAKE_KEY);

    // The saved key survives a reload and is still never rendered.
    await page.reload();
    await expect(page.getByTestId('key-facts')).toContainText(`Ending in ${FAKE_KEY_LAST4}`);
    expect(await visibleTextAndValues(page)).not.toContain('gsk_TESTe2eNotARealKey');

    await page.getByRole('button', { name: 'Remove key' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Remove your Groq key?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByTestId('key-facts')).toBeVisible();

    await page.getByRole('button', { name: 'Remove key' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Remove key' }).click();
    await expect(page.getByText('No Groq key is connected.')).toBeVisible();
    await expect(page.getByText('Your key was removed.')).toBeVisible();
    await page.reload();
    await expect(page.getByText('No Groq key is connected.')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('a session-only key is reported as such', async ({ context, extensionId }) => {
    const { page } = await openExtensionPage(context, extensionId, 'options');
    await connectFakeKey(page, 'session');
    await expect(page.getByTestId('key-facts')).toContainText('Only for this session');
  });

  test('preferences save at once, persist across a reload, and reset to defaults', async ({
    context,
    extensionId,
  }) => {
    const { page, errors } = await openExtensionPage(context, extensionId, 'options');
    await openGroup(page, 'Preferences');
    await page.getByRole('radio', { name: /Simple/ }).check();
    await expect(page.getByText('Saved.').first()).toBeVisible();
    await page.getByRole('radio', { name: 'Slow' }).check();
    await page.getByRole('radio', { name: /Only when I ask/ }).check();
    await page.getByLabel('Explanation language').selectOption('es');
    await expect(page.getByLabel('Explanation language')).toHaveValue('es');

    await page.reload();
    await openGroup(page, 'Preferences');
    await expect(page.getByRole('radio', { name: /Simple/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Slow' })).toBeChecked();
    await expect(page.getByRole('radio', { name: /Only when I ask/ })).toBeChecked();
    await expect(page.getByLabel('Explanation language')).toHaveValue('es');

    await page.getByRole('button', { name: 'Reset to defaults' }).click();
    await expect(page.getByText('Preferences were reset to their defaults.')).toBeVisible();
    await page.reload();
    await openGroup(page, 'Preferences');
    await expect(page.getByRole('radio', { name: /Standard/ })).toBeChecked();
    await expect(page.getByRole('radio', { name: 'Normal' })).toBeChecked();
    await expect(page.getByLabel('Explanation language')).toHaveValue('en');
    expect(errors).toEqual([]);
  });

  test('website access is off by default and the per-site list validates, saves and removes', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openExtensionPage(context, extensionId, 'options');
    await openGroup(page, 'Website access');
    await expect(page.getByTestId('site-access-status')).toContainText('Website access is off');
    await expect(page.getByRole('button', { name: 'Enable on websites' })).toBeVisible();

    const field = page.getByLabel('Website address');
    await field.fill('not a site');
    await page.getByRole('button', { name: 'Add website' }).click();
    await expect(page.getByRole('alert')).toContainText("doesn't look like a website address");
    await field.fill('HTTPS://Shop.Example.com/cart');
    await page.getByRole('button', { name: 'Add website' }).click();
    await expect(page.getByTestId('disabled-sites')).toContainText('shop.example.com');

    await page.reload();
    await openGroup(page, 'Website access');
    await expect(page.getByTestId('disabled-sites')).toContainText('shop.example.com');
    await page.getByRole('button', { name: 'Remove shop.example.com' }).click();
    await expect(page.getByText('No websites are listed.')).toBeVisible();
  });

  test('Clear all data removes the key, preferences and the site list', async ({
    context,
    extensionId,
  }) => {
    const { page, errors } = await openExtensionPage(context, extensionId, 'options');
    await connectFakeKey(page);
    await openGroup(page, 'Preferences');
    await page.getByRole('radio', { name: /Advanced/ }).check();
    await openGroup(page, 'Website access');
    await page.getByLabel('Website address').fill('example.org');
    await page.getByRole('button', { name: 'Add website' }).click();
    await expect(page.getByTestId('disabled-sites')).toContainText('example.org');

    await openGroup(page, 'Privacy & help');
    await page.getByRole('button', { name: 'Clear all data' }).click();
    const dialog = page.getByRole('alertdialog', { name: 'Clear all Clavis data?' });
    await dialog.getByRole('button', { name: 'Clear all data' }).click();
    await expect(page.getByText('All Clavis data was removed from this browser.')).toBeVisible();
    await openGroup(page, 'Connection');
    await expect(page.getByText('No Groq key is connected.')).toBeVisible();

    await page.reload();
    await expect(page.getByText('No Groq key is connected.')).toBeVisible();
    await openGroup(page, 'Preferences');
    await expect(page.getByRole('radio', { name: /Standard/ })).toBeChecked();
    await openGroup(page, 'Website access');
    await expect(page.getByText('No websites are listed.')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the key routes refuse the popup, which may only read status', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openExtensionPage(context, extensionId, 'popup');
    const reply = await page.evaluate(
      () =>
        chrome.runtime.sendMessage({ v: 1, type: 'GET_KEY_STATUS' }) as Promise<{ ok: boolean }>,
    );
    expect(reply.ok).toBe(false);
  });
});

import { expect, test } from './fixtures';
import { FAKE_KEY, openExtensionPage } from './p3-ui-support/pages';

// Popup status in the built extension. Needs GET_AI_STATUS: re-run after integration.

test.describe('popup', () => {
  test('shows setup needed and website access off on a fresh profile, with the fallback button', async ({
    context,
    extensionId,
  }) => {
    const { page, errors } = await openExtensionPage(context, extensionId, 'popup');
    await expect(page.getByTestId('popup-groq')).toHaveText('Setup needed');
    await expect(page.getByTestId('popup-site')).toHaveText('Off');
    await expect(page.getByRole('button', { name: 'Connect Groq' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Explain on this page' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open PDF reader' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Settings' })).toBeVisible();
    const actions = page.getByRole('region', { name: 'Quick actions' });
    await expect(actions.getByRole('button')).toHaveCount(3);
    await expect(actions.getByRole('button', { name: 'Connect Groq' })).toHaveClass(
      /clavis-button--primary/,
    );
    expect(errors).toEqual([]);
  });

  test('the PDF reader button opens the reader in a tab', async ({
    context,
    extensionId,
    serviceWorker,
  }) => {
    const { page } = await openExtensionPage(context, extensionId, 'popup');
    await page.getByRole('button', { name: 'Open PDF reader' }).click();
    // The popup closes itself afterwards, so ask the browser rather than a Playwright page.
    await expect
      .poll(async () =>
        serviceWorker.evaluate(
          `chrome.tabs.query({ url: 'chrome-extension://' + chrome.runtime.id + '/reader.html' }).then((tabs) => tabs.length)`,
        ),
      )
      .toBeGreaterThan(0);
  });

  test('reflects a connected (but rejected) key after Settings saved one', async ({
    context,
    extensionId,
  }) => {
    const options = await openExtensionPage(context, extensionId, 'options');
    await options.page.getByLabel('Your Groq key', { exact: true }).fill(FAKE_KEY);
    await options.page.getByRole('button', { name: 'Connect' }).click();
    await expect(options.page.getByTestId('key-facts')).toBeVisible({ timeout: 20_000 });

    const { page } = await openExtensionPage(context, extensionId, 'popup');
    // Online: Groq answered 401 -> "Key not working". Offline: key saved, disclosure not accepted.
    await expect(page.getByTestId('popup-groq')).toHaveText(
      /Key not working|Review the data notice|Connected/,
    );
    await expect(page.getByTestId('popup-groq')).not.toHaveText('Setup needed');
  });
});

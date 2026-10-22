import { expect, test } from './fixtures';
import { FAKE_KEY, openExtensionPage, visibleTextAndValues } from './p3-ui-support/pages';

// Phase 3 onboarding wizard in the built extension. These need the Phase 3 background routes
// (GET_SETTINGS, ACCEPT_DISCLOSURE, UPDATE_ONBOARDING, SET_API_KEY, ...): re-run after integration.

test.describe('onboarding wizard', () => {
  test('renders every step with a focused heading and the approved disclosure copy', async ({
    context,
    extensionId,
  }) => {
    const { page, errors } = await openExtensionPage(context, extensionId, 'onboarding');
    const heading = page.getByRole('heading', { level: 2 });
    const next = page.getByRole('button', { name: 'Next', exact: true });

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome to Clavis');
    await expect(heading).toHaveText(/Understand and pronounce/);
    await expect(
      page.getByRole('navigation', { name: 'Setup progress' }).getByRole('listitem'),
    ).toHaveCount(8);

    await next.click();
    await expect(heading).toHaveText('Your reading stays on your device until you ask');
    await expect(heading).toBeFocused();
    await expect(
      page.getByText('Listen uses the voices on your computer. Nothing is sent to Groq.'),
    ).toBeVisible();
    await expect(
      page.getByText(/^Explain sends the text you selected, up to 1,000 characters/),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: /Groq privacy policy/ })).toHaveAttribute(
      'href',
      'https://groq.com/privacy-policy/',
    );
    // Next is withheld until the disclosure is acknowledged.
    await expect(next).toHaveCount(0);
    await page.getByRole('button', { name: 'I understand' }).click();
    await expect(page.getByRole('status')).toContainText('Your confirmation was saved');
    await expect(next).toBeFocused();
    await next.click();

    await expect(heading).toHaveText('Show Clavis when you select text');
    await expect(page.getByRole('button', { name: 'Enable on websites' })).toBeVisible();
    await expect(page.getByText(/right-click it and choose Explain with Clavis/)).toBeVisible();
    await page.getByRole('button', { name: /Not now/ }).click();
    await expect(page.getByRole('status')).toContainText('Right-click selected text');
    await next.click();

    await expect(heading).toHaveText('Get your Groq key');
    const link = page.getByRole('link', { name: /Open the Groq keys page/ });
    await expect(link).toHaveAttribute('href', 'https://console.groq.com/keys');
    await expect(link).toHaveAttribute('target', '_blank');
    await page.getByRole('button', { name: 'I have my key' }).click();

    await expect(heading).toHaveText('Connect your Groq key');
    await expect(page.getByLabel('Your Groq key', { exact: true })).toHaveAttribute(
      'type',
      'password',
    );
    await expect(page.getByRole('radio', { name: /Remember on this device/ })).toBeChecked();
    await expect(
      page.getByText('Never paste your key into a website or share it in a chat.'),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Set up later' }).click();

    await expect(heading).toHaveText('Choose your preferences');
    await expect(page.getByLabel('Explanation language')).toBeVisible();
    await expect(page.getByText(/Connect a Groq key to see the models/)).toBeVisible();
    await next.click();

    await expect(heading).toHaveText('Try it on a practice page');
    await expect(page.getByRole('link', { name: /Open the practice page/ })).toHaveAttribute(
      'href',
      '/practice.html',
    );
    await next.click();

    await expect(heading).toHaveText("You're ready");
    await expect(page.getByText(/haven't connected Groq yet/)).toBeVisible();
    await page.getByRole('button', { name: 'Finish setup' }).click();
    await expect(page.getByText('Setup is complete. You can close this tab.')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('the disclosure acknowledgement and the declined access choice persist across a reload', async ({
    context,
    extensionId,
  }) => {
    const { page } = await openExtensionPage(context, extensionId, 'onboarding');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: 'I understand' }).click();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await page.getByRole('button', { name: /Not now/ }).click();
    await expect(page.getByRole('status')).toContainText('Right-click');

    await page.reload();
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('status')).toContainText("You've already confirmed this");
    await expect(page.getByRole('button', { name: 'I understand' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Right-click');
  });

  test('a fake key is shown as rejected (Groq 401) or not verified (offline), and never rendered', async ({
    context,
    extensionId,
  }) => {
    const { page, errors } = await openExtensionPage(context, extensionId, 'onboarding');
    const next = page.getByRole('button', { name: 'Next', exact: true });
    await next.click();
    await page.getByRole('button', { name: 'I understand' }).click();
    await next.click();
    await page.getByRole('button', { name: /Not now/ }).click();
    await next.click();
    await page.getByRole('button', { name: 'I have my key' }).click();

    await page.getByLabel('Your Groq key', { exact: true }).fill(FAKE_KEY);
    // The typed key must not be mirrored into the DOM (an uncontrolled input has no value attribute).
    expect(
      await page.getByLabel('Your Groq key', { exact: true }).getAttribute('value'),
    ).toBeNull();
    expect(await page.evaluate(() => document.documentElement.outerHTML)).not.toContain(FAKE_KEY);
    await page.getByRole('button', { name: 'Show key' }).click();
    await expect(page.getByLabel('Your Groq key', { exact: true })).toHaveAttribute('type', 'text');
    await page.getByRole('button', { name: 'Hide key' }).click();
    await page.getByRole('button', { name: 'Connect' }).click();

    // Online: Groq answers 401 (invalid). Offline: the check cannot run (not verified).
    const result = page.locator('[data-outcome]');
    await expect(result).toBeVisible({ timeout: 20_000 });
    const outcome = await result.getAttribute('data-outcome');
    expect(['invalid', 'unverified']).toContain(outcome);
    if (outcome === 'invalid') await expect(result).toContainText("Groq didn't accept this key");
    else await expect(result).toContainText("couldn't reach Groq");

    expect(await visibleTextAndValues(page)).not.toContain(FAKE_KEY);
    expect(await visibleTextAndValues(page)).not.toContain('gsk_TESTe2eNotARealKey');
    // Whatever the outcome, setup can still continue.
    await expect(page.getByRole('button', { name: 'Continue' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});

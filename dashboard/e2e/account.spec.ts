import { bearerFor, getJson } from './support/api';
import { API_ORIGIN } from './support/stack';
import { expect, routeGoogleAs, signIn, test } from './support/fixtures';

test.describe('account page', () => {
  test('shows email, name and usage; export and delete are disabled', async ({ signedIn }) => {
    const { page, account } = await signedIn({ words: [{ text: 'one' }, { text: 'two', at: 1 }] });
    await page.getByRole('link', { name: 'Account' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeFocused();
    await expect(page.getByText(account.email)).toBeVisible();
    await expect(
      page
        .getByRole('term')
        .filter({ hasText: 'Saved words' })
        .locator('xpath=following-sibling::dd'),
    ).toHaveText('2');
    await expect(page.getByRole('button', { name: 'Export data' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Delete account' })).toBeDisabled();
  });

  test('never calls the export or delete-account endpoints', async ({ signedIn }) => {
    const { page } = await signedIn();
    const seen: string[] = [];
    page.on('request', (r) => seen.push(`${r.method()} ${new URL(r.url()).pathname}`));
    await page.getByRole('link', { name: 'Account' }).click();
    await page
      .getByRole('button', { name: 'Export data' })
      .click({ force: true, trial: false })
      .catch(() => undefined);
    await page
      .getByRole('button', { name: 'Delete account' })
      .click({ force: true })
      .catch(() => undefined);
    expect(seen.filter((s) => /account\/export|DELETE \/v1\/account$/.test(s))).toEqual([]);
  });

  test('Sign out ends the session with the CSRF token and returns to the landing page', async ({
    signedIn,
  }) => {
    const { page } = await signedIn();
    await page.getByRole('link', { name: 'Account' }).click();
    const logout = page.waitForRequest((r) => r.url().endsWith('/auth/logout'));
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    const req = await logout;
    expect(req.method()).toBe('POST');
    expect(req.headers()['x-csrf-token']).toBeTruthy();
    await expect(page).toHaveURL(`${API_ORIGIN}/`);
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
    // The cookie no longer works.
    const session = await page.evaluate(async () => (await fetch('/v1/session')).status);
    expect(session).toBe(401);
    await page.goto('/words');
    await expect(page).toHaveURL(`${API_ORIGIN}/`);
  });

  test('Sign out everywhere confirms, revokes the web session and extension tokens', async ({
    seed,
    page,
  }) => {
    const account = await seed();
    await signIn(page, account.email);
    await page.getByRole('link', { name: 'Account' }).click();
    await page.getByRole('button', { name: 'Sign out everywhere' }).click();
    const dialog = page.getByRole('dialog', { name: 'Sign out everywhere?' });
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(page).toHaveURL(`${API_ORIGIN}/account`);

    await page.getByRole('button', { name: 'Sign out everywhere' }).click();
    await dialog.getByRole('button', { name: 'Sign out everywhere' }).click();
    await expect(page).toHaveURL(`${API_ORIGIN}/`);
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
    expect((await getJson(account.bearer, '/v1/account')).status).toBe(401);
    expect(await page.evaluate(async () => (await fetch('/v1/session')).status)).toBe(401);
  });

  test('the CSRF token is refreshed once if the server rejects it', async ({ signedIn }) => {
    const { page } = await signedIn();
    await page.getByRole('link', { name: 'Account' }).click();
    let first = true;
    await page.route('**/auth/logout', (r) => {
      if (first) {
        first = false;
        return r.fulfill({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { code: 'CSRF_FAILED', message: 'x' } }),
        });
      }
      return r.continue();
    });
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(`${API_ORIGIN}/`);
  });

  test('a different user cannot see this account (sessions are per user)', async ({
    seed,
    page,
    browser,
  }) => {
    const a = await seed({ words: [{ text: 'only-a' }] });
    const b = await bearerFor(`other-${Date.now()}@example.test`);
    expect((await getJson(b, '/v1/words')).status).toBe(200);
    await signIn(page, a.email);
    await expect(page.getByText('only-a', { exact: true })).toBeVisible();
    const ctx = await browser.newContext({ baseURL: API_ORIGIN });
    const p2 = await ctx.newPage();
    await routeGoogleAs(p2, b.email);
    await p2.goto('/');
    await p2.getByRole('link', { name: 'Sign in with Google' }).click();
    await expect(p2).toHaveURL(`${API_ORIGIN}/words`);
    await expect(p2.getByText('only-a', { exact: true })).toHaveCount(0);
    await ctx.close();
  });
});

import { expect, routeGoogleAs, signIn, test } from './support/fixtures';
import { API_ORIGIN } from './support/stack';

test.describe('landing and sign-in', () => {
  test('signed-out landing shows the product line, Google sign-in and the privacy link', async ({
    page,
  }) => {
    const res = await page.goto('/');
    expect(res?.headers()['content-security-policy']).toContain("script-src 'self'");
    await expect(page).toHaveTitle(/Clavis/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('saved words and PDFs');
    const signInLink = page.getByRole('link', { name: 'Sign in with Google' });
    await expect(signInLink).toHaveAttribute('href', '/auth/google/start');
    const privacy = page.getByRole('link', { name: /Privacy policy/ }).first();
    await expect(privacy).toHaveAttribute('rel', 'noopener noreferrer');
    await expect(privacy).toHaveAttribute('target', '_blank');
    await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  });

  test('a failed sign-in shows a message', async ({ page }) => {
    await page.goto('/?signin=failed');
    await expect(page.getByRole('alert')).toContainText('Sign-in did not complete');
  });

  for (const route of ['/words', '/words/' + 'a'.repeat(64), '/documents', '/account']) {
    test(`signed-out ${route.slice(0, 12)} goes back to the landing page`, async ({ page }) => {
      await page.goto(route);
      await expect(page).toHaveURL(`${API_ORIGIN}/`);
      await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
    });
  }

  test('signing in through Google lands on /words, and / then redirects there', async ({
    seed,
    page,
  }) => {
    const account = await seed();
    await signIn(page, account.email);
    await expect(page).toHaveURL(`${API_ORIGIN}/words`);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Saved words' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.goto('/');
    await expect(page).toHaveURL(`${API_ORIGIN}/words`);
  });

  test('unknown routes show a not-found page', async ({ page }) => {
    await page.goto('/nope/nothing');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  });

  test('an unreachable session check offers a retry', async ({ page }) => {
    await page.route('**/v1/session', (r) => r.abort('connectionrefused'));
    await page.goto('/words');
    await expect(page.getByRole('alert')).toContainText('cannot be reached');
    await page.unroute('**/v1/session');
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page).toHaveURL(`${API_ORIGIN}/`); // not signed in: the retry resolved to signed-out
  });
});

test.describe('401 handling', () => {
  test('a session revoked elsewhere sends the page back to the landing page with a notice', async ({
    seed,
    page,
    browser,
  }) => {
    const account = await seed({ words: [{ text: 'gone-soon' }] });
    await signIn(page, account.email);
    await expect(page.getByText('gone-soon', { exact: true })).toBeVisible();

    // Same cookie, another tab signs out: the first page's session is now revoked.
    const other = await browser.newContext({
      baseURL: API_ORIGIN,
      storageState: await page.context().storageState(),
    });
    const otherPage = await other.newPage();
    await otherPage.goto('/account');
    await otherPage.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(otherPage).toHaveURL(`${API_ORIGIN}/`);
    await other.close();

    await page.getByRole('link', { name: 'Documents' }).click();
    await expect(page).toHaveURL(`${API_ORIGIN}/`);
    await expect(page.getByText('Your session has ended')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
  });

  test('signing in again after the session ended works', async ({ seed, page }) => {
    const account = await seed();
    await signIn(page, account.email);
    await page.getByRole('link', { name: 'Account' }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page).toHaveURL(`${API_ORIGIN}/`);
    await routeGoogleAs(page, account.email);
    await page.getByRole('link', { name: 'Sign in with Google' }).click();
    await expect(page).toHaveURL(`${API_ORIGIN}/words`);
  });
});

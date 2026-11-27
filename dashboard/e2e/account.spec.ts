import { readFile, stat } from 'node:fs/promises';
import type { Page } from '@playwright/test';
import { bearerFor, getJson } from './support/api';
import { API_ORIGIN } from './support/stack';
import { expect, routeGoogleAs, signIn, test } from './support/fixtures';

test.describe('account page', () => {
  test('shows email, name and usage; export and delete are enabled', async ({ signedIn }) => {
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
    await expect(page.getByRole('button', { name: 'Delete account' })).toBeEnabled();
    await expect(page.getByText(/coming soon/i)).toHaveCount(0);
  });

  test('the export is a plain download link with a helper note', async ({ signedIn }) => {
    const { page } = await signedIn();
    await page.getByRole('link', { name: 'Account' }).click();
    const link = page.getByRole('link', { name: 'Export data' });
    await expect(link).toHaveAttribute('href', '/v1/account/export');
    await expect(link).toHaveAttribute('download', '');
    await expect(page.getByText(/saved words and their chats/)).toBeVisible();
    await expect(page.getByText(/up to 3 times a day/)).toBeVisible();
  });

  test('Export data downloads a non-empty ZIP', async ({ signedIn }) => {
    const { page } = await signedIn({
      words: [{ text: 'exported', chat: [{ role: 'user', content: 'hi' }] }],
    });
    await page.getByRole('link', { name: 'Account' }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('link', { name: 'Export data' }).click();
    const d = await download;
    expect(d.suggestedFilename()).toMatch(/^clavis-export-\d{4}-\d{2}-\d{2}\.zip$/);
    const path = await d.path();
    const bytes = (await readFile(path)).subarray(0, 4);
    expect(bytes.length).toBe(4);
    expect([bytes[0], bytes[1]]).toEqual([0x50, 0x4b]); // "PK"
    expect((await stat(path)).size).toBeGreaterThan(22);
  });

  test('axe: the account page has no serious violations', async ({ signedIn, axe }) => {
    const { page } = await signedIn();
    await page.getByRole('link', { name: 'Account' }).click();
    await expect(page.getByRole('button', { name: 'Delete account' })).toBeVisible();
    await axe(page);
  });

  test.describe('delete account', () => {
    const MARKER = 'clavis.reauth-delete';
    const CONFIRM_TITLE = /^Delete the Clavis account for /;
    const REAUTH_TITLE = 'Sign in again to delete your account';
    const deleteCalls = (page: Page): string[] => {
      const seen: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'DELETE' && new URL(r.url()).pathname === '/v1/account')
          seen.push(r.url());
      });
      return seen;
    };

    /** Rewrites GET /v1/session so the Google login looks `ageMs` old (the DB timestamp is not reachable here). */
    const setSessionAge = (page: Page, ageMs: number) =>
      page.route('**/v1/session', async (route) => {
        const res = await route.fetch();
        const body = (await res.json()) as Record<string, unknown>;
        await route.fulfill({
          response: res,
          json: { ...body, authenticatedAt: Date.now() - ageMs },
        });
      });
    const freshSession = (page: Page) => setSessionAge(page, 0);
    const staleSession = (page: Page) => setSessionAge(page, 20 * 60_000);

    /** Loads /account with a (stubbed) fresh login and opens the confirmation view. */
    const openConfirm = async (page: Page) => {
      await freshSession(page);
      await page.goto('/account');
      await page.getByRole('button', { name: 'Delete account' }).click();
      const dialog = page.getByRole('dialog', { name: CONFIRM_TITLE });
      await expect(dialog).toBeVisible();
      return dialog;
    };

    /** The real flow: sign-in prompt, Google round trip through the fake Google, back to the confirmation view. */
    const reauthenticate = async (page: Page) => {
      await staleSession(page);
      await page.goto('/account');
      await page.getByRole('button', { name: 'Delete account' }).click();
      const prompt = page.getByRole('dialog', { name: REAUTH_TITLE });
      await expect(prompt).toBeVisible();
      await page.unroute('**/v1/session');
      await prompt.getByRole('button', { name: 'Sign in again to continue' }).click();
      await expect(page).toHaveURL(`${API_ORIGIN}/account`);
      const dialog = page.getByRole('dialog', { name: CONFIRM_TITLE });
      await expect(dialog).toBeVisible();
      return dialog;
    };

    test('typed confirmation gates the button; Cancel and Escape restore focus', async ({
      signedIn,
      axe,
    }) => {
      const { page, account } = await signedIn();
      const deletes = deleteCalls(page);
      const dialog = await openConfirm(page);
      await expect(dialog.getByRole('heading', { level: 2 })).toContainText(account.email);
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await expect(dialog).toContainText('cannot be undone');
      await expect(dialog).toContainText('stored PDFs');
      await expect(dialog).toContainText('Case-sensitive');
      await axe(page);

      const confirm = dialog.getByRole('button', { name: 'Delete my account' });
      const input = dialog.getByLabel('Type DELETE to confirm');
      await expect(confirm).toBeDisabled();
      for (const wrong of ['delete', 'Delete', 'DELETE ', 'DELET']) {
        await input.fill(wrong);
        await expect(confirm).toBeDisabled();
      }
      await input.press('Enter'); // Enter with a wrong value does nothing
      await input.fill('DELETE');
      await expect(confirm).toBeEnabled();

      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Delete account' })).toBeFocused();

      await page.getByRole('button', { name: 'Delete account' }).click();
      await expect(dialog.getByLabel('Type DELETE to confirm')).toHaveValue(''); // reopened empty
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Delete account' })).toBeFocused();
      expect(deletes).toEqual([]);
    });

    test('re-authenticating then deleting removes the account and shows a status', async ({
      seed,
      page,
    }) => {
      const account = await seed({ words: [{ text: 'bye' }] });
      await signIn(page, account.email);
      const dialog = await reauthenticate(page);
      await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
      const req = page.waitForRequest(
        (r) => r.method() === 'DELETE' && new URL(r.url()).pathname === '/v1/account',
      );
      await dialog.getByRole('button', { name: 'Delete my account' }).click();
      const sent = await req;
      expect(sent.headers()['x-csrf-token']).toBeTruthy();
      expect(sent.postDataJSON()).toEqual({ confirm: 'DELETE' });
      await expect(page).toHaveURL(`${API_ORIGIN}/`);
      await expect(
        page.getByRole('status').filter({ hasText: 'Your Clavis account was deleted.' }),
      ).toBeVisible();
      await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
      expect((await getJson(account.bearer, '/v1/account')).status).toBe(401);
      expect(await page.evaluate(async () => (await fetch('/v1/session')).status)).toBe(401);
    });

    test('a failed delete keeps the dialog open with an alert and returns focus to the input', async ({
      signedIn,
    }) => {
      const { page, account } = await signedIn();
      await page.route('**/v1/account', (r) =>
        r.request().method() === 'DELETE'
          ? r.fulfill({
              status: 429,
              contentType: 'application/json',
              body: JSON.stringify({
                error: { code: 'RATE_LIMITED', message: 'x', retryAfterMs: 5000 },
              }),
            })
          : r.continue(),
      );
      const dialog = await openConfirm(page);
      const input = dialog.getByLabel('Type DELETE to confirm');
      await input.fill('DELETE');
      await dialog.getByRole('button', { name: 'Delete my account' }).click();
      await expect(dialog.getByRole('alert')).toContainText('Too many requests');
      await expect(dialog).toBeVisible();
      await expect(input).toHaveValue('DELETE');
      await expect(input).toBeFocused();
      expect((await getJson(account.bearer, '/v1/account')).status).toBe(200);
    });

    test('REAUTH_REQUIRED from the server switches the dialog to the sign-in prompt', async ({
      signedIn,
      axe,
    }) => {
      const { page, account } = await signedIn();
      await page.route('**/v1/account', (r) =>
        r.request().method() === 'DELETE'
          ? r.fulfill({
              status: 403,
              contentType: 'application/json',
              body: JSON.stringify({ error: { code: 'REAUTH_REQUIRED', message: 'x' } }),
            })
          : r.continue(),
      );
      const dialog = await openConfirm(page);
      await dialog.getByLabel('Type DELETE to confirm').fill('DELETE');
      await dialog.getByRole('button', { name: 'Delete my account' }).click();
      const prompt = page.getByRole('dialog', { name: REAUTH_TITLE });
      await expect(prompt).toBeVisible();
      await expect(prompt.getByRole('button', { name: 'Cancel' })).toBeFocused(); // focus moved into the new view
      await expect(prompt).toContainText(account.email);
      await axe(page);
      await prompt.getByRole('button', { name: 'Cancel' }).click();
      await expect(prompt).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Delete account' })).toBeFocused();
      expect((await getJson(account.bearer, '/v1/account')).status).toBe(200);
    });

    test('an ordinary login asks for Google sign-in first and sets a marker', async ({
      signedIn,
      axe,
    }) => {
      const { page } = await signedIn();
      await staleSession(page);
      await page.goto('/account');
      await page.getByRole('button', { name: 'Delete account' }).click();
      const prompt = page.getByRole('dialog', { name: REAUTH_TITLE });
      await expect(prompt.getByRole('button', { name: 'Cancel' })).toBeFocused();
      await expect(prompt.getByLabel('Type DELETE to confirm')).toHaveCount(0);
      await axe(page);
      // Hold the navigation at the start URL to observe the marker and the request.
      await page.route('**/auth/google/start*', (r) =>
        r.fulfill({ status: 200, contentType: 'text/html', body: '<title>held</title>' }),
      );
      const start = page.waitForRequest((r) => r.url().includes('/auth/google/start?reauth=1'));
      await prompt.getByRole('button', { name: 'Sign in again to continue' }).click();
      expect(new URL((await start).url()).search).toBe('?reauth=1');
      expect(await page.evaluate((k) => sessionStorage.getItem(k) !== null, MARKER)).toBe(true);
    });

    test('the real re-auth round trip resumes the dialog once and strips the URL', async ({
      seed,
      page,
    }) => {
      const account = await seed();
      await signIn(page, account.email);
      const dialog = await reauthenticate(page);
      expect(new URL(page.url()).search).toBe('');
      await expect(dialog.getByLabel('Type DELETE to confirm')).toHaveValue('');
      await expect(dialog.getByRole('button', { name: 'Delete my account' })).toBeDisabled();
      expect(await page.evaluate(() => sessionStorage.length)).toBe(0); // marker consumed
      await page.reload(); // single-use: a reload does not reopen the dialog
      await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    });

    test('a stale marker with a plain load of / does not reopen the dialog', async ({
      signedIn,
    }) => {
      const { page } = await signedIn();
      await page.evaluate((k) => sessionStorage.setItem(k, String(Date.now() + 60_000)), MARKER);
      await page.goto('/');
      await expect(page).toHaveURL(`${API_ORIGIN}/words`);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    });

    test('/?reauth=done with the marker reopens the dialog; without it, it does not', async ({
      signedIn,
    }) => {
      const { page } = await signedIn();
      await freshSession(page);
      await page.goto('/?reauth=done');
      await expect(page).toHaveURL(`${API_ORIGIN}/words`);
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await page.evaluate((k) => sessionStorage.setItem(k, String(Date.now() + 60_000)), MARKER);
      await page.goto('/?reauth=done');
      await expect(page).toHaveURL(`${API_ORIGIN}/account`);
      await expect(page.getByRole('dialog', { name: CONFIRM_TITLE })).toBeVisible();
    });

    test('opening /account without a resume clears a leftover marker', async ({ signedIn }) => {
      const { page } = await signedIn();
      await page.evaluate((k) => sessionStorage.setItem(k, String(Date.now() + 60_000)), MARKER);
      await page.goto('/account');
      await expect(page.getByRole('heading', { name: 'Account', level: 1 })).toBeVisible();
      expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    });

    test('a different Google account shows a clear alert and clears the marker', async ({
      signedIn,
      axe,
    }) => {
      const { page, account } = await signedIn();
      await page.evaluate((k) => sessionStorage.setItem(k, String(Date.now() + 60_000)), MARKER);
      await page.goto('/?signin=failed&reason=reauth_mismatch');
      await expect(page).toHaveURL(`${API_ORIGIN}/account`);
      const alert = page.getByRole('alert');
      await expect(alert).toContainText('different account');
      await expect(alert).toContainText(account.email);
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
      await axe(page);
    });

    test('a failed re-auth shows the sign-in failure and clears the marker', async ({
      signedIn,
    }) => {
      const { page } = await signedIn();
      await staleSession(page);
      await page.goto('/account');
      await page.getByRole('button', { name: 'Delete account' }).click();
      await page.unroute('**/v1/session');
      await page.unroute('**/auth/google/start*');
      await page.route('**/auth/google/start*', (r) =>
        r.fulfill({ status: 302, headers: { location: '/?signin=failed' } }),
      );
      await page.getByRole('button', { name: 'Sign in again to continue' }).click();
      await expect(page).toHaveURL(`${API_ORIGIN}/account`);
      await expect(page.getByRole('alert')).toContainText('Sign-in did not complete');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    });

    test('reauth_session (no valid session) shows the session-ended notice', async ({ page }) => {
      await page.goto('/?signin=failed&reason=reauth_session');
      await expect(
        page.getByRole('status').filter({ hasText: 'Your session has ended' }),
      ).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
    });

    test('an expired marker is ignored and cleared', async ({ signedIn }) => {
      const { page } = await signedIn();
      await page.evaluate((k) => sessionStorage.setItem(k, String(Date.now() - 1000)), MARKER);
      await page.goto('/?reauth=done');
      await expect(page).toHaveURL(`${API_ORIGIN}/words`);
      expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    });

    test('works when sessionStorage is unavailable: re-auth navigation still happens', async ({
      signedIn,
    }) => {
      const { page } = await signedIn();
      await page.addInitScript(() => {
        Object.defineProperty(window, 'sessionStorage', {
          get() {
            throw new DOMException('blocked', 'SecurityError');
          },
        });
      });
      await staleSession(page);
      await page.goto('/account');
      await page.getByRole('button', { name: 'Delete account' }).click();
      const prompt = page.getByRole('dialog', { name: REAUTH_TITLE });
      await expect(prompt).toBeVisible();
      await page.route('**/auth/google/start*', (r) =>
        r.fulfill({ status: 200, contentType: 'text/html', body: '<title>held</title>' }),
      );
      const start = page.waitForRequest((r) => r.url().includes('/auth/google/start?reauth=1'));
      await prompt.getByRole('button', { name: 'Sign in again to continue' }).click();
      await start;
    });

    test('the export note explains a failed download', async ({ signedIn }) => {
      const { page } = await signedIn();
      await page.goto('/account');
      await expect(page.getByText(/If a download fails/)).toBeVisible();
    });
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

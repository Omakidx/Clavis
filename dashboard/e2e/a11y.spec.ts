import type { Page } from '@playwright/test';
import { expect, readerTest, test } from './support/fixtures';

const schemes = ['light', 'dark'] as const;

test.describe('axe: signed-out landing', () => {
  for (const scheme of schemes) {
    test(`landing (${scheme})`, async ({ page, axe }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await axe(page);
    });
  }
  test('landing with sign-in failure notice', async ({ page, axe }) => {
    await page.goto('/?signin=failed');
    await expect(page.getByRole('alert')).toBeVisible();
    await axe(page);
  });
});

readerTest.describe('axe: signed-in pages (light and dark)', () => {
  for (const scheme of schemes) {
    readerTest(
      `words list, search results and detail (${scheme})`,
      async ({ rpage: page, axe }) => {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto('/words');
        await expect(page.getByRole('list', { name: 'Saved words' })).toBeVisible();
        await axe(page);
        await page.goto('/words?q=zzz-nothing');
        await expect(page.getByText('No saved words match')).toBeVisible();
        await axe(page);
        await page.goto('/words?q=ephemeral');
        await page.getByRole('link', { name: 'ephemeral' }).click();
        await expect(page.getByTestId('chat-note')).toBeVisible();
        await axe(page);
        await page.getByRole('button', { name: /Open source page/ }).click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await axe(page);
      },
    );

    readerTest(`documents and account (${scheme})`, async ({ rpage: page, axe }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto('/documents');
      await expect(page.getByTestId('quota-bar')).toBeVisible();
      await expect(page.getByRole('list', { name: 'Documents' })).toBeVisible();
      await axe(page);
      await page.getByRole('button', { name: 'Delete document Local only' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await axe(page);
      await page.keyboard.press('Escape');
      await page.goto('/account');
      await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
      await axe(page);
      await page.getByRole('button', { name: 'Sign out everywhere' }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await axe(page);
    });
  }

  readerTest('error and not-found states', async ({ rpage: page, axe }) => {
    await page.goto(`/words/${'c'.repeat(64)}`);
    await expect(page.getByRole('alert')).toBeVisible();
    await axe(page);
    await page.goto('/nowhere');
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
    await axe(page);
  });
});

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

readerTest.describe('responsive: 360px wide', () => {
  readerTest.use({ viewport: { width: 360, height: 740 } });
  for (const path of ['/words', '/words?q=onerror', '/documents', '/account']) {
    readerTest(
      `${path} fits without horizontal scrolling and passes axe`,
      async ({ rpage: page, axe }) => {
        await page.setViewportSize({ width: 360, height: 740 });
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.getByRole('status')).toHaveCount(1); // only the live region: lists have loaded
        expect(await noHorizontalScroll(page)).toBe(true);
        await axe(page);
      },
    );
  }
  readerTest('word detail (long unbreakable text) fits at 360px', async ({ rpage: page, axe }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await page.goto('/words?q=onerror');
    await page.getByRole('link', { name: /onerror/ }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText('onerror');
    expect(await noHorizontalScroll(page)).toBe(true);
    await axe(page);
  });
});

readerTest.describe('keyboard and focus', () => {
  readerTest(
    'route changes move focus to the new page heading; skip link works',
    async ({ rpage: page }) => {
      await page.goto('/words');
      await page.getByRole('link', { name: 'Documents' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeFocused();
      await expect(page).toHaveTitle('Documents · Clavis');
      await page.getByRole('link', { name: 'Account' }).click();
      await expect(page.getByRole('heading', { level: 1, name: 'Account' })).toBeFocused();
      await page.goBack();
      await expect(page.getByRole('heading', { level: 1, name: 'Documents' })).toBeFocused();

      await page.reload();
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page).toHaveURL(/#main$/);
    },
  );

  readerTest(
    'the confirm dialog traps focus, cancels with Escape and restores focus',
    async ({ rpage: page }) => {
      await page.goto('/documents');
      const opener = page.getByRole('button', { name: 'Delete document Local only' });
      await opener.focus();
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Delete this document?' });
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Tab');
        // Focus stays in the dialog, or leaves the page for the browser UI (body); never on the inert page behind.
        expect(
          await page.evaluate(
            () =>
              document.activeElement === document.body ||
              document.activeElement?.closest('dialog') != null,
          ),
        ).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      await expect(opener).toBeFocused();
      // Nothing was deleted.
      await expect(page.getByText('Local only', { exact: true })).toBeVisible();
    },
  );

  readerTest('every control has an accessible name', async ({ rpage: page }) => {
    for (const path of ['/words', '/documents', '/account']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const unnamed = await page.evaluate(() =>
        [...document.querySelectorAll('button, a[href], input, progress')]
          .filter(
            (el) =>
              !(
                el.getAttribute('aria-label') ||
                el.getAttribute('aria-labelledby') ||
                (el as HTMLElement).innerText?.trim() ||
                (el as HTMLInputElement).labels?.length
              ),
          )
          .map((el) => el.outerHTML.slice(0, 80)),
      );
      expect(unnamed, path).toEqual([]);
    }
  });
});

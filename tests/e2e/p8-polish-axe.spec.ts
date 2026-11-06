import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { closeInstallTabs, gotoSiteAccessStep, openExtensionPage } from './p3-ui-support/pages';
import { openFixtureReady, openReader } from './p7-reader-support/helpers';

// Phase 8: automated accessibility (axe, light and dark) and reflow (no horizontal scroll) of every
// extension page at narrow widths, including the new help blocks.
test.describe.configure({ timeout: 90_000 });

async function axe(page: Page, label: string) {
  const results = await new AxeBuilder({ page }).analyze();
  const summary = results.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target.join(' ')).slice(0, 4),
  }));
  expect(summary, `axe violations: ${label}`).toEqual([]);
}

async function noHorizontalScroll(page: Page, label: string) {
  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scroll, `horizontal scroll: ${label}`).toBeLessThanOrEqual(client);
}

const WIDTHS = [1000, 360, 320];

for (const scheme of ['light', 'dark'] as const) {
  test.describe(`${scheme} colour scheme`, () => {
    test.use({ colorScheme: scheme });

    test('popup: default, and on a tab that looks like a PDF', async ({ context, extensionId }) => {
      const { page } = await openExtensionPage(context, extensionId, 'popup');
      await page.setViewportSize({ width: 320, height: 700 });
      await expect(page.getByTestId('popup-groq')).toHaveText('Setup needed');
      await page.getByText('Using Clavis without website access').click();
      await axe(page, `popup open help ${scheme}`);
      await noHorizontalScroll(page, 'popup');

      const pdf = await context.newPage();
      await pdf.addInitScript(() => {
        chrome.tabs.query = (() =>
          Promise.resolve([
            { id: 1, url: 'https://example.com/a.pdf' },
          ])) as unknown as typeof chrome.tabs.query;
      });
      await pdf.goto(`chrome-extension://${extensionId}/popup.html`);
      await pdf.setViewportSize({ width: 320, height: 700 });
      await expect(pdf.getByTestId('popup-pdf-help')).toBeVisible();
      await axe(pdf, `popup pdf ${scheme}`);
      await noHorizontalScroll(pdf, 'popup pdf');
    });

    for (const width of WIDTHS) {
      test(`options at ${width}px`, async ({ context, extensionId }) => {
        const { page } = await openExtensionPage(context, extensionId, 'options');
        await page.setViewportSize({ width, height: 900 });
        await expect(page.getByTestId('voice-counts')).toBeAttached({ timeout: 15_000 });
        await axe(page, `options ${width} ${scheme}`);
        await noHorizontalScroll(page, `options ${width}`);
        for (const section of ['Preferences', 'Website access', 'Privacy & help']) {
          await page.getByRole('link', { name: section, exact: true }).click();
          await axe(page, `options ${section} ${width} ${scheme}`);
          await noHorizontalScroll(page, `options ${section} ${width}`);
        }
        await expect(page.getByTestId('pdf-help')).toBeVisible();
      });

      test(`onboarding (first and last step) at ${width}px`, async ({ context, extensionId }) => {
        const { page } = await openExtensionPage(context, extensionId, 'onboarding');
        await page.setViewportSize({ width, height: 800 });
        await axe(page, `onboarding welcome ${width} ${scheme}`);
        await noHorizontalScroll(page, `onboarding welcome ${width}`);
        await gotoSiteAccessStep(page);
        await page.getByRole('button', { name: "Not now — I'll use right-click instead" }).click();
        const next = page.getByRole('button', { name: 'Next', exact: true });
        await next.click();
        await page.getByRole('button', { name: 'Set up later' }).click();
        await next.click();
        await next.click();
        await expect(page.getByRole('heading', { name: "You're ready" })).toBeVisible();
        await expect(page.getByTestId('site-access-help')).toBeVisible();
        await axe(page, `onboarding done ${width} ${scheme}`);
        await noHorizontalScroll(page, `onboarding done ${width}`);
      });

      test(`practice at ${width}px`, async ({ context, extensionId }) => {
        const { page } = await openExtensionPage(context, extensionId, 'practice');
        await page.setViewportSize({ width, height: 900 });
        await expect(page.getByTestId('practice-result')).toBeVisible();
        await axe(page, `practice ${width} ${scheme}`);
        await noHorizontalScroll(page, `practice ${width}`);
      });

      test(`reader (empty and loaded) at ${width}px`, async ({ context, extensionId }) => {
        const { page } = await openReader(context, extensionId);
        await page.setViewportSize({ width, height: 700 });
        await page.emulateMedia({ colorScheme: scheme });
        await expect(page.getByTestId('state-empty')).toBeVisible();
        // The empty state scrolls from its top: the heading is reachable at any size.
        await expect(
          page.getByRole('heading', { name: 'Read a PDF with Clavis' }),
        ).toBeInViewport();
        await axe(page, `reader empty ${width} ${scheme}`);
        await noHorizontalScroll(page, `reader empty ${width}`);
        await openFixtureReady(page, 'text-1page.pdf');
        await axe(page, `reader loaded ${width} ${scheme}`);
        await noHorizontalScroll(page, `reader loaded ${width}`);
      });
    }
  });
}

test.afterEach(async ({ context }) => {
  await closeInstallTabs(context);
});

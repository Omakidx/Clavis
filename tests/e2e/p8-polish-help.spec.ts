import { expect, test } from './fixtures';
import { closeInstallTabs, openExtensionPage } from './p3-ui-support/pages';
import { openFixtureReady, openReader } from './p7-reader-support/helpers';

// Phase 8: the help screens are reachable from where people get stuck, and the page polish that
// is not visible in a screenshot (focus ring, reduced motion, text direction).
test.describe.configure({ timeout: 90_000 });

test.afterEach(async ({ context }) => {
  await closeInstallTabs(context);
});

test("the reader's empty state links to the PDF help in Settings", async ({
  context,
  extensionId,
}) => {
  const { page } = await openReader(context, extensionId);
  const opened = context.waitForEvent('page');
  await page.getByRole('link', { name: /Why doesn't Clavis work in Chrome's PDF viewer/ }).click();
  const settings = await opened;
  await settings.waitForLoadState();
  expect(settings.url()).toBe(`chrome-extension://${extensionId}/options.html#section-help-pdf`);
  const help = settings.getByTestId('pdf-help');
  await expect(help).toBeInViewport();
  await expect(help).toContainText("can't add a toolbar to");
  await expect(help).toContainText('files from your computer only');
});

test('the popup sends a missing key straight to Settings > Groq API key', async ({
  context,
  extensionId,
}) => {
  const { page } = await openExtensionPage(context, extensionId, 'popup');
  await expect(page.getByTestId('popup-groq')).toHaveText('Setup needed');
  await expect(page.getByText('Connect your Groq key to use Explain.')).toBeVisible();
  const opened = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Connect Groq' }).click();
  const settings = await opened;
  await settings.waitForLoadState();
  expect(settings.url()).toBe(`chrome-extension://${extensionId}/options.html#section-key`);
  await expect(settings.getByRole('region', { name: 'Groq API key' })).toBeInViewport();
});

test('Settings > Website access explains the paths that work without access', async ({
  context,
  extensionId,
}) => {
  const { page } = await openExtensionPage(context, extensionId, 'options');
  const help = page.getByTestId('site-access-help');
  await expect(help).toBeVisible();
  await expect(help).toContainText('right-click it and choose Explain with Clavis');
  await expect(help).toContainText('click the Clavis icon and choose Explain on this page');
  await expect(help).toContainText('press Alt+Shift+E');
  await expect(help).toContainText('set Site access to On all sites');
});

test('keyboard focus is always visible on the popup and Settings', async ({
  context,
  extensionId,
}) => {
  for (const name of ['popup', 'options'] as const) {
    const { page } = await openExtensionPage(context, extensionId, name);
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const style = getComputedStyle(document.activeElement as Element);
      return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
    });
    expect(ring.style, name).not.toBe('none');
    expect(ring.width, name).toBeGreaterThanOrEqual(2);
  }
});

test('reduced motion removes the page transitions', async ({ context, extensionId }) => {
  const { page } = await openExtensionPage(context, extensionId, 'popup');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const duration = await page
    .getByRole('button', { name: 'Settings' })
    .evaluate((el) => parseFloat(getComputedStyle(el).transitionDuration));
  expect(duration).toBeLessThan(0.001);
});

test('text from files and pages keeps its own direction (dir="auto")', async ({
  context,
  extensionId,
}) => {
  const { page } = await openReader(context, extensionId);
  await openFixtureReady(page, 'text-1page.pdf');
  await expect(page.getByTestId('file-name')).toHaveAttribute('dir', 'auto');
  const options = await openExtensionPage(context, extensionId, 'options');
  await options.page.getByLabel('Website address').fill('bücher.example');
  await options.page.getByRole('button', { name: 'Add website' }).click();
  await expect(options.page.locator('.clavis-site-row__host')).toHaveAttribute('dir', 'auto');
});

import { expect, test } from './fixtures';

type Manifest = {
  manifest_version: number;
  content_scripts?: unknown;
  permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
};

test.describe('extension smoke', () => {
  test('service worker is running and belongs to the loaded extension', async ({
    serviceWorker,
    extensionId,
  }) => {
    expect(extensionId).toMatch(/^[a-p]{32}$/);
    expect(serviceWorker.url()).toBe(`chrome-extension://${extensionId}/background.js`);
    expect(await serviceWorker.evaluate('chrome.runtime.id')).toBe(extensionId);
  });

  test('loaded manifest has no static content_scripts and declares optional site access', async ({
    serviceWorker,
  }) => {
    const manifest = (await serviceWorker.evaluate('chrome.runtime.getManifest()')) as Manifest;
    expect(manifest.manifest_version).toBe(3);
    // D-02: the observer is registered at runtime after the user grants site access.
    expect(manifest).not.toHaveProperty('content_scripts');
    expect(manifest.optional_host_permissions).toEqual(
      expect.arrayContaining(['http://*/*', 'https://*/*']),
    );
    // Nothing broad may be granted at install time.
    const installTimeHosts = manifest.host_permissions ?? [];
    expect(installTimeHosts).not.toContain('<all_urls>');
    expect(
      installTimeHosts.some((host) => host.includes('*://*/*') || host === 'https://*/*'),
    ).toBe(false);
  });

  for (const pageName of ['popup', 'onboarding'] as const) {
    test(`${pageName}.html renders a visible heading`, async ({ context, extensionId }) => {
      const page = await context.newPage();
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));

      await page.goto(`chrome-extension://${extensionId}/${pageName}.html`);

      const heading = page.locator('h1').first();
      await expect(heading).toBeVisible();
      await expect(heading).toHaveText(/\S/);
      // An unresolved chrome.i18n placeholder means a missing message key.
      await expect(heading).not.toContainText('__MSG_');
      expect(pageErrors).toEqual([]);
    });
  }
});

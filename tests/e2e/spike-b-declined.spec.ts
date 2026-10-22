import { expect, test, type Page } from '@playwright/test';
import { launchExtension, type LaunchedExtension } from './spike-b-support/extension';
import { dblclickText } from './spike-b-support/page';
import { startFixtureServer, type FixtureServer } from './spike-b-support/server';
import { tb } from './spike-b-support/toolbar';
import { gotoSiteAccessStep } from './p3-ui-support/pages';

// Spike B, site access DECLINED path (D-02, FR-018): nothing is registered or injected
// automatically, the popup offers the on-demand fallback, and every refusal is graceful.
//
// What automation cannot do: click Chrome's native permission prompt, and create an
// `activeTab` grant (that needs a real toolbar-icon or context-menu gesture). Those two
// are covered by the manual steps in docs/decisions/spike-b-toolbar.md; the code behind
// them is exercised here with the grant stood in by manifest host permissions
// (spike-b-selection.spec.ts) and its refusal without a grant (below).
let server: FixtureServer;
let ext: LaunchedExtension;

test.beforeAll(async () => {
  server = await startFixtureServer();
  ext = await launchExtension();
});

test.afterAll(async () => {
  await ext?.close();
  await server?.close();
});

type Manifest = {
  content_scripts?: unknown;
  host_permissions?: string[];
  optional_host_permissions?: string[];
  permissions?: string[];
};

async function openExtensionPage(name: string): Promise<Page> {
  const page = await ext.context.newPage();
  await page.goto(`chrome-extension://${ext.extensionId}/${name}.html`);
  return page;
}

/** What Chrome itself says the extension can access, read from chrome://extensions (developerPrivate). */
async function installedAccess(extension: LaunchedExtension): Promise<{
  hasAllHosts: boolean;
  hosts: string[];
  warnings: string[];
}> {
  const page = await extension.context.newPage();
  try {
    await page.goto('chrome://extensions');
    return await page.evaluate(async () => {
      type Info = {
        name: string;
        permissions: {
          runtimeHostPermissions: { hasAllHosts: boolean; hosts: Array<{ host: string }> };
          simplePermissions: Array<{ message: string }>;
        };
      };
      const api = (
        chrome as unknown as {
          developerPrivate: { getExtensionsInfo(o: object): Promise<Info[]> };
        }
      ).developerPrivate;
      const all = await api.getExtensionsInfo({ includeDisabled: true });
      const info = all.find((e) => e.name === 'Clavis');
      if (info === undefined) throw new Error('Clavis is not installed');
      return {
        hasAllHosts: info.permissions.runtimeHostPermissions.hasAllHosts,
        hosts: info.permissions.runtimeHostPermissions.hosts.map((h) => h.host),
        warnings: info.permissions.simplePermissions.map((p) => p.message),
      };
    });
  } finally {
    await page.close();
  }
}

test.describe('install-time permissions (D-02: no all-sites warning)', () => {
  test('Chrome reports no all-sites access for the shipped manifest, and does for a control copy that declares it', async () => {
    const shipped = await installedAccess(ext);
    expect(shipped.hasAllHosts).toBe(false);
    expect(shipped.hosts).toEqual(['https://api.groq.com/*']);
    expect(shipped.warnings).toEqual([]);

    // Control: the same check does detect all-sites access when the manifest requests it.
    const control = await launchExtension({ grantedSiteAccess: true });
    try {
      const patched = await installedAccess(control);
      expect(patched.hasAllHosts).toBe(true);
      expect(patched.hosts).toEqual(['http://*/*', 'https://*/*']);
    } finally {
      await control.close();
    }
  });
});

test.describe('nothing is injected without a grant', () => {
  test('the install-time manifest has no site access and no static content scripts', async () => {
    const manifest = (await ext.serviceWorker.evaluate('chrome.runtime.getManifest()')) as Manifest;
    expect(manifest).not.toHaveProperty('content_scripts');
    expect(manifest.host_permissions).toEqual(['https://api.groq.com/*']);
    expect(manifest.optional_host_permissions).toEqual(['http://*/*', 'https://*/*']);
    expect(manifest.permissions).toEqual(
      expect.arrayContaining(['scripting', 'activeTab', 'contextMenus']),
    );
  });

  test('chrome reports the optional origins as not granted and nothing is registered', async () => {
    const granted = await ext.serviceWorker.evaluate(
      `chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })`,
    );
    expect(granted).toBe(false);
    const scripts = await ext.serviceWorker.evaluate(
      'chrome.scripting.getRegisteredContentScripts()',
    );
    expect(scripts).toEqual([]);
  });

  test('selecting text on a page shows no toolbar', async () => {
    const page = await ext.context.newPage();
    await page.goto(`${server.origin}/article.html`);
    await page.waitForTimeout(500);
    await dblclickText(page, page, 'cartographer');
    await page.waitForTimeout(500);
    await tb(page).expectNoHost();
    await page.close();
  });
});

test.describe('on-demand injection refuses cleanly without an activeTab grant', () => {
  test('an injection attempt on a normal page is reported as "no-access", not thrown', async () => {
    const page = await ext.context.newPage();
    await page.goto(`${server.origin}/article.html`);
    const helper = await openExtensionPage('popup');
    await page.bringToFront();
    const tabId = (await ext.serviceWorker.evaluate(
      `chrome.tabs.query({ active: true, currentWindow: true }).then((t) => t[0].id)`,
    )) as number;
    const reply = await helper.evaluate(
      (id) => chrome.runtime.sendMessage({ v: 1, type: 'CLAVIS_INJECT_TAB', tabId: id }),
      tabId,
    );
    expect(reply).toEqual({ ok: false, reason: 'no-access' });
    await tb(page).expectNoHost();
    await helper.close();
    await page.close();
  });

  test('a web page cannot use the injection routes', async () => {
    const page = await ext.context.newPage();
    await page.goto(`${server.origin}/article.html`);
    // From a web page there is no chrome.runtime.sendMessage to this extension without
    // externally_connectable, so the route is unreachable; assert that explicitly.
    const reachable = await page.evaluate(
      () =>
        typeof (window as unknown as { chrome?: { runtime?: { sendMessage?: unknown } } }).chrome
          ?.runtime?.sendMessage,
    );
    expect(reachable).not.toBe('function');
    await page.close();
  });
});

test.describe('popup fallback (toolbar-icon path)', () => {
  test('shows "Explain on this page" while site access is not granted', async () => {
    const popup = await openExtensionPage('popup');
    await expect(popup.getByRole('button', { name: 'Explain on this page' })).toBeVisible();
    await expect(popup.getByText('Select some text on the page first')).toBeVisible();
    await popup.close();
  });

  test('says so when the current tab is a page extensions cannot run on', async () => {
    const popup = await openExtensionPage('popup');
    // As a tab, the popup is its own "active tab": a chrome-extension:// page is restricted.
    await popup.getByRole('button', { name: 'Explain on this page' }).click();
    await expect(popup.getByRole('status')).toHaveText(/can't run on this kind of page/);
    await popup.close();
  });
});

test.describe('onboarding site-access step', () => {
  test('the grant button asks Chrome and shows a pending state while the prompt is open', async () => {
    const onboarding = await openExtensionPage('onboarding');
    await gotoSiteAccessStep(onboarding);
    const grant = onboarding.getByRole('button', { name: 'Enable on websites' });
    await grant.click();
    // Chrome's native prompt cannot be answered from Playwright; the request stays pending.
    await expect(onboarding.getByRole('status')).toHaveText(/Waiting for your answer/);
    await expect(grant).toBeDisabled();
    await onboarding.close();
  });

  test('"Not now" explains the right-click alternative and requests nothing', async () => {
    const onboarding = await openExtensionPage('onboarding');
    await gotoSiteAccessStep(onboarding);
    await onboarding.getByRole('button', { name: /Not now/ }).click();
    await expect(onboarding.getByRole('status')).toHaveText(/Explain with Clavis/);
    expect(
      await ext.serviceWorker.evaluate(
        `chrome.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })`,
      ),
    ).toBe(false);
    await onboarding.close();
  });
});

test.describe('granted site access', () => {
  test('the popup hides the fallback button once Chrome reports access granted', async () => {
    const granted = await launchExtension({ grantedSiteAccess: true });
    try {
      const popup = await granted.context.newPage();
      await popup.goto(`chrome-extension://${granted.extensionId}/popup.html`);
      await expect(popup.getByRole('button', { name: 'Open PDF reader' })).toBeVisible();
      await expect(popup.getByRole('button', { name: 'Explain on this page' })).toHaveCount(0);
    } finally {
      await granted.close();
    }
  });
});

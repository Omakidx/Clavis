import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, test as base, expect, type BrowserContext, type Worker } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

/** Built unpacked extension. Override with CLAVIS_EXTENSION_DIR to test another build. */
export const extensionPath = path.resolve(
  repoRoot,
  process.env['CLAVIS_EXTENSION_DIR'] ?? '.output/chrome-mv3',
);

type ExtensionFixtures = {
  /** Fresh persistent Chromium profile with the built extension loaded. */
  context: BrowserContext;
  /** The extension's MV3 service worker, already running. */
  serviceWorker: Worker;
  /** Extension id derived from the service worker URL. */
  extensionId: string;
};

// Why this shape (verified against the installed Playwright 1.64 sources):
// - Extensions only load in a persistent context, so launchPersistentContext is used.
// - Chrome-branded builds 137+ ignore --load-extension; Playwright's bundled Chromium honours it.
// - The default headless mode launches chromium-headless-shell, which has no extension support.
//   channel: 'chromium' selects the full Chromium binary and its new headless mode, which does.
// - Playwright's fixture callback is usually named `use`; it is named `provide` here so
//   eslint-plugin-react-hooks does not mistake it for React's `use` hook.
// - Set CLAVIS_E2E_HEADED=1 to watch the run (needs a display, or xvfb-run on Linux).
export const test = base.extend<ExtensionFixtures>({
  // Playwright requires an object-destructuring first parameter, even when it has no dependencies.
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, provide) => {
    try {
      await access(path.join(extensionPath, 'manifest.json'));
    } catch {
      throw new Error(`No built extension at ${extensionPath}. Run "npm run build" first.`);
    }
    const userDataDir = await mkdtemp(path.join(tmpdir(), 'clavis-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: process.env['CLAVIS_E2E_HEADED'] !== '1',
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    try {
      await provide(context);
    } finally {
      await context.close();
      // Windows can hold profile files briefly after close; a leftover temp dir must not fail the test.
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    }
  },

  serviceWorker: [
    async ({ context }, provide) => {
      // Match the fresh-profile installation deadline in spike-b-support/extension.ts. Slow
      // Windows installation is setup, separate from functional and request timing assertions.
      const serviceWorker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent('serviceworker', { timeout: 30_000 }));
      await provide(serviceWorker);
    },
    { timeout: 45_000 },
  ],

  extensionId: async ({ serviceWorker }, provide) => {
    await provide(new URL(serviceWorker.url()).host);
  },
});

export { expect };

import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import type { LaunchedExtension } from '../spike-b-support/extension';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Launch a copy of the build whose manifest grants host access to ONE origin only.
 *
 * Stand-in for the `activeTab` grant, which cannot be created from automation: like
 * `activeTab` it covers the page's own origin but not a cross-origin iframe, so Chrome
 * refuses `scripting.executeScript` into that frame with the same "must request
 * permission" error. The all-sites access stays optional and ungranted, so nothing is
 * registered or injected automatically (the declined path).
 */
export async function launchWithHostAccess(hostPattern: string): Promise<LaunchedExtension> {
  const source = path.resolve(
    repoRoot,
    process.env['CLAVIS_EXTENSION_DIR'] ?? '.output/chrome-mv3',
  );
  const root = await mkdtemp(path.join(tmpdir(), 'clavis-ext-'));
  const dir = path.join(root, 'ext');
  await cp(source, dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    host_permissions?: string[];
  };
  manifest.host_permissions = [...(manifest.host_permissions ?? []), hostPattern];
  await writeFile(manifestPath, JSON.stringify(manifest));

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'clavis-profile-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: process.env['CLAVIS_E2E_HEADED'] !== '1',
    args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
  });
  const serviceWorker =
    context.serviceWorkers()[0] ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  return {
    context,
    serviceWorker,
    extensionId: new URL(serviceWorker.url()).host,
    async close() {
      await context.close();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    },
  };
}

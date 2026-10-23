import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { extensionPath } from '../fixtures';

/**
 * One Chrome profile that can be closed and opened again, as a person quits and restarts Chrome.
 * The unpacked extension keeps the same folder (its id comes from it), so the second launch is the
 * same installation: not a fresh install, no `install` event.
 */
export interface Restartable {
  launch(): Promise<{ context: BrowserContext; serviceWorker: Worker; extensionId: string }>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

export async function restartableProfile(): Promise<Restartable> {
  const root = await mkdtemp(path.join(tmpdir(), 'clavis-restart-'));
  const dir = path.join(root, 'ext');
  const profile = path.join(root, 'profile');
  await cp(extensionPath, dir, { recursive: true });
  let context: BrowserContext | undefined;
  return {
    async launch() {
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        headless: process.env['CLAVIS_E2E_HEADED'] !== '1',
        args: [`--disable-extensions-except=${dir}`, `--load-extension=${dir}`],
      });
      const serviceWorker =
        context.serviceWorkers()[0] ??
        (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
      return { context, serviceWorker, extensionId: new URL(serviceWorker.url()).host };
    },
    async close() {
      await context?.close();
      context = undefined;
    },
    async dispose() {
      await context?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(
        () => undefined,
      );
    },
  };
}

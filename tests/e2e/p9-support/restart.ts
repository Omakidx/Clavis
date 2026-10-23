import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium, type BrowserContext, type Worker } from '@playwright/test';
import { extensionPath } from '../fixtures';

/**
 * One Chrome profile that can be closed and opened again, as a person quits and restarts Chrome,
 * with the all-sites access stand-in (the manifest copy lists the optional origins as granted) so
 * the persistent content-script registration is in play. The unpacked extension keeps its folder
 * (and therefore its id), so the second launch is the same installation.
 */
export interface RestartableGranted {
  /** Replace the service worker's script (background.js) with an empty one, for the NEXT launch. */
  silenceWorker(): Promise<void>;
  launch(): Promise<{ context: BrowserContext; serviceWorker: Worker; extensionId: string }>;
  close(): Promise<void>;
  dispose(): Promise<void>;
}

export async function restartableGranted(): Promise<RestartableGranted> {
  const root = await mkdtemp(path.join(tmpdir(), 'clavis-p9-restart-'));
  const dir = path.join(root, 'ext');
  const profile = path.join(root, 'profile');
  await cp(extensionPath, dir, { recursive: true });
  const manifestPath = path.join(dir, 'manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    host_permissions?: string[];
    optional_host_permissions?: string[];
  };
  manifest.host_permissions = [
    ...(manifest.host_permissions ?? []),
    ...(manifest.optional_host_permissions ?? []),
  ];
  delete manifest.optional_host_permissions;
  await writeFile(manifestPath, JSON.stringify(manifest));
  let context: BrowserContext | undefined;
  return {
    async silenceWorker() {
      await writeFile(
        path.join(dir, 'background.js'),
        '// silenced for a test: this worker does nothing\n',
      );
    },
    async launch() {
      context = await chromium.launchPersistentContext(profile, {
        channel: 'chromium',
        headless: process.env['CLAVIS_E2E_HEADED'] !== '1',
        args: [
          `--disable-extensions-except=${dir}`,
          `--load-extension=${dir}`,
          // After a restart Playwright's routes can reach the service worker a moment late, so
          // nothing but this machine may be resolvable: a request that slips past a route fails
          // as a network error instead of leaving for the real Groq.
          '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
        ],
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

/**
 * Wait until the test's routes really answer the (restarted) service worker's requests: probe with
 * a key-less request until the fake has seen one. Returns once it has.
 */
export async function primeWorkerRoutes(
  worker: Worker,
  seen: () => number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (seen() === 0) {
    if (Date.now() > deadline) throw new Error('the service worker never reached the test routes');
    await worker
      .evaluate(() =>
        fetch('https://api.groq.com/openai/v1/models').then(
          () => 0,
          () => 0,
        ),
      )
      .catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

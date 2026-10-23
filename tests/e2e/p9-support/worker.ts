import type { BrowserContext, Page } from '@playwright/test';

/**
 * Stop the extension's service worker the way Chrome does when it is terminated (idle timeout,
 * crash, memory pressure) and DO NOT wake it again: the caller decides when something wakes it.
 * The DevTools ServiceWorker domain reports the real running state, so "stopped" is read from the
 * protocol, not guessed. Any in-flight `fetch` of the worker dies with it.
 *
 * `anyExtensionPage` is only used to open a DevTools session and to learn the extension origin.
 */
export async function stopServiceWorker(
  context: BrowserContext,
  anyExtensionPage: Page,
): Promise<void> {
  const session = await context.newCDPSession(anyExtensionPage);
  try {
    const versions = new Map<string, { runningStatus: string; scriptURL: string }>();
    session.on('ServiceWorker.workerVersionUpdated', (event) => {
      for (const version of event.versions) versions.set(version.versionId, version);
    });
    await session.send('ServiceWorker.enable');
    const origin = anyExtensionPage.url().split('/').slice(0, 3).join('/');
    const running = (): string[] =>
      [...versions]
        .filter(([, v]) => v.scriptURL.startsWith(origin) && v.runningStatus === 'running')
        .map(([id]) => id);
    const deadline = Date.now() + 10_000;
    while (running().length === 0) {
      if (Date.now() > deadline) throw new Error('no running extension service worker');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const versionId of running())
      await session.send('ServiceWorker.stopWorker', { versionId });
    while (running().length > 0) {
      if (Date.now() > deadline) throw new Error('service worker did not stop');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await session.detach().catch(() => undefined);
  }
}

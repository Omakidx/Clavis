import type { BrowserContext, Page, Worker } from '@playwright/test';

/** `chrome.*` inside page / worker evaluate callbacks (tsconfig.node.json has no chrome types). */
declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
  storage: Record<'local' | 'session', { get(keys: null): Promise<Record<string, unknown>> }>;
};

// Fake keys MUST start with gsk_TEST (gitleaks allowlist).
export const FAKE_KEY = 'gsk_TESTe2eFakeKeyDoNotUse0000000000AbCd';
export const OTHER_FAKE_KEY = 'gsk_TESTe2eSecondFakeKeyDoNotUse00007890';

export interface Reply {
  ok: boolean;
  requestId?: string;
  data?: Record<string, unknown> & {
    hasKey?: boolean;
    storage?: string | null;
    last4?: string | null;
    verification?: string;
    models?: unknown[];
    preferences?: Record<string, unknown>;
    onboarding?: Record<string, unknown>;
  };
  error?: { code: string; message: string; retryAfterMs?: number };
}

export const newId = (): string => crypto.randomUUID();

export async function openExtensionPage(
  context: BrowserContext,
  extensionId: string,
  name: string,
): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${name}.html`);
  return page;
}

/** Send a runtime message from an extension page, exactly as the UI would. */
export function send(page: Page, message: unknown): Promise<Reply | undefined> {
  return page.evaluate((m) => chrome.runtime.sendMessage(m), message) as Promise<Reply | undefined>;
}

/** Everything in a storage area, read from the service worker (the only context allowed to). */
export function readStorage(
  worker: Worker,
  area: 'local' | 'session',
): Promise<Record<string, unknown>> {
  return worker.evaluate((name) => chrome.storage[name].get(null), area);
}

/** Names of the Clavis records in an area. */
export async function clavisKeys(worker: Worker, area: 'local' | 'session'): Promise<string[]> {
  return Object.keys(await readStorage(worker, area))
    .filter((key) => key.startsWith('clavis.'))
    .sort();
}

/**
 * Stop the extension's service worker, like Chrome does when idle, and return the NEW one.
 * Uses the DevTools ServiceWorker domain. Playwright keeps listing the dead worker in
 * `context.serviceWorkers()`, so "stopped" is read from the protocol, and the replacement
 * is the next `serviceworker` event, started by a message from an extension page.
 */
export async function restartWorker(context: BrowserContext, page: Page): Promise<Worker> {
  const session = await context.newCDPSession(page);
  try {
    const versions = new Map<string, { runningStatus: string; scriptURL: string }>();
    session.on('ServiceWorker.workerVersionUpdated', (event) => {
      for (const version of event.versions) versions.set(version.versionId, version);
    });
    await session.send('ServiceWorker.enable');
    // URL.origin is "null" for chrome-extension:// in Node, so cut the origin by hand.
    const extensionOrigin = page.url().split('/').slice(0, 3).join('/');
    const running = (): [string, { runningStatus: string; scriptURL: string }][] =>
      [...versions].filter(
        ([, v]) => v.scriptURL.startsWith(extensionOrigin) && v.runningStatus === 'running',
      );
    const deadline = Date.now() + 10_000;
    while (running().length === 0) {
      if (Date.now() > deadline) throw new Error('no running extension service worker');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    for (const [versionId] of running())
      await session.send('ServiceWorker.stopWorker', { versionId });
    while (running().length > 0) {
      if (Date.now() > deadline) throw new Error('service worker did not stop');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await session.detach().catch(() => undefined);
  }
  // Any runtime message wakes the worker; the reply proves it is up and routing.
  await send(page, { v: 1, type: 'GET_AI_STATUS' });
  // Playwright neither reliably emits `serviceworker` for the restarted worker nor drops the
  // dead handle at once (evaluate() on it hangs), so return whichever handle answers.
  const deadline = Date.now() + 15_000;
  for (;;) {
    for (const worker of context.serviceWorkers()) {
      const alive = await Promise.race([
        worker.evaluate(() => true).catch(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      if (alive) return worker;
    }
    if (Date.now() > deadline) throw new Error('service worker did not restart');
  }
}

/**
 * Answer the service worker's calls to Groq without touching the network.
 * `mode`: 401 (rejected key), 403, 'ok' (model list), or 'offline'.
 */
export type GroqMode = 'ok' | 401 | 403 | 'offline';
export async function mockGroq(
  context: BrowserContext,
  mode: { current: GroqMode },
  seen: string[] = [],
): Promise<string[]> {
  await context.route('https://api.groq.com/**', async (route) => {
    seen.push(route.request().url());
    const current = mode.current;
    if (current === 'offline') return route.abort('internetdisconnected');
    if (current === 'ok') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          object: 'list',
          data: [
            { id: 'openai/gpt-oss-20b', object: 'model', owned_by: 'OpenAI', active: true },
            { id: 'openai/gpt-oss-120b', object: 'model', owned_by: 'OpenAI', active: true },
            { id: 'whisper-large-v3', object: 'model', owned_by: 'OpenAI', active: true },
          ],
        }),
      });
    }
    return route.fulfill({
      status: current,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { message: 'Invalid API Key', type: 'invalid_request_error' },
      }),
    });
  });
  return seen;
}

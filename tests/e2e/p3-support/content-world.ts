import type { CDPSession, Page } from '@playwright/test';

/**
 * Run code in the extension's CONTENT-SCRIPT world of a web page (the isolated world the
 * registered observer lives in). That is the context a hostile page's neighbour has: it is
 * where `chrome.storage` must be denied and where privileged messages must be refused.
 * Unlike the Spike B helper, results are awaited, so promises (sendMessage, storage) work.
 */
export interface ContentWorld {
  /** Evaluate an async expression in the content-script world of the main frame. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Resolve once the extension's content script is running in the page. */
  ready(timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

export async function contentWorld(page: Page): Promise<ContentWorld> {
  const session: CDPSession = await page.context().newCDPSession(page);
  const worlds = new Map<number, string | undefined>();
  session.on('Runtime.executionContextCreated', ({ context }) => {
    const aux = context.auxData as { type?: string; frameId?: string } | undefined;
    if (aux?.type === 'isolated' && context.origin.startsWith('chrome-extension://')) {
      worlds.set(context.id, aux.frameId);
    }
  });
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    worlds.delete(executionContextId);
  });
  session.on('Runtime.executionContextsCleared', () => worlds.clear());
  await session.send('Runtime.enable');

  const mainFrame = async (): Promise<string> =>
    (await session.send('Page.getFrameTree')).frameTree.frame.id;

  async function find(): Promise<number | undefined> {
    const frame = await mainFrame();
    return [...worlds].find(([, frameId]) => frameId === frame)?.[0];
  }

  return {
    async evaluate<T>(expression: string): Promise<T> {
      const contextId = await find();
      if (contextId === undefined) throw new Error('no content-script world in this page');
      const result = await session.send('Runtime.evaluate', {
        expression,
        contextId,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
      return result.result.value as T;
    },
    async ready(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while ((await find()) === undefined) {
        if (Date.now() > deadline) throw new Error('content script never started');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    async dispose() {
      await session.detach().catch(() => undefined);
    },
  };
}

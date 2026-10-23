import type { CDPSession, Page } from '@playwright/test';

/**
 * Run code in the extension's CONTENT-SCRIPT world of ONE frame of a page (the isolated world the
 * observer lives in, per frame). `tests/e2e/p3-support/content-world.ts` only reaches the main
 * frame; this finds a frame by its url. Same-process (same-origin) frames only: a cross-origin
 * frame lives in its own CDP target.
 */
export interface FrameWorld {
  evaluate<T = unknown>(expression: string): Promise<T>;
  ready(timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

interface FrameNode {
  frame: { id: string; url: string };
  childFrames?: FrameNode[];
}

function flatten(node: FrameNode, out: FrameNode['frame'][] = []): FrameNode['frame'][] {
  out.push(node.frame);
  node.childFrames?.forEach((child) => flatten(child, out));
  return out;
}

export async function frameWorld(
  page: Page,
  /** Pick the frame: its current url, or `undefined` for the main frame. */
  pick: ((url: string) => boolean) | undefined,
): Promise<FrameWorld> {
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

  async function find(): Promise<number | undefined> {
    const tree = (await session.send('Page.getFrameTree')).frameTree as FrameNode;
    const frames = flatten(tree);
    const target = pick === undefined ? frames[0] : frames.find((f) => pick(f.url));
    if (target === undefined) return undefined;
    return [...worlds].find(([, frameId]) => frameId === target.id)?.[0];
  }

  return {
    async evaluate<T>(expression: string): Promise<T> {
      const contextId = await find();
      if (contextId === undefined) throw new Error('no content-script world in that frame');
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
        if (Date.now() > deadline) throw new Error('content script never started in that frame');
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    },
    async dispose() {
      await session.detach().catch(() => undefined);
    },
  };
}

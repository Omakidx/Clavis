import type { BrowserContext, CDPSession, Frame, Page } from '@playwright/test';

/** Box in viewport (or page) CSS pixels. */
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WorldInfo {
  contextId: number;
  frameId: string | undefined;
}

export interface WorldTracker {
  /** Evaluate in the extension's isolated world of the main frame (or of `frameId`). */
  evaluate(expression: string, frameId?: string): Promise<unknown>;
  /** Wait until the observer content script is running in a frame's isolated world. */
  waitForObserver(frameId?: string, timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * The extension's content scripts live in an ISOLATED world that Playwright
 * does not expose. CDP does: track `Runtime.executionContextCreated` for
 * chrome-extension:// isolated worlds so tests can read observer state and
 * (importantly for measurements) know when the observer is actually running.
 * Only same-process frames are visible this way: cross-origin iframes are
 * out-of-process and need Playwright-level polling instead.
 */
export async function trackWorlds(page: Page): Promise<WorldTracker> {
  const session: CDPSession = await page.context().newCDPSession(page);
  const worlds = new Map<number, WorldInfo>();
  session.on('Runtime.executionContextCreated', ({ context }) => {
    const aux = context.auxData as { type?: string; frameId?: string } | undefined;
    if (aux?.type === 'isolated' && context.origin.startsWith('chrome-extension://')) {
      worlds.set(context.id, { contextId: context.id, frameId: aux.frameId });
    }
  });
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    worlds.delete(executionContextId);
  });
  session.on('Runtime.executionContextsCleared', () => worlds.clear());
  await session.send('Runtime.enable');

  const mainFrameId = async (): Promise<string> => {
    const tree = await session.send('Page.getFrameTree');
    return tree.frameTree.frame.id;
  };

  async function evaluate(expression: string, frameId?: string): Promise<unknown> {
    const target = frameId ?? (await mainFrameId());
    const world = [...worlds.values()].find((w) => w.frameId === target);
    if (world === undefined) return undefined;
    const result = await session.send('Runtime.evaluate', {
      expression,
      contextId: world.contextId,
      returnByValue: true,
    });
    return result.result.value;
  }

  const observerRunning = `typeof globalThis[Symbol.for('clavis.observer')] !== 'undefined'`;
  return {
    evaluate,
    async waitForObserver(frameId, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if ((await evaluate(observerRunning, frameId)) === true) return;
        if (Date.now() > deadline) throw new Error('observer content script never started');
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
    },
    async dispose() {
      await session.detach().catch(() => undefined);
    },
  };
}

/**
 * Bounding box of the first occurrence of `needle` in the document's text, in the
 * frame's viewport. Matches across inline element boundaries (`un<b>break</b>able`).
 */
export async function textBox(target: Page | Frame, needle: string): Promise<Box> {
  const box = await target.evaluate((text) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let all = '';
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      nodes.push(node as Text);
      all += (node as Text).data;
    }
    const index = all.indexOf(text);
    if (index === -1) return null;
    // Map the match boundaries back to (text node, offset). Inline on purpose: named
    // helpers inside page.evaluate callbacks break when a bundler injects `__name`.
    const startOf = { node: nodes[0] as Text, offset: 0 };
    const endOf = { node: nodes[0] as Text, offset: 0 };
    let seen = 0;
    let startFound = false;
    for (const node of nodes) {
      if (!startFound && index < seen + node.data.length) {
        startOf.node = node;
        startOf.offset = index - seen;
        startFound = true;
      }
      if (index + text.length <= seen + node.data.length) {
        endOf.node = node;
        endOf.offset = index + text.length - seen;
        break;
      }
      seen += node.data.length;
    }
    const range = document.createRange();
    range.setStart(startOf.node, startOf.offset);
    range.setEnd(endOf.node, endOf.offset);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0);
    const rect = rects[0] ?? range.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, needle);
  if (box === null) throw new Error(`text not found: ${needle}`);
  return box;
}

/** Offset of a frame's viewport inside the top page (0,0 for the page itself). */
export async function frameOffset(target: Page | Frame): Promise<{ x: number; y: number }> {
  if ('mouse' in target) return { x: 0, y: 0 };
  const box = await (await target.frameElement()).boundingBox();
  return { x: box?.x ?? 0, y: box?.y ?? 0 };
}

/** Selection rect in the frame's viewport (main world shares the document selection). */
export async function selectionBox(target: Page | Frame): Promise<Box | null> {
  return target.evaluate(() => {
    const selection = getSelection();
    if (selection === null || selection.rangeCount === 0 || selection.isCollapsed) return null;
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  });
}

export async function selectedText(target: Page | Frame): Promise<string> {
  return target.evaluate(() => getSelection()?.toString() ?? '');
}

/** Double-click a word with the real mouse (selects it, like a user). */
export async function dblclickText(
  page: Page,
  target: Page | Frame,
  needle: string,
): Promise<void> {
  const [box, offset] = await Promise.all([textBox(target, needle), frameOffset(target)]);
  const x = offset.x + box.x + box.width / 2;
  const y = offset.y + box.y + box.height / 2;
  await page.mouse.dblclick(x, y);
}

/** Drag-select from the start of `from` to the end of `to` with the real mouse. */
export async function dragSelect(
  page: Page,
  target: Page | Frame,
  from: string,
  to: string,
): Promise<void> {
  const [a, b, offset] = await Promise.all([
    textBox(target, from),
    textBox(target, to),
    frameOffset(target),
  ]);
  const startX = offset.x + a.x + 1;
  const startY = offset.y + a.y + a.height / 2;
  const endX = offset.x + b.x + b.width - 1;
  const endY = offset.y + b.y + b.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move((startX + endX) / 2, (startY + endY) / 2, { steps: 4 });
  await page.mouse.move(endX, endY, { steps: 4 });
  await page.mouse.up();
}

/**
 * Keyboard selection: Chrome only extends an EXISTING selection with Shift+Arrow
 * (there is no caret in static text without caret browsing). So select a word by
 * double-click, then grow it with Shift+ArrowRight, releasing Shift last.
 */
export async function keyboardExtend(
  page: Page,
  target: Page | Frame,
  needle: string,
  characters: number,
  /** Arrow that grows the selection FORWARD in reading order (ArrowLeft in right-to-left text). */
  forward: 'ArrowRight' | 'ArrowLeft' = 'ArrowRight',
): Promise<void> {
  await dblclickText(page, target, needle);
  await page.keyboard.down('Shift');
  for (let i = 0; i < characters; i++) await page.keyboard.press(forward);
  await page.keyboard.up('Shift');
  // Unlike a pointer release, keyboard capture is debounced. The toolbar can still be visible
  // for the initial double-clicked word; let the final Shift+arrow selection reach it before clicks.
  await page.waitForTimeout(80);
}

/**
 * Assert the toolbar sits next to the selection: fully inside the viewport and
 * within a small gap above or below it, horizontally overlapping its span.
 */
export function expectNear(
  toolbar: Box,
  selection: Box,
  viewport: { width: number; height: number },
) {
  const problems: string[] = [];
  if (toolbar.x < 0 || toolbar.y < 0) problems.push('toolbar starts outside the viewport');
  if (toolbar.x + toolbar.width > viewport.width + 0.5) problems.push('toolbar overflows right');
  if (toolbar.y + toolbar.height > viewport.height + 0.5) problems.push('toolbar overflows bottom');
  const above = selection.y - (toolbar.y + toolbar.height);
  const below = toolbar.y - (selection.y + selection.height);
  const verticalGap = Math.min(Math.abs(above), Math.abs(below));
  const overlapsVertically = above < 0 && below < 0;
  if (!overlapsVertically && verticalGap > 24) problems.push(`vertical gap ${verticalGap}px`);
  const horizontalGap = Math.max(
    selection.x - (toolbar.x + toolbar.width),
    toolbar.x - (selection.x + selection.width),
  );
  if (horizontalGap > 8) problems.push(`horizontal gap ${horizontalGap}px`);
  return problems;
}

/** Page requests that targeted the Groq API, from any source (pages, frames, service worker). */
export function trackGroqRequests(context: BrowserContext): string[] {
  const urls: string[] = [];
  context.on('request', (request) => {
    if (request.url().includes('api.groq.com')) urls.push(request.url());
  });
  return urls;
}

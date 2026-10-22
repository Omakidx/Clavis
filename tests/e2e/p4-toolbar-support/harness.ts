import type { Frame, Page } from '@playwright/test';
import {
  launchExtension,
  waitForRegistration,
  type LaunchedExtension,
} from '../spike-b-support/extension';
import {
  expectNear,
  frameOffset,
  selectionBox,
  trackGroqRequests,
  trackWorlds,
  type Box,
} from '../spike-b-support/page';
import { startFixtureServer, type FixtureServer } from '../spike-b-support/server';
import { tb } from '../spike-b-support/toolbar';

/** One browser with site access granted (the registered observer), one fixture server. */
export interface Harness {
  server: FixtureServer;
  ext: LaunchedExtension;
  /** Every request to api.groq.com seen by any page or the worker (FR-017). */
  groqRequests: string[];
  /** Open a fixture in a new tab and wait for the observer to run in it. */
  open(path: string): Promise<{ page: Page; dispose(): Promise<void> }>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const server = await startFixtureServer();
  const ext = await launchExtension({ grantedSiteAccess: true });
  const groqRequests = trackGroqRequests(ext.context);
  await waitForRegistration(ext.serviceWorker);
  return {
    server,
    ext,
    groqRequests,
    async open(path) {
      const page = await ext.context.newPage();
      const worlds = await trackWorlds(page);
      await page.goto(`${server.origin}/${path}`);
      await worlds.waitForObserver();
      return {
        page,
        async dispose() {
          await worlds.dispose();
          await page.close();
        },
      };
    },
    async close() {
      await ext.close();
      await server.close();
    },
  };
}

/** Toolbar and selection compared in the same (top page) coordinate space; returns the problems. */
export async function nearSelectionProblems(
  page: Page,
  target: Page | Frame = page,
): Promise<string[]> {
  const [toolbar, selection, offset] = await Promise.all([
    tb(target).box(),
    selectionBox(target),
    frameOffset(target),
  ]);
  if (selection === null) return ['there is no selection'];
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  return expectNear(
    { ...toolbar, x: toolbar.x + offset.x, y: toolbar.y + offset.y },
    { ...selection, x: selection.x + offset.x, y: selection.y + offset.y },
    viewport,
  );
}

/** True when the two boxes overlap by more than `slack` pixels in both directions. */
export function overlaps(a: Box, b: Box, slack = 1): boolean {
  return (
    a.x + a.width - slack > b.x &&
    b.x + b.width - slack > a.x &&
    a.y + a.height - slack > b.y &&
    b.y + b.height - slack > a.y
  );
}

/** Tab id of the active tab, read from the extension worker (for sending a message to the page). */
export async function activeTabId(ext: LaunchedExtension): Promise<number> {
  return (await ext.serviceWorker.evaluate(
    `chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => tabs[0].id)`,
  )) as number;
}

/**
 * Viewport box of the first occurrence of `needle` in a text node, looking into OPEN shadow roots
 * too (the plain `textBox` helper walks the light DOM only). Plain JS in a string on purpose: a
 * bundler can inject helpers into evaluated functions, which do not exist in the page.
 */
export async function deepTextBox(target: Page | Frame, needle: string): Promise<Box> {
  const box = (await target.evaluate(`(() => {
    const needle = ${JSON.stringify(needle)};
    const find = (root) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (/^(SCRIPT|STYLE)$/.test((node.parentElement || {}).tagName || '')) continue;
        const index = node.data.indexOf(needle);
        if (index === -1) continue;
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + needle.length);
        const rect = Array.from(range.getClientRects()).find((r) => r.width > 0) || range.getBoundingClientRect();
        return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
      }
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) {
          const found = find(el.shadowRoot);
          if (found) return found;
        }
      }
      return null;
    };
    return find(document);
  })()`)) as Box | null;
  if (box === null) throw new Error(`text not found: ${needle}`);
  return box;
}

/** Double-click the first occurrence of `needle`, also inside open shadow roots. */
export async function dblclickDeep(page: Page, needle: string, target: Page | Frame = page) {
  const [box, offset] = await Promise.all([deepTextBox(target, needle), frameOffset(target)]);
  await page.mouse.dblclick(offset.x + box.x + box.width / 2, offset.y + box.y + box.height / 2);
  return box;
}

/** Drag from the start of `from` to the end of `to` with the real mouse, also inside open shadow roots. */
export async function dragDeep(
  page: Page,
  from: string,
  to: string,
  target: Page | Frame = page,
): Promise<void> {
  const [a, b, offset] = await Promise.all([
    deepTextBox(target, from),
    deepTextBox(target, to),
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

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { Page, Worker } from '@playwright/test';
import { normalize, type ForwardKey, type Method } from './manifest';
import { waitFor } from './detect';
import {
  hostShown,
  locate,
  perform,
  readSelection,
  clearSelection,
  type LocateSpec,
  type Located,
  type Surface,
} from './page';
import { toolbar } from './toolbar';

/**
 * Select text with real input and return where it is. Use `expectShown` afterwards: selecting
 * and seeing the toolbar are separate steps so tests can also assert that nothing appears.
 */
export async function selectText(
  page: Page,
  surface: Surface,
  spec: LocateSpec,
  method: Method,
  forwardKey: ForwardKey = 'ArrowRight',
): Promise<Located> {
  const located = await locate(surface, spec);
  if (located.obstructed.length > 0) throw new Error(`fixture: ${located.obstructed.join('; ')}`);
  const expected = normalize(spec.paragraph !== undefined ? located.text : (spec.text ?? ''));
  await perform(page, surface, { method, located, expected, forwardKey });
  return located;
}

/** Wait for the toolbar host to be displayed; false when it never appears. */
export function expectShown(surface: Surface, timeoutMs = 2000): Promise<boolean> {
  return waitFor(() => hostShown(surface), timeoutMs, 10);
}

export function expectHidden(surface: Surface, timeoutMs = 2000): Promise<boolean> {
  return waitFor(async () => !(await hostShown(surface)), timeoutMs, 10);
}

/** Make sure no selection and no toolbar are left, then let the observer forget the selection. */
export async function resetPage(page: Page, surface: Surface = page): Promise<void> {
  await clearSelection(surface);
  if (!(await expectHidden(surface, 400))) {
    await page.keyboard.press('Escape');
    await expectHidden(surface, 800);
    await clearSelection(surface);
  }
  await page.waitForTimeout(220);
}

/** The page's selection, normalised. */
export async function selectedNormalized(surface: Surface): Promise<string> {
  return normalize((await readSelection(surface)).text);
}

type TabsApi = {
  tabs: {
    query(q: object): Promise<Array<{ id?: number; url?: string }>>;
    sendMessage(id: number, m: unknown, o?: object): Promise<unknown>;
  };
};

/**
 * What the keyboard command (Alt+Shift+E, manifest `commands.explain-selection`) does once the
 * browser has delivered the shortcut: ask the page's observer to show the toolbar for the current
 * selection and move keyboard focus into it. Playwright cannot press a browser-level extension
 * shortcut, so this sends the same message the background sends. The real shortcut is covered by
 * the opt-in real-UI spec (CLAVIS_E2E_REAL_UI=1).
 */
export async function openViaCommand(
  worker: Worker,
  page: Page,
  options: { focus: boolean } = { focus: true },
): Promise<{ ok?: boolean; shown?: boolean } | undefined> {
  return worker.evaluate(
    async ([url, focus]) => {
      const api = (globalThis as unknown as { chrome: TabsApi }).chrome;
      const tab = (await api.tabs.query({})).find((t) => t.url === url);
      if (tab?.id === undefined) throw new Error('tab not found');
      return (await api.tabs.sendMessage(
        tab.id,
        { v: 1, type: 'CLAVIS_OPEN_SELECTION', ...(focus ? { focus: true } : {}) },
        { frameId: 0 },
      )) as { ok?: boolean; shown?: boolean } | undefined;
    },
    [page.url(), options.focus] as const,
  );
}

export interface MessageLog {
  /** Every runtime message the service worker received since the log was installed. */
  read(): Promise<Array<{ type: string | null; fromTab: boolean; json: string }>>;
}

/**
 * Observe the service worker's inbound messages from inside the worker (an extra onMessage
 * listener that never replies). Proves "no background AI/TTS traffic on selection alone".
 */
export async function logWorkerMessages(worker: Worker): Promise<MessageLog> {
  await worker.evaluate(() => {
    const g = globalThis as unknown as {
      __p4msgs?: Array<{ type: string | null; fromTab: boolean; json: string }>;
      chrome: {
        runtime: {
          onMessage: {
            addListener(
              fn: (message: unknown, sender: { tab?: unknown }) => boolean | undefined,
            ): void;
          };
        };
      };
    };
    if (g.__p4msgs !== undefined) return;
    g.__p4msgs = [];
    g.chrome.runtime.onMessage.addListener((message, sender) => {
      let json: string;
      try {
        json = JSON.stringify(message);
      } catch {
        json = String(message);
      }
      const type =
        typeof message === 'object' && message !== null && 'type' in message
          ? String((message as { type: unknown }).type)
          : null;
      g.__p4msgs?.push({ type, fromTab: sender.tab !== undefined, json });
      return undefined;
    });
  });
  return {
    read: async () => {
      const messages = await worker.evaluate(
        () =>
          (
            globalThis as unknown as {
              __p4msgs?: Array<{ type: string | null; fromTab: boolean; json: string }>;
            }
          ).__p4msgs ?? null,
      );
      // A restarted worker loses the listener: an empty log would then prove nothing.
      if (messages === null) throw new Error('service worker restarted: message log lost');
      return messages;
    },
  };
}

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: number;
  targets: string[];
}

const require = createRequire(import.meta.url);

/**
 * Run axe-core on what the toolbar renders. axe cannot be pointed at a node inside a CLOSED shadow
 * root (it reports "No elements found for include"), and the page cannot reach that root at all
 * (that is the security property). So the DevTools protocol reads the root's stylesheet rules and
 * markup, the test page gets an identical copy inside an OPEN shadow root, and axe runs on the
 * copy with the page's real colours behind it. Focus and hover state are not copied.
 */
export async function axeOnToolbar(surface: Surface): Promise<AxeViolation[]> {
  const snapshot = await toolbar(surface).evalIn<{ css: string; html: string }>(
    null,
    `function () {
      const css = Array.from(this.adoptedStyleSheets).flatMap((s) => Array.from(s.cssRules).map((r) => r.cssText)).join('\\n')
        + Array.from(this.querySelectorAll('style')).map((s) => s.textContent).join('\\n');
      return { css, html: this.innerHTML };
    }`,
  );
  if (snapshot === undefined) throw new Error('no toolbar to check');
  const source = readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
  await surface.addScriptTag({ content: source });
  await surface.evaluate(`((css, html) => {
    document.getElementById('p4-axe-host')?.remove();
    const host = document.createElement('div');
    host.id = 'p4-axe-host';
    host.style.cssText = 'position:fixed;top:0;left:0;width:0;height:0;';
    document.body.append(host);
    const root = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
    root.innerHTML = html;
    window.__p4axe = null;
    window.axe.run({ include: [['#p4-axe-host', '[data-clavis="panel"]']] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      rules: { region: { enabled: false } },
    }).then(
      (r) => { window.__p4axe = JSON.stringify(r.violations.map((v) => ({
        id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length,
        targets: v.nodes.map((n) => n.target.join(' ') + ' :: ' + n.failureSummary),
      }))); },
      (e) => { window.__p4axe = JSON.stringify([{ id: 'axe-error', impact: null, help: String(e), nodes: 0, targets: [] }]); },
    );
  })(${JSON.stringify(snapshot.css)}, ${JSON.stringify(snapshot.html)})`);
  const result: { json: string | null } = { json: null };
  await waitFor(
    async () => {
      result.json = await surface.evaluate(
        () => (window as unknown as { __p4axe: string | null }).__p4axe,
      );
      return result.json !== null;
    },
    15_000,
    100,
  );
  await surface.evaluate(() => document.getElementById('p4-axe-host')?.remove());
  if (result.json === null) throw new Error('axe did not finish');
  return JSON.parse(result.json) as AxeViolation[];
}

/** Whether the extension's observer runs in the page (false for restricted or excluded pages). */
export async function observerRunsIn(page: Page, waitMs = 1500): Promise<boolean> {
  const session = await page.context().newCDPSession(page);
  const worlds: Array<{ id: number; frame: string | undefined }> = [];
  session.on('Runtime.executionContextCreated', ({ context }) => {
    const aux = context.auxData as { type?: string; frameId?: string } | undefined;
    if (aux?.type === 'isolated' && context.origin.startsWith('chrome-extension://')) {
      worlds.push({ id: context.id, frame: aux.frameId });
    }
  });
  try {
    await session.send('Runtime.enable');
    // Re-enabling replays the existing contexts; give a late injection time to appear.
    const deadline = Date.now() + waitMs;
    const marker = `typeof globalThis[Symbol.for('clavis.observer')] !== 'undefined'`;
    for (;;) {
      const main = (
        (await session.send('Page.getFrameTree')) as { frameTree: { frame: { id: string } } }
      ).frameTree.frame.id;
      for (const world of worlds.filter((w) => w.frame === main)) {
        const result = (await session
          .send('Runtime.evaluate', {
            expression: marker,
            contextId: world.id,
            returnByValue: true,
          })
          .catch(() => undefined)) as { result?: { value?: boolean } } | undefined;
        if (result?.result?.value === true) return true;
      }
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await session.detach().catch(() => undefined);
  }
}

/** Id of the tab the user is looking at (query it BEFORE opening a helper extension page). */
export function activeTabId(worker: Worker): Promise<number> {
  return worker.evaluate(() =>
    chrome.tabs
      .query({ active: true, lastFocusedWindow: true })
      .then((tabs) => tabs[0]?.id as number),
  );
}

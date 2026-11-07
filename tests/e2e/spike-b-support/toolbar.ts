import type { CDPSession, Frame, Page } from '@playwright/test';

/**
 * Test access to the toolbar, which lives in a CLOSED shadow root: Playwright locators
 * cannot pierce it (that is the point, pages cannot either). The DevTools protocol can, so
 * this resolves nodes through `DOM.getDocument({ pierce: true })` and runs small functions
 * on them. Nothing here exists in the extension; no test hook is shipped.
 *
 * Mouse input goes through `page.mouse`, i.e. real trusted events, because the toolbar
 * ignores synthetic ones.
 */
interface DomNode {
  nodeId: number;
  nodeName: string;
  attributes?: string[];
  children?: DomNode[];
  contentDocument?: DomNode;
  shadowRoots?: DomNode[];
  documentURL?: string;
}

export type ActionName = 'listen' | 'slow' | 'explain' | 'trim' | 'close';

/** Selectors inside the closed root. Stable contract of the production toolbar (components/tooltip/view.ts). */
export const SEL = {
  panel: '[data-clavis="panel"]',
  toolbar: '[data-clavis="toolbar"]',
  /** After Listen or Explain: the state line (`card-note`) and the captured text (`card-text`). */
  card: '[data-clavis="card"]',
  cardNote: '[data-clavis="card-note"]',
  cardText: '[data-clavis="card-text"]',
  /** "Selection too long" message; the single action is `action('trim')`. */
  limit: '[data-clavis="limit"]',
  /** After the trim action: the exact text that will be used. */
  trimmed: '[data-clavis="trimmed"]',
  trimmedText: '[data-clavis="trimmed-text"]',
  /** A message that is not about a selection (cross-origin frame notice). */
  notice: '[data-clavis="notice"]',
  /** Visually hidden polite live region. */
  live: '[data-clavis="live"]',
  action: (name: ActionName) => `[data-action="${name}"]`,
} as const;

const sessions = new WeakMap<object, Promise<{ session: CDPSession; viaFrame: boolean }>>();

async function sessionFor(
  target: Page | Frame,
): Promise<{ session: CDPSession; viaFrame: boolean }> {
  let cached = sessions.get(target);
  if (cached === undefined) {
    cached = (async () => {
      const page = 'mouse' in target ? target : target.page();
      const context = page.context();
      if (!('mouse' in target)) {
        try {
          // Works for out-of-process (cross-origin) frames, which the page session cannot see.
          return { session: await context.newCDPSession(target), viaFrame: true };
        } catch {
          // Same-process frame: reachable through the page's own document tree.
        }
      }
      return { session: await context.newCDPSession(page), viaFrame: false };
    })();
    sessions.set(target, cached);
  }
  return cached;
}

/** The host is a child of <html>, or of the open modal <dialog> that holds the selection. */
const isHostElement = (node: DomNode, parentName: string): boolean => {
  const attrs = node.attributes ?? [];
  return (
    node.nodeName === 'DIV' &&
    (parentName === 'HTML' || parentName === 'DIALOG') &&
    attrs[attrs.indexOf('popover') + 1] === 'manual' &&
    attrs.includes('popover')
  );
};

export class ToolbarProbe {
  constructor(private readonly target: Page | Frame) {}

  private get page(): Page {
    return 'mouse' in this.target ? this.target : this.target.page();
  }

  /** Every Clavis host (`:root > div[popover=manual]`, or inside a modal dialog) in this frame's own document. */
  private async hosts(): Promise<{ session: CDPSession; hosts: DomNode[] }> {
    const { session, viaFrame } = await sessionFor(this.target);
    await session.send('DOM.enable');
    const { root } = (await session.send('DOM.getDocument', { depth: -1, pierce: true })) as {
      root: DomNode;
    };
    const wanted = 'mouse' in this.target || viaFrame ? undefined : (this.target as Frame).url();
    const found: DomNode[] = [];
    const walk = (node: DomNode, parentName: string, documentUrl: string): void => {
      if (isHostElement(node, parentName) && (wanted === undefined || documentUrl === wanted)) {
        found.push(node);
      }
      for (const child of node.children ?? []) walk(child, node.nodeName, documentUrl);
      for (const shadow of node.shadowRoots ?? []) walk(shadow, node.nodeName, documentUrl);
      // Only descend into iframes when looking for a same-process frame's host.
      if (node.contentDocument !== undefined && wanted !== undefined) {
        const doc = node.contentDocument;
        walk(doc, '#document', doc.documentURL ?? '');
      }
    };
    walk(root, '#document', root.documentURL ?? '');
    return { session, hosts: found };
  }

  async hostCount(): Promise<number> {
    return (await this.hosts()).hosts.length;
  }

  /** Run `fn` (source of a function using `this`) on a node inside the closed root. */
  async evalIn<T>(selector: string | null, fn: string): Promise<T | undefined> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.evalCurrentNode<T>(selector, fn);
      } catch (error) {
        // Preact may replace a node between CDP discovery and resolution. Re-discover it, as a
        // locator would; never retry errors from the action itself or mask a missing toolbar.
        if (attempt >= 2 || !/Could not find node|No node with given id/.test(String(error)))
          throw error;
      }
    }
  }

  private async evalCurrentNode<T>(selector: string | null, fn: string): Promise<T | undefined> {
    const { session, hosts } = await this.hosts();
    const root = hosts[0]?.shadowRoots?.[0];
    if (root === undefined) return undefined;
    let nodeId = root.nodeId;
    if (selector !== null) {
      nodeId = (
        (await session.send('DOM.querySelector', { nodeId: root.nodeId, selector })) as {
          nodeId: number;
        }
      ).nodeId;
      if (nodeId === 0) return undefined;
    }
    const { object } = (await session.send('DOM.resolveNode', { nodeId })) as {
      object: { objectId: string };
    };
    const result = (await session.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: fn,
      returnByValue: true,
    })) as { result: { value?: T } };
    return result.result.value;
  }

  /** The host's own `shadowRoot` as the PAGE sees it: must be null. */
  async pageSeesShadowRoot(): Promise<boolean | undefined> {
    return this.target.evaluate(() => {
      const host = document.querySelector(
        ':is(:root, dialog) > div[popover]',
      ) as HTMLElement | null;
      return host === null ? undefined : host.shadowRoot !== null;
    });
  }

  async isShown(selector: string = SEL.toolbar): Promise<boolean> {
    return (
      (await this.evalIn<boolean>(
        selector,
        `function () {
          const r = this.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && getComputedStyle(this).visibility !== 'hidden';
        }`,
      )) === true
    );
  }

  private async poll(done: () => Promise<boolean>, timeout: number, what: string): Promise<void> {
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        if (await done()) return;
      } catch (error) {
        // The page can move or re-render the host between two CDP calls (a node id goes stale): retry.
        if (!/Could not find node|No node with given id/.test(String(error))) throw error;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
  }

  waitShown(selector: string = SEL.toolbar, timeout = 5000): Promise<void> {
    return this.poll(() => this.isShown(selector), timeout, `${selector} to be visible`);
  }

  waitHidden(selector: string = SEL.toolbar, timeout = 5000): Promise<void> {
    return this.poll(
      async () => !(await this.isShown(selector)),
      timeout,
      `${selector} to be hidden`,
    );
  }

  /** No toolbar was ever created in this frame. */
  async expectNoHost(): Promise<void> {
    const count = await this.hostCount();
    if (count !== 0) throw new Error(`expected no toolbar host, found ${count}`);
  }

  /** Box in the frame's viewport coordinates. */
  async box(
    selector: string = SEL.toolbar,
  ): Promise<{ x: number; y: number; width: number; height: number }> {
    const box = await this.evalIn<{ x: number; y: number; width: number; height: number }>(
      selector,
      `function () { const r = this.getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; }`,
    );
    if (box === undefined) throw new Error(`no ${selector}`);
    return box;
  }

  text(selector: string): Promise<string | undefined> {
    return this.evalIn<string>(selector, `function () { return this.textContent; }`);
  }

  /** Match locator actionability: do not click coordinates from a card's first, moving render. */
  async stableBox(selector: string) {
    await this.page.bringToFront();
    let previous = await this.box(selector);
    const deadline = Date.now() + 1000;
    for (;;) {
      // Two actual frames, rather than assuming a 60 Hz display: a loaded runner can take far
      // longer than 32 ms to paint and apply the card's scheduled placement update.
      await this.target.evaluate(
        () =>
          new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Layout frames did not arrive')), 1000);
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                clearTimeout(timer);
                resolve();
              }),
            );
          }),
      );
      const current = await this.box(selector);
      if (
        current.width > 0 &&
        current.height > 0 &&
        (['x', 'y', 'width', 'height'] as const).every(
          (key) => Math.abs(current[key] - previous[key]) < 0.25,
        )
      )
        return current;
      if (Date.now() > deadline) throw new Error(`layout did not settle for ${selector}`);
      previous = current;
    }
  }

  attr(selector: string, name: string): Promise<string | null | undefined> {
    return this.evalIn<string | null>(
      selector,
      `function () { return this.getAttribute(${JSON.stringify(name)}); }`,
    );
  }

  /** Real (trusted) mouse click on an action button. */
  async click(action: ActionName): Promise<void> {
    const box = await this.stableBox(SEL.action(action));
    let offsetX = 0;
    let offsetY = 0;
    if (!('mouse' in this.target)) {
      const frameBox = await (await this.target.frameElement()).boundingBox();
      offsetX = frameBox?.x ?? 0;
      offsetY = frameBox?.y ?? 0;
    }
    await this.page.mouse.click(offsetX + box.x + box.width / 2, offsetY + box.y + box.height / 2);
  }

  async focusAction(action: ActionName): Promise<void> {
    await this.evalIn(SEL.action(action), `function () { this.focus(); }`);
  }

  /** Text of the live region (what a screen reader would be told). */
  live(): Promise<string | undefined> {
    return this.text(SEL.live);
  }

  /** Tag name of the host element's parent as the PAGE sees it: `html`, or `dialog` inside a modal dialog. */
  async hostParent(): Promise<string | undefined> {
    return this.target.evaluate(() => {
      const host = document.querySelector(':is(:root, dialog) > div[popover]');
      return host?.parentElement?.localName;
    });
  }

  focusedAction(): Promise<string | null | undefined> {
    return this.evalIn<string | null>(
      null,
      `function () { const a = this.activeElement; return a ? a.getAttribute('data-action') : null; }`,
    );
  }
}

export const tb = (target: Page | Frame): ToolbarProbe => new ToolbarProbe(target);

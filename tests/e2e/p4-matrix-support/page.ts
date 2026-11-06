import type { BrowserContext, CDPSession, Frame, Page } from '@playwright/test';
import { normalize, type ForwardKey, type Method } from './manifest';

/** A point or box in the viewport of the frame that holds the text (CSS pixels). */
export interface Pt {
  x: number;
  y: number;
}
export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type Surface = Page | Frame;

export interface LocateSpec {
  /** Unique string in the page text that contains `text` (whitespace collapsed like CSS). */
  context?: string;
  text?: string;
  /** Block selector (light DOM or open shadow roots) for paragraph targets. */
  paragraph?: string;
  startsWith?: string;
  /** Only scroll when the target is closer than this to a viewport edge. */
  margin?: number;
}

export interface Located {
  /** Text found in the DOM (whitespace collapsed). For paragraphs: the normalised block text. */
  text: string;
  /** Inline-start edge of the first character, inline-end edge of the last one, word centre. */
  start: Pt;
  end: Pt;
  center: Pt;
  /** Union of the range's client rects. */
  bounds: Box;
  /** Points whose topmost element is unrelated to the text (a fixture or layout problem). */
  obstructed: string[];
  /** Direction of the text at its start. */
  vertical: boolean;
  rtl: boolean;
}

/**
 * Probe injected into every frame of the context before page scripts run (main world). It only
 * times and observes; it never touches the toolbar. `t0` is the last real mouseup/keyup (capture
 * phase, i.e. before the extension's own listeners); `tDom` is the moment the toolbar host
 * becomes `display:block` and popover-open (the root is closed, the host is all a page can see).
 */
export const PROBE_SCRIPT = `(() => {
  if (window.__p4) return;
  const t = { t0: null, tDom: null, shownEvents: 0, hides: 0 };
  window.__p4 = t;
  // The host is a child of <html>, or of the open modal <dialog> that holds the selection.
  const host = () => document.querySelector(':is(:root, dialog) > div[popover]');
  window.__p4shown = () => {
    const h = host();
    return !!h && h.style.display === 'block' && h.matches(':popover-open');
  };
  window.__p4reset = () => { t.t0 = null; t.tDom = null; t.shownEvents = 0; t.hides = 0; };
  const mark = () => { t.t0 = performance.now(); t.tDom = null; };
  addEventListener('mouseup', mark, true);
  addEventListener('keyup', mark, true);
  let was = false;
  const check = () => {
    const now = window.__p4shown();
    if (was && !now) t.hides++;
    was = now;
    if (!now) return;
    if (t.t0 !== null && t.tDom === null) t.tDom = performance.now();
    t.shownEvents++;
  };
  new MutationObserver(check).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style', 'popover'] });
  // Frame-by-frame sampling while a test watches for flicker (a hide that is undone in the same task
  // would not be seen by the observer above, but a visible gap would).
  let watching = false;
  const sample = () => {
    if (!watching) return;
    const now = window.__p4shown();
    if (was && !now) t.hides++;
    was = now;
    requestAnimationFrame(sample);
  };
  window.__p4watch = (on) => { watching = on; if (on) { was = window.__p4shown(); requestAnimationFrame(sample); } };
})();`;

export async function installProbe(context: BrowserContext): Promise<void> {
  await context.addInitScript(PROBE_SCRIPT);
}

export const isPage = (surface: Surface): surface is Page => 'mouse' in surface;
export const pageOf = (surface: Surface): Page => (isPage(surface) ? surface : surface.page());

/** Whether the toolbar host is displayed in this document (cheap, page-side). */
export function hostShown(surface: Surface): Promise<boolean> {
  return surface.evaluate(
    () => (window as unknown as { __p4shown?: () => boolean }).__p4shown?.() === true,
  );
}

export async function resetProbe(surface: Surface): Promise<void> {
  await surface.evaluate(() => (window as unknown as { __p4reset?: () => void }).__p4reset?.());
}

export interface ProbeTiming {
  t0: number | null;
  tDom: number | null;
  /** Times the host went from displayed to hidden since the last reset. */
  hides: number;
}

/** Count hide transitions (flicker) of the toolbar host, per animation frame, until stopped. */
export async function watchHides(surface: Surface): Promise<() => Promise<number>> {
  await surface.evaluate(() => {
    const w = window as unknown as { __p4reset?: () => void; __p4watch?: (on: boolean) => void };
    w.__p4reset?.();
    w.__p4watch?.(true);
  });
  return async () => {
    return surface.evaluate(() => {
      const w = window as unknown as {
        __p4?: { hides: number };
        __p4watch?: (on: boolean) => void;
      };
      w.__p4watch?.(false);
      return w.__p4?.hides ?? 0;
    });
  };
}

export function readProbe(surface: Surface): Promise<ProbeTiming> {
  return surface.evaluate(() => {
    const p = (window as unknown as { __p4?: ProbeTiming }).__p4;
    return { t0: p?.t0 ?? null, tDom: p?.tDom ?? null, hides: p?.hides ?? 0 };
  });
}

/**
 * Wait until the content script runs in every frame of the page. Content-script worlds are not
 * visible to Playwright, so the DevTools protocol lists the isolated worlds of the extension and
 * asks each whether the observer marker exists. Out-of-process frames are not reachable this
 * way, so only same-process frames are required (all matrix fixtures are same-origin).
 */
export interface ObserverGate {
  /** Resolve once the observer runs in every frame currently in the page (or reject on timeout). */
  waitReady(timeoutMs?: number): Promise<void>;
  dispose(): Promise<void>;
}

export async function observerGate(page: Page): Promise<ObserverGate> {
  const session: CDPSession = await page.context().newCDPSession(page);
  const worlds = new Map<number, string | undefined>();
  session.on('Runtime.executionContextCreated', ({ context }) => {
    const aux = context.auxData as { type?: string; frameId?: string } | undefined;
    if (aux?.type === 'isolated' && context.origin.startsWith('chrome-extension://')) {
      worlds.set(context.id, aux.frameId);
    }
  });
  session.on('Runtime.executionContextDestroyed', ({ executionContextId }) =>
    worlds.delete(executionContextId),
  );
  session.on('Runtime.executionContextsCleared', () => worlds.clear());
  await session.send('Runtime.enable');
  const marker = `typeof globalThis[Symbol.for('clavis.observer')] !== 'undefined'`;

  type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
  const frameIds = (tree: FrameTree): string[] => [
    tree.frame.id,
    ...(tree.childFrames ?? []).flatMap(frameIds),
  ];

  async function ready(): Promise<boolean> {
    const { frameTree } = (await session.send('Page.getFrameTree')) as { frameTree: FrameTree };
    const wanted = frameIds(frameTree);
    for (const frameId of wanted) {
      const contextId = [...worlds].find(([, f]) => f === frameId)?.[0];
      if (contextId === undefined) return false;
      const result = (await session
        .send('Runtime.evaluate', { expression: marker, contextId, returnByValue: true })
        .catch(() => undefined)) as { result?: { value?: boolean } } | undefined;
      if (result?.result?.value !== true) return false;
    }
    return true;
  }

  return {
    async waitReady(timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (!(await ready())) {
        if (Date.now() > deadline) throw new Error('observer content script never started');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
    async dispose() {
      await session.detach().catch(() => undefined);
    },
  };
}

/** Offset of a frame's content box inside the top page's viewport. */
export async function frameOffset(surface: Surface): Promise<Pt> {
  if (isPage(surface)) return { x: 0, y: 0 };
  const element = await surface.frameElement();
  const box = await element.boundingBox();
  const border = await element.evaluate((el) => ({
    x: (el as HTMLElement).clientLeft,
    y: (el as HTMLElement).clientTop,
  }));
  return { x: (box?.x ?? 0) + border.x, y: (box?.y ?? 0) + border.y };
}

/** Find a child frame of the page by the path it was loaded from. */
export function frameByPath(page: Page, pathname: string): Frame {
  const frame = page.frames().find((f) => new URL(f.url()).pathname === pathname);
  if (frame === undefined) throw new Error(`no frame loaded from ${pathname}`);
  return frame;
}

/**
 * Find a target's text in the document, scroll it into a comfortable position and compute the
 * viewport points a person would press. All geometry comes from Range rects, so transforms, zoom,
 * columns, RTL and vertical writing are already applied.
 */
export async function locate(surface: Surface, spec: LocateSpec): Promise<Located> {
  const result = await surface.evaluate((s) => {
    const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
    const nodes: Text[] = [];
    const offsets: number[] = [];
    let full = '';
    let lastSpace = true;
    const visible = (el: Element | null): boolean => {
      if (el === null) return false;
      const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
      return typeof check === 'function'
        ? check.call(el, { checkVisibilityCSS: true, visibilityProperty: true })
        : true;
    };
    const walk = (root: Node): void => {
      for (let node = root.firstChild; node !== null; node = node.nextSibling) {
        if (node.nodeType === 3) {
          const parent = node.parentElement;
          if (parent === null || SKIP.has(parent.tagName) || !visible(parent)) continue;
          const data = (node as Text).data;
          for (let i = 0; i < data.length; i++) {
            const ch = data[i] as string;
            if (ch === '\u00ad') continue;
            const isSpace = /[ \t\r\n\f]/.test(ch);
            if (isSpace && lastSpace) continue;
            full += isSpace || ch === '\u00a0' ? ' ' : ch;
            nodes.push(node as Text);
            offsets.push(i);
            lastSpace = isSpace;
          }
        } else if (node.nodeType === 1) {
          const el = node as Element;
          if (SKIP.has(el.tagName)) continue;
          walk(el);
          if (el.shadowRoot !== null) walk(el.shadowRoot);
        }
      }
    };
    walk(document);

    const deepFind = (selector: string): Element | null => {
      const find = (root: Document | ShadowRoot | Element): Element | null => {
        const direct = root.querySelector(selector);
        if (direct !== null) return direct;
        for (const el of Array.from(root.querySelectorAll('*'))) {
          if (el.shadowRoot !== null) {
            const hit = find(el.shadowRoot);
            if (hit !== null) return hit;
          }
        }
        return null;
      };
      return find(document);
    };

    let startIndex: number;
    let length: number;
    let anchorText: string;
    let blockText = '';
    if (s.paragraph !== undefined) {
      const block = deepFind(s.paragraph);
      if (block === null) return { error: `paragraph ${s.paragraph} not found` };
      blockText = (block as HTMLElement).innerText.replace(/[\u00ad\u200b\ufeff]/g, '');
      const prefix = s.startsWith ?? '';
      const insideBlock = (node: Node): boolean => {
        for (let n: Node | null = node; n !== null;) {
          if (n === block) return true;
          n = n.parentNode ?? (n as ShadowRoot).host ?? null;
        }
        return false;
      };
      let at = nodes.findIndex((node) => insideBlock(node));
      while (at !== -1 && full[at] === ' ') at++;
      if (at === -1 || !full.startsWith(prefix, at)) {
        return { error: `paragraph ${s.paragraph} does not start with "${prefix}"` };
      }
      // Click the middle of the first word of the paragraph.
      const first = prefix.split(' ')[0] as string;
      startIndex = at;
      length = first.length;
      anchorText = first;
    } else {
      const context = s.context ?? s.text ?? '';
      const text = s.text ?? '';
      const at = full.indexOf(context);
      if (at === -1) return { error: `context not found: ${context}` };
      if (full.indexOf(context, at + 1) !== -1) return { error: `context not unique: ${context}` };
      const within = context.indexOf(text);
      if (within === -1) return { error: 'text not inside its context' };
      startIndex = at + within;
      length = text.length;
      anchorText = text;
    }

    const rangeFor = (from: number, to: number): Range => {
      const range = document.createRange();
      range.setStart(nodes[from] as Text, offsets[from] as number);
      range.setEnd(nodes[to - 1] as Text, (offsets[to - 1] as number) + 1);
      return range;
    };
    const rectsOf = (range: Range): DOMRect[] =>
      Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    const margin = s.margin ?? 110;
    {
      const probe = rectsOf(rangeFor(startIndex, startIndex + length));
      const first = probe[0];
      const last = probe[probe.length - 1];
      const outside =
        first === undefined ||
        last === undefined ||
        first.top < margin ||
        last.bottom > vh - margin ||
        first.left < 8 ||
        last.right > vw - 8;
      if (outside) {
        const parent = (nodes[startIndex] as Text).parentElement;
        parent?.scrollIntoView({ block: 'center', inline: 'center' });
      }
    }

    const full0 = rangeFor(startIndex, startIndex + length);
    const rects = rectsOf(full0);
    if (rects.length === 0) return { error: 'target has no rendered boxes' };
    const firstChar = rectsOf(rangeFor(startIndex, startIndex + 1))[0];
    const lastChar = rectsOf(rangeFor(startIndex + length - 1, startIndex + length))[0];
    const midIndex = startIndex + Math.floor(length / 2);
    const midChar = rectsOf(rangeFor(midIndex, midIndex + 1))[0];
    if (firstChar === undefined || lastChar === undefined || midChar === undefined) {
      return { error: 'a boundary character has no box' };
    }
    const styleOf = (index: number): CSSStyleDeclaration =>
      getComputedStyle((nodes[index] as Text).parentElement as Element);
    const startStyle = styleOf(startIndex);
    const vertical = /^(vertical|sideways)/.test(startStyle.writingMode);
    const rtl = !vertical && startStyle.direction === 'rtl';
    const eps = (size: number): number => Math.max(0.5, Math.min(1.5, size / 4));
    const start = vertical
      ? { x: firstChar.left + firstChar.width / 2, y: firstChar.top + eps(firstChar.height) }
      : rtl
        ? { x: firstChar.right - eps(firstChar.width), y: firstChar.top + firstChar.height / 2 }
        : { x: firstChar.left + eps(firstChar.width), y: firstChar.top + firstChar.height / 2 };
    const endStyle = styleOf(startIndex + length - 1);
    const endRtl =
      !/^(vertical|sideways)/.test(endStyle.writingMode) && endStyle.direction === 'rtl';
    const end = vertical
      ? { x: lastChar.left + lastChar.width / 2, y: lastChar.bottom - eps(lastChar.height) }
      : endRtl
        ? { x: lastChar.left + eps(lastChar.width), y: lastChar.top + lastChar.height / 2 }
        : { x: lastChar.right - eps(lastChar.width), y: lastChar.top + lastChar.height / 2 };
    const center = { x: midChar.left + midChar.width / 2, y: midChar.top + midChar.height / 2 };

    const deepHit = (x: number, y: number): Element | null => {
      let hit: Element | null = document.elementFromPoint(x, y);
      while (hit?.shadowRoot) {
        const inner: Element | null = hit.shadowRoot.elementFromPoint(x, y);
        if (inner === null || inner === hit) break;
        hit = inner;
      }
      return hit;
    };
    const composedContains = (outer: Element, inner: Element | null): boolean => {
      for (let n: Node | null = inner; n !== null;) {
        if (n === outer) return true;
        n = n.parentNode ?? (n as ShadowRoot).host ?? null;
      }
      return false;
    };
    const obstructed: string[] = [];
    const checks: Array<[string, { x: number; y: number }, number]> = [
      ['start', start, startIndex],
      ['center', center, midIndex],
      ['end', end, startIndex + length - 1],
    ];
    for (const [name, point, index] of checks) {
      const owner = (nodes[index] as Text).parentElement as Element;
      const hit = deepHit(point.x, point.y);
      if (
        point.x < 0 ||
        point.y < 0 ||
        point.x > vw ||
        point.y > vh ||
        hit === null ||
        !(composedContains(owner, hit) || composedContains(hit, owner))
      ) {
        obstructed.push(
          `${name} at ${Math.round(point.x)},${Math.round(point.y)} hits ${hit?.tagName ?? 'nothing'}`,
        );
      }
    }
    const left = Math.min(...rects.map((r) => r.left));
    const top = Math.min(...rects.map((r) => r.top));
    const right = Math.max(...rects.map((r) => r.right));
    const bottom = Math.max(...rects.map((r) => r.bottom));
    return {
      text: s.paragraph !== undefined ? blockText : anchorText,
      start,
      end,
      center,
      bounds: { x: left, y: top, width: right - left, height: bottom - top },
      obstructed,
      vertical,
      rtl,
    };
  }, spec);
  if ('error' in result) throw new Error(`locate: ${result.error}`);
  return result as Located;
}

export interface Selected {
  text: string;
  rects: Box[];
  bounds: Box | null;
}

/**
 * The page's own selection, as the page sees it. A selection inside an open shadow root is
 * retargeted to the host (`isCollapsed` is true and the range collapses onto the host), so the
 * text comes from `toString()` and the rects from `getComposedRanges` where available.
 */
export function readSelection(surface: Surface): Promise<Selected> {
  return surface.evaluate(() => {
    const selection = getSelection();
    if (selection === null) return { text: '', rects: [], bounds: null };
    const text = selection.toString();
    if (text === '') return { text, rects: [], bounds: null };
    const roots: ShadowRoot[] = [];
    const collect = (root: Document | ShadowRoot): void => {
      for (const el of Array.from(root.querySelectorAll('*'))) {
        if (el.shadowRoot !== null) {
          roots.push(el.shadowRoot);
          collect(el.shadowRoot);
        }
      }
    };
    collect(document);
    const composed = (
      selection as Selection & {
        getComposedRanges?: (o: { shadowRoots: ShadowRoot[] }) => StaticRange[];
      }
    ).getComposedRanges;
    let range: Range | null = null;
    if (selection.rangeCount > 0 && !selection.isCollapsed) range = selection.getRangeAt(0);
    else if (typeof composed === 'function') {
      const [first] = composed.call(selection, { shadowRoots: roots });
      if (first !== undefined) {
        range = document.createRange();
        range.setStart(first.startContainer, first.startOffset);
        range.setEnd(first.endContainer, first.endOffset);
      }
    }
    if (range === null) return { text, rects: [], bounds: null };
    const rects = Array.from(range.getClientRects())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => ({ x: r.left, y: r.top, width: r.width, height: r.height }));
    const b = range.getBoundingClientRect();
    return { text, rects, bounds: { x: b.left, y: b.top, width: b.width, height: b.height } };
  });
}

/** Remove the page selection (the page-side way to reset between attempts). */
export function clearSelection(surface: Surface): Promise<void> {
  return surface.evaluate(() => getSelection()?.removeAllRanges());
}

export interface InputPlan {
  method: Method;
  located: Located;
  /** The normalised text the user is trying to select (the keyboard method grows towards it). */
  expected: string;
  forwardKey: ForwardKey;
}

const step = (n: number): number => Math.max(2, Math.min(8, n));

export const backKeyFor = (key: ForwardKey): string =>
  key === 'ArrowRight' ? 'ArrowLeft' : key === 'ArrowLeft' ? 'ArrowRight' : 'ArrowUp';

/**
 * Perform one selection method with REAL input (trusted events) through the top page.
 *
 * keyboard: Chrome has no caret in static text (a click gives a collapsed "Caret" selection that
 * Shift+arrow does not extend; verified), so a keyboard user starts from a double-clicked first
 * word and grows or shrinks the selection with Shift+arrow until it covers the target.
 */
export async function perform(page: Page, surface: Surface, plan: InputPlan): Promise<void> {
  const offset = await frameOffset(surface);
  const abs = (p: Pt): Pt => ({ x: offset.x + p.x, y: offset.y + p.y });
  const { located, expected } = plan;
  const start = abs(located.start);
  const end = abs(located.end);
  const center = abs(located.center);
  switch (plan.method) {
    case 'dblclick':
      await page.mouse.dblclick(center.x, center.y);
      return;
    case 'triple': {
      await page.mouse.move(center.x, center.y);
      for (const clickCount of [1, 2, 3]) {
        await page.mouse.down({ clickCount });
        await page.mouse.up({ clickCount });
      }
      return;
    }
    case 'drag': {
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const steps = step(Math.round(Math.hypot(dx, dy) / 120));
      await page.mouse.move(start.x + dx / 2, start.y + dy / 2, { steps });
      await page.mouse.move(end.x, end.y, { steps });
      await page.mouse.up();
      return;
    }
    case 'keyboard': {
      // Playwright's macOS key table maps Down to line motion even in vertical text. Right
      // supplies its character-motion command, which these LTR Japanese targets require.
      const forwardKey =
        located.vertical && process.platform === 'darwin' ? 'ArrowRight' : plan.forwardKey;
      await page.mouse.dblclick(start.x, start.y);
      // Japanese word-selection direction differs between platforms. Collapse to its reading
      // start before extending, so Shift+Down always grows from the same boundary.
      if (located.vertical) await page.keyboard.press(backKeyFor(forwardKey));
      let current = normalize((await readSelection(surface)).text);
      await page.keyboard.down('Shift');
      try {
        const first = expected.startsWith(current) ? expected.length - current.length : 0;
        for (let i = 0; i < first; i++) await page.keyboard.press(forwardKey);
        for (let i = 0; i < 6; i++) {
          current = normalize((await readSelection(surface)).text);
          if (current === expected) break;
          if (expected.startsWith(current)) await page.keyboard.press(forwardKey);
          else if (current.startsWith(expected)) await page.keyboard.press(backKeyFor(forwardKey));
          else break;
        }
      } finally {
        await page.keyboard.up('Shift');
      }
      return;
    }
  }
}

/** Axis-aligned overlap with a tolerance (CSS pixels). */
export function overlaps(a: Box, b: Box, tolerance = 0.5): boolean {
  return (
    a.x < b.x + b.width - tolerance &&
    a.x + a.width > b.x + tolerance &&
    a.y < b.y + b.height - tolerance &&
    a.y + a.height > b.y + tolerance
  );
}

/**
 * Whether the toolbar sits next to the selection: inside the viewport and within `gap` pixels
 * above or below it (or overlapping vertically when it was pushed to the edge), horizontally
 * within `slack` of the selection's span. Returns the list of problems (empty means near).
 */
export function nearProblems(
  toolbar: Box,
  selection: Box,
  viewport: { width: number; height: number },
  gap = 40,
  slack = 12,
): string[] {
  const problems: string[] = [];
  if (toolbar.x < -0.5 || toolbar.y < -0.5) problems.push('starts outside the viewport');
  if (toolbar.x + toolbar.width > viewport.width + 0.5) problems.push('overflows right');
  if (toolbar.y + toolbar.height > viewport.height + 0.5) problems.push('overflows bottom');
  const above = selection.y - (toolbar.y + toolbar.height);
  const below = toolbar.y - (selection.y + selection.height);
  const vertical = Math.min(Math.abs(above), Math.abs(below));
  if (!(above < 0 && below < 0) && vertical > gap)
    problems.push(`vertical gap ${Math.round(vertical)}px`);
  const horizontal = Math.max(
    selection.x - (toolbar.x + toolbar.width),
    toolbar.x - (selection.x + selection.width),
  );
  if (horizontal > slack) problems.push(`horizontal gap ${Math.round(horizontal)}px`);
  return problems;
}

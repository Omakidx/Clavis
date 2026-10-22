/** Replace the document body with parsed HTML (innerHTML assignment is lint-forbidden). */
export function setBody(html: string): void {
  const fragment = document.createRange().createContextualFragment(html);
  document.body.replaceChildren(fragment);
}

/** First text node whose data contains `needle`. */
export function findText(needle: string, root: Node = document.body): Text {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if ((node as Text).data.includes(needle)) return node as Text;
  }
  throw new Error(`No text node contains "${needle}"`);
}

/** Select `needle` inside the first text node that contains it, as a user selection. */
export function selectText(needle: string, root: Node = document.body): Range {
  const node = findText(needle, root);
  const start = node.data.indexOf(needle);
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, start + needle.length);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  return range;
}

/**
 * jsdom has no layout and no `Range.getClientRects`: define it so every Range
 * reports the given boxes (default: one visible 100x20 box). Pass `[]` for "not rendered".
 */
export function mockRangeRects(boxes: Array<Partial<DOMRect>> | undefined = undefined): void {
  const list = (boxes ?? [{}]).map((rect) => ({
    left: 100,
    top: 200,
    right: 200,
    bottom: 220,
    width: 100,
    height: 20,
    ...rect,
  }));
  const union = list.reduce(
    (a, b) => ({
      left: Math.min(a.left, b.left),
      top: Math.min(a.top, b.top),
      right: Math.max(a.right, b.right),
      bottom: Math.max(a.bottom, b.bottom),
    }),
    list[0] ?? { left: 0, top: 0, right: 0, bottom: 0 },
  );
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    writable: true,
    value: () => list,
  });
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value: () => ({ ...union, width: union.right - union.left, height: union.bottom - union.top }),
  });
}

export function clearSelection(): void {
  window.getSelection()?.removeAllRanges();
}

type Box = [left: number, top: number, right: number, bottom: number];
const DEFAULT_TEXT_BOX: Box = [100, 200, 300, 220];

function parseBox(value: string | undefined): Box | undefined {
  return value === undefined ? undefined : (value.split(',').map(Number) as Box);
}

/**
 * jsdom has no layout. Drive geometry from attributes so tests can describe how text is hidden:
 *   data-rect="none"          the text has no boxes (font-size:0, zero-size glyphs)
 *   data-rect="l,t,r,b"       the box of the text nodes whose parent is this element
 *   data-box="l,t,r,b"        this element's own border box (getBoundingClientRect)
 *   data-style='{"clip":..}'  extra computed-style values jsdom cannot compute itself
 * Text without `data-rect` gets a visible default box.
 */
export function mockLayout(): void {
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    writable: true,
    value(this: Range) {
      const owner = this.startContainer.nodeType === 3 ? this.startContainer.parentElement : null;
      const rect = owner?.closest('[data-rect]')?.getAttribute('data-rect') ?? undefined;
      if (rect === 'none') return [];
      const [left, top, right, bottom] = parseBox(rect) ?? DEFAULT_TEXT_BOX;
      return [{ left, top, right, bottom, width: right - left, height: bottom - top }];
    },
  });
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: Element) {
      const [left, top, right, bottom] = parseBox(this.getAttribute('data-box') ?? undefined) ?? [
        0, 0, 1000, 1000,
      ];
      return { left, top, right, bottom, width: right - left, height: bottom - top };
    },
  });
  const original = window.getComputedStyle.bind(window);
  Object.defineProperty(window, 'getComputedStyle', {
    configurable: true,
    writable: true,
    value(element: Element) {
      const base = original(element);
      const extra = JSON.parse(element.getAttribute('data-style') ?? '{}') as Record<
        string,
        string
      >;
      return new Proxy(base, {
        get: (target, key) =>
          typeof key === 'string' && key in extra
            ? extra[key]
            : (target as unknown as Record<string | symbol, unknown>)[key],
      });
    },
  });
}

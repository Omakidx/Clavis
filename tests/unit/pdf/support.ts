/** Shared jsdom helpers for the PDF reader's DOM tests (PDF.js text-layer shaped markup). */

export interface PageSpec {
  number: number;
  spans: string[];
  /** Per-span attributes, by index (for example `{ 'aria-hidden': 'true' }`). */
  attrs?: Record<number, Record<string, string>>;
}

/** `.page[data-page-number] > .textLayer > span + br ...`, as PDF.js builds it; appended to `body`. */
export function buildViewer(pages: PageSpec[]): HTMLElement {
  const root = document.createElement('div');
  for (const p of pages) {
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset['pageNumber'] = String(p.number);
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    p.spans.forEach((text, i) => {
      const span = document.createElement('span');
      span.textContent = text;
      for (const [name, value] of Object.entries(p.attrs?.[i] ?? {}))
        span.setAttribute(name, value);
      layer.append(span, document.createElement('br'));
    });
    layer.append(Object.assign(document.createElement('div'), { className: 'endOfContent' }));
    page.append(layer);
    root.append(page);
  }
  document.body.append(root);
  return root;
}

export const layerOf = (root: HTMLElement, page: number): HTMLElement =>
  root.querySelector<HTMLElement>(`.page[data-page-number="${page}"] .textLayer`)!;

export const spanTexts = (layer: Element): Text[] =>
  Array.from(layer.querySelectorAll('span')).map((s) => s.firstChild as Text);

/** Select from (`from`, offset) to (`to`, offset) as a user selection. */
export function select(from: Node, fromOffset: number, to: Node, toOffset: number): Selection {
  const selection = document.getSelection()!;
  selection.setBaseAndExtent(from, fromOffset, to, toOffset);
  return selection;
}

/**
 * jsdom has no layout. `data-box="l,t,r,b"` on a text span gives the box of its text; the text
 * layer itself gets a 600x800 page box at the origin; the viewer container (`data-viewer`) gets
 * the box in its own `data-box`. Text without a box gets a small visible default inside the page.
 */
export function mockPdfLayout(): void {
  const parse = (value: string | null): number[] | null =>
    value === null ? null : value.split(',').map(Number);
  const rectOf = ([left = 0, top = 0, right = 0, bottom = 0]: number[]) => ({
    left,
    top,
    right,
    bottom,
    width: right - left,
    height: bottom - top,
    x: left,
    y: top,
  });
  const textBox = (range: Range): number[] => {
    const owner = range.startContainer.nodeType === 3 ? range.startContainer.parentElement : null;
    return parse(owner?.getAttribute('data-box') ?? null) ?? [50, 150, 150, 170];
  };
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: Range) {
      return rectOf(textBox(this));
    },
  });
  Object.defineProperty(Range.prototype, 'getClientRects', {
    configurable: true,
    writable: true,
    value(this: Range) {
      return [rectOf(textBox(this))];
    },
  });
  Object.defineProperty(Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    writable: true,
    value(this: Element) {
      const own = parse(this.getAttribute('data-box'));
      if (own !== null) return rectOf(own);
      if (this.classList.contains('textLayer')) return rectOf([0, 0, 600, 800]);
      if (this.classList.contains('viewer')) return rectOf([0, 100, 1000, 700]);
      return rectOf([0, 0, 0, 0]);
    },
  });
}

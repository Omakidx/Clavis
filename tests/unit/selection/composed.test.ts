// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasSelection, selectionRange } from '../../../lib/selection/composed';
import { captureSelection } from '../../../lib/selection/capture';
import { clearSelection, mockRangeRects, setBody } from './dom';

/**
 * Chrome retargets a selection inside an open shadow root to the host: the range collapses
 * next to the host while `toString()` still has the text. jsdom does not implement that or
 * `getComposedRanges`, so these tests build the retargeted Selection by hand and give it the
 * `getComposedRanges` Chrome has. What is under test is OUR logic: which roots we pass, how
 * nested roots are followed, and what we do with the answer.
 */
afterEach(() => {
  vi.restoreAllMocks();
  clearSelection();
});

function shadowPage(): { host: HTMLElement; root: ShadowRoot; text: Text; nestedText: Text } {
  setBody('<section><div id="host"></div></section><p>Light</p>');
  const host = document.getElementById('host') as HTMLElement;
  const root = host.attachShadow({ mode: 'open' });
  const p = document.createElement('p');
  p.textContent = 'Shadow paragraph with words';
  const inner = document.createElement('div');
  root.append(p, inner);
  const nestedRoot = inner.attachShadow({ mode: 'open' });
  const span = document.createElement('span');
  span.textContent = 'nested words';
  nestedRoot.append(span);
  return { host, root, text: p.firstChild as Text, nestedText: span.firstChild as Text };
}

function fakeSelection(options: {
  /** Where the retargeted (plain) range sits. */
  plain: [Node, number];
  text: string;
  composed?: (roots: ShadowRoot[]) => StaticRange[];
}): Selection {
  const range = document.createRange();
  range.setStart(...options.plain);
  range.collapse(true);
  const selection = {
    rangeCount: 1,
    isCollapsed: true,
    getRangeAt: () => range,
    toString: () => options.text,
    ...(options.composed === undefined
      ? {}
      : {
          getComposedRanges: vi.fn(({ shadowRoots }: { shadowRoots: ShadowRoot[] }) =>
            options.composed?.(shadowRoots),
          ),
        }),
  };
  return selection as unknown as Selection;
}

describe('hasSelection', () => {
  it('is false without a selection and for a plain caret', () => {
    setBody('<p>Light text</p>');
    expect(hasSelection(null)).toBe(false);
    expect(hasSelection(window.getSelection())).toBe(false);
    const caret = fakeSelection({ plain: [document.body, 0], text: '' });
    expect(hasSelection(caret)).toBe(false);
  });

  it('is true for a collapsed range parked next to an open shadow host (a retargeted selection)', () => {
    const { host } = shadowPage();
    const parent = host.parentNode as Node;
    const index = Array.from(parent.childNodes).indexOf(host);
    expect(hasSelection(fakeSelection({ plain: [parent, index], text: 'Shadow' }))).toBe(true);
    expect(hasSelection(fakeSelection({ plain: [parent, index + 1], text: 'Shadow' }))).toBe(true);
  });

  it('is true for an ordinary non-collapsed range', () => {
    setBody('<p>Light text</p>');
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p') as Element);
    window.getSelection()?.addRange(range);
    expect(hasSelection(window.getSelection())).toBe(true);
  });
});

describe('selectionRange', () => {
  it('returns the plain range when the browser has no getComposedRanges', () => {
    setBody('<p>Light text</p>');
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p') as Element);
    window.getSelection()?.addRange(range);
    const result = selectionRange(window.getSelection() as Selection);
    expect(result?.toString()).toBe('Light text');
    expect(result).not.toBe(range);
  });

  it('returns null without a range', () => {
    expect(selectionRange(window.getSelection() as Selection)).toBeNull();
  });

  it('asks for the open root next to the host and returns a live Range inside it', () => {
    const { host, root, text } = shadowPage();
    const parent = host.parentNode as Node;
    const selection = fakeSelection({
      plain: [parent, Array.from(parent.childNodes).indexOf(host)],
      text: 'paragraph',
      composed: () => [
        new StaticRange({
          startContainer: text,
          startOffset: 7,
          endContainer: text,
          endOffset: 16,
        }),
      ],
    });
    const range = selectionRange(selection);
    expect(selection.getComposedRanges).toHaveBeenCalledWith({ shadowRoots: [root] });
    expect(range?.startContainer).toBe(text);
    expect([range?.startOffset, range?.endOffset]).toEqual([7, 16]);
    expect(range?.toString()).toBe('paragraph');
    expect(range?.collapsed).toBe(false);
  });

  it('follows nested open roots, one level per call, until the boundary is real', () => {
    const { host, root, nestedText } = shadowPage();
    const inner = root.querySelector('div') as HTMLElement;
    const nestedRoot = inner.shadowRoot as ShadowRoot;
    const parent = host.parentNode as Node;
    const seen: ShadowRoot[][] = [];
    const selection = fakeSelection({
      plain: [parent, Array.from(parent.childNodes).indexOf(host)],
      text: 'nested',
      composed: (roots) => {
        seen.push([...roots]);
        // With only the outer root the boundary stops at the nested host's position.
        return roots.includes(nestedRoot)
          ? [
              new StaticRange({
                startContainer: nestedText,
                startOffset: 0,
                endContainer: nestedText,
                endOffset: 6,
              }),
            ]
          : [
              new StaticRange({
                startContainer: root,
                startOffset: 1,
                endContainer: root,
                endOffset: 2,
              }),
            ];
      },
    });
    const range = selectionRange(selection);
    expect(seen).toEqual([[root], [root, nestedRoot]]);
    expect(range?.toString()).toBe('nested');
  });

  it('stops at the nesting limit instead of looping on a hostile page', () => {
    setBody('<div id="a"></div>');
    let current = document.getElementById('a') as HTMLElement;
    for (let i = 0; i < 20; i++) {
      const inner = document.createElement('div');
      current.attachShadow({ mode: 'open' }).append(inner);
      current = inner;
    }
    const a = document.getElementById('a') as HTMLElement;
    const calls: number[] = [];
    const selection = fakeSelection({
      plain: [document.body, 0],
      text: 'x',
      composed: (roots) => {
        calls.push(roots.length);
        const last = roots[roots.length - 1] as ShadowRoot;
        return [
          new StaticRange({
            startContainer: last,
            startOffset: 0,
            endContainer: last,
            endOffset: 1,
          }),
        ];
      },
    });
    expect(a.shadowRoot).not.toBeNull();
    selectionRange(selection);
    expect(calls.length).toBeLessThanOrEqual(8);
  });

  it('keeps the plain range when the composed one spans two trees (a Range cannot)', () => {
    const { host, text } = shadowPage();
    const light = document.querySelector('p') as Element;
    const parent = host.parentNode as Node;
    const selection = fakeSelection({
      plain: [parent, Array.from(parent.childNodes).indexOf(host)],
      text: 'both',
      composed: () => [
        new StaticRange({
          startContainer: light.firstChild as Text,
          startOffset: 0,
          endContainer: text,
          endOffset: 3,
        }),
      ],
    });
    const range = selectionRange(selection);
    expect(range?.startContainer).toBe(parent);
    expect(range?.collapsed).toBe(true);
  });

  it('does nothing special without an open root next to the range (closed roots are out of reach)', () => {
    setBody('<section><div id="closed"></div></section>');
    (document.getElementById('closed') as HTMLElement).attachShadow({ mode: 'closed' });
    const section = document.querySelector('section') as Node;
    const selection = fakeSelection({
      plain: [section, 0],
      text: 'hidden words',
      composed: () => [],
    });
    expect(selectionRange(selection)?.collapsed).toBe(true);
    expect(selection.getComposedRanges).not.toHaveBeenCalled();
  });
});

describe('captureSelection in an open shadow root', () => {
  it('captures the text, the context inside the shadow tree and a usable range', () => {
    mockRangeRects();
    const { host, root, text } = shadowPage();
    const parent = host.parentNode as Node;
    const index = Array.from(parent.childNodes).indexOf(host);
    const range = document.createRange();
    range.setStart(parent, index);
    range.collapse(true);
    const selection = {
      rangeCount: 1,
      isCollapsed: true,
      anchorNode: parent,
      focusNode: parent,
      getRangeAt: () => range,
      toString: () => 'paragraph',
      getComposedRanges: () => [
        new StaticRange({
          startContainer: text,
          startOffset: 7,
          endContainer: text,
          endOffset: 16,
        }),
      ],
    } as unknown as Selection;
    vi.spyOn(window, 'getSelection').mockReturnValue(selection);

    const captured = captureSelection();
    expect(captured?.snapshot.text).toBe('paragraph');
    expect(captured?.snapshot.kind).toBe('word');
    expect(captured?.snapshot.contextBefore).toBe('Shadow');
    expect(captured?.snapshot.contextAfter).toBe('with words');
    expect(captured?.range.startContainer).toBe(text);
    expect(root.contains(captured?.range.startContainer ?? null)).toBe(true);
    expect(captured?.getRects()).not.toBeNull();
  });

  it('ignores an input inside a shadow root that has focus', () => {
    mockRangeRects();
    const { host, root, text } = shadowPage();
    const input = document.createElement('input');
    root.append(input);
    input.focus();
    const parent = host.parentNode as Node;
    const range = document.createRange();
    range.setStart(parent, Array.from(parent.childNodes).indexOf(host));
    range.collapse(true);
    vi.spyOn(window, 'getSelection').mockReturnValue({
      rangeCount: 1,
      isCollapsed: true,
      anchorNode: parent,
      focusNode: parent,
      getRangeAt: () => range,
      toString: () => 'paragraph',
      getComposedRanges: () => [
        new StaticRange({
          startContainer: text,
          startOffset: 7,
          endContainer: text,
          endOffset: 16,
        }),
      ],
    } as unknown as Selection);
    expect(captureSelection()).toBeNull();
  });
});

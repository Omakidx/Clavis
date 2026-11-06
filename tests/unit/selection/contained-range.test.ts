// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectionWithin } from '../../../lib/selection/contained-range';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function rangeFor(element: Element): Range {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  return range;
}

function mockSelection(doc: Document, range: Range, composed?: Range): void {
  vi.spyOn(doc, 'getSelection').mockReturnValue({
    rangeCount: 1,
    getRangeAt: () => range,
    ...(composed === undefined ? {} : { getComposedRanges: () => [composed] }),
  } as unknown as Selection);
}

describe('selectionWithin an owned container', () => {
  it('resolves a closed shadow selection through its explicitly held root', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = host.attachShadow({ mode: 'closed' });
    const leaf = document.createElement('p');
    leaf.textContent = 'riverbank';
    root.append(leaf);
    const actual = rangeFor(leaf);
    const retargeted = document.createRange();
    retargeted.selectNode(host);
    const getComposedRanges = vi.fn(() => [actual]);
    vi.spyOn(document, 'getSelection').mockReturnValue({
      rangeCount: 1,
      getRangeAt: () => retargeted,
      getComposedRanges,
    } as unknown as Selection);
    expect(selectionWithin(leaf)?.toString()).toBe('riverbank');
    expect(getComposedRanges).toHaveBeenCalledWith({ shadowRoots: [root] });
    expect(host.shadowRoot).toBeNull();
  });

  it('uses only the plain range when contained and composed ranges are unavailable', () => {
    const leaf = document.createElement('p');
    leaf.textContent = 'water';
    document.body.append(leaf);
    mockSelection(document, rangeFor(leaf));
    expect(selectionWithin(leaf)?.toString()).toBe('water');
  });

  it('rejects outside and partially contained ranges', () => {
    const leaf = document.createElement('p');
    leaf.textContent = 'inside';
    const outside = document.createElement('p');
    outside.textContent = 'outside';
    document.body.append(leaf, outside);
    mockSelection(document, rangeFor(outside));
    expect(selectionWithin(leaf)).toBeNull();
    const mixed = document.createRange();
    mixed.setStart(leaf.firstChild!, 0);
    mixed.setEnd(outside.firstChild!, 3);
    mockSelection(document, mixed);
    expect(selectionWithin(leaf)).toBeNull();
  });

  it('rejects collapsed selections and a missing selection', () => {
    const leaf = document.createElement('p');
    leaf.textContent = 'word';
    document.body.append(leaf);
    const collapsed = rangeFor(leaf);
    collapsed.collapse(true);
    mockSelection(document, collapsed);
    expect(selectionWithin(leaf)).toBeNull();
    vi.spyOn(document, 'getSelection').mockReturnValue(null);
    expect(selectionWithin(leaf)).toBeNull();
  });

  it('reads the container document rather than another frame selection', () => {
    const frame = document.createElement('iframe');
    document.body.append(frame);
    const doc = frame.contentDocument!;
    const leaf = doc.createElement('p');
    leaf.textContent = 'frame output';
    doc.body.append(leaf);
    mockSelection(doc, rangeFor(leaf));
    vi.spyOn(document, 'getSelection').mockReturnValue(null);
    expect(selectionWithin(leaf)?.toString()).toBe('frame output');
  });
});

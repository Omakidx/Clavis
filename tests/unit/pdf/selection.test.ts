// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../../lib/config/constants';
import { selectionSnapshotSchema } from '../../../lib/contracts';
import { trimCaptured } from '../../../lib/selection/capture';
import { markOwnUi } from '../../../lib/selection/own-ui';
import {
  RAW_SELECTION_CAP,
  capturePdfSelection,
  pageOfLayer,
  textLayerOf,
  viewerRects,
} from '../../../lib/pdf/selection';
import { buildViewer, layerOf, mockPdfLayout, select, spanTexts } from './support';

beforeEach(() => mockPdfLayout());
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

const capture = (root: HTMLElement) => capturePdfSelection(window, root);

describe('capturePdfSelection', () => {
  it('builds a schema-valid pdf snapshot: source, page, kind, text and same-page context', () => {
    const root = buildViewer([
      { number: 2, spans: ['Elsewhere.'] },
      {
        number: 3,
        spans: ['The quick brown fox jumps over the lazy dog.', 'Next line on page three.'],
      },
    ]);
    const first = spanTexts(layerOf(root, 3))[0]!;
    select(first, 0, first, first.length);
    const captured = capture(root)!;
    expect(captured).not.toBeNull();
    expect(selectionSnapshotSchema.safeParse(captured.snapshot).success).toBe(true);
    expect(captured.snapshot).toMatchObject({
      source: 'pdf',
      page: 3,
      kind: 'sentence',
      text: 'The quick brown fox jumps over the lazy dog.',
      contextAfter: 'Next line on page three.',
    });
    expect(captured.snapshot.contextBefore).toBeUndefined();
    expect(JSON.stringify(captured.snapshot)).not.toContain('Elsewhere');
    expect(captured.overLimit).toBe(false);
  });

  it('classifies with the shared classifier: word, phrase, sentence, passage', () => {
    const root = buildViewer([
      {
        number: 1,
        spans: [
          'Clavis',
          'quick brown fox',
          'The quick brown fox jumps over the lazy dog.',
          'One sentence here. And a second sentence follows it.',
        ],
      },
    ]);
    const kinds = spanTexts(layerOf(root, 1)).map((node) => {
      select(node, 0, node, node.length);
      return capture(root)?.snapshot.kind;
    });
    expect(kinds).toEqual(['word', 'phrase', 'sentence', 'passage']);
  });

  it('normalizes whitespace and invisible characters like webpage selections', () => {
    const root = buildViewer([{ number: 1, spans: ['First­ line  ', 'second​   line'] }]);
    const spans = spanTexts(layerOf(root, 1));
    select(spans[0]!, 0, spans[1]!, spans[1]!.length);
    expect(capture(root)?.snapshot.text).toBe('First line second line');
  });

  it('adds no unknown keys (the contract is strict) and no language hint from the reader UI', () => {
    document.documentElement.lang = 'en';
    const root = buildViewer([{ number: 1, spans: ['Hello there world'] }]);
    const node = spanTexts(layerOf(root, 1))[0]!;
    select(node, 6, node, 11);
    const snapshot = capture(root)!.snapshot;
    expect(Object.keys(snapshot).sort()).toEqual(
      ['contextAfter', 'contextBefore', 'kind', 'page', 'selectionId', 'source', 'text'].sort(),
    );
    document.documentElement.removeAttribute('lang');
  });

  it('uses a language set by the PDF inside the viewer', () => {
    const root = buildViewer([{ number: 1, spans: ['Bonjour le monde'] }]);
    layerOf(root, 1).setAttribute('lang', 'fr');
    const node = spanTexts(layerOf(root, 1))[0]!;
    select(node, 0, node, 7);
    expect(capture(root)?.snapshot.languageHint).toBe('fr');
  });

  it('reports the page where a cross-page selection starts and gives it no "after" context', () => {
    const root = buildViewer([
      { number: 7, spans: ['before seven', 'end of page seven'] },
      { number: 8, spans: ['start of page eight', 'only on eight'] },
    ]);
    const seven = spanTexts(layerOf(root, 7));
    const eight = spanTexts(layerOf(root, 8));
    select(seven[1]!, 4, eight[0]!, 8);
    const captured = capture(root)!;
    expect(captured.snapshot.page).toBe(7);
    expect(captured.snapshot.contextAfter).toBeUndefined();
    expect(captured.snapshot.contextBefore).toBe('before seven end');
    expect(JSON.stringify(captured.snapshot)).not.toContain('only on eight');
  });

  it('ignores collapsed selections, nothing selected, and selections outside the viewer', () => {
    const root = buildViewer([{ number: 1, spans: ['abc def'] }]);
    const node = spanTexts(layerOf(root, 1))[0]!;
    select(node, 1, node, 1);
    expect(capture(root)).toBeNull();
    document.getSelection()?.removeAllRanges();
    expect(capture(root)).toBeNull();

    const outside = document.createElement('p');
    outside.textContent = 'toolbar text';
    document.body.append(outside);
    select(outside.firstChild!, 0, outside.firstChild!, 7);
    expect(capture(root)).toBeNull();
    // One end inside, one outside (a drag that ran off the page) is not a PDF selection.
    select(node, 0, outside.firstChild!, 7);
    expect(capture(root)).toBeNull();
  });

  it('ignores a selection in a text layer that belongs to another viewer', () => {
    const mine = buildViewer([{ number: 1, spans: ['mine'] }]);
    const other = buildViewer([{ number: 1, spans: ['other'] }]);
    const node = spanTexts(layerOf(other, 1))[0]!;
    select(node, 0, node, 3);
    expect(capture(mine)).toBeNull();
  });

  it('ignores a selection when focus is in an input (the find box)', () => {
    const root = buildViewer([{ number: 1, spans: ['abc def'] }]);
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const node = spanTexts(layerOf(root, 1))[0]!;
    select(node, 0, node, 3);
    expect(capture(root)).toBeNull();
  });

  it("ignores a selection inside Clavis's own toolbar", () => {
    const root = buildViewer([{ number: 1, spans: ['abc def'] }]);
    const node = spanTexts(layerOf(root, 1))[0]!;
    markOwnUi(root);
    select(node, 0, node, 3);
    expect(capture(root)).toBeNull();
  });

  it('ignores a selection that is not rendered', () => {
    const root = buildViewer([{ number: 1, spans: ['abc def'] }]);
    const node = spanTexts(layerOf(root, 1))[0]!;
    select(node, 0, node, 3);
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      writable: true,
      value: () => [],
    });
    expect(capture(root)).toBeNull();
  });

  it('cuts an over-limit selection, marks it a passage and keeps the full text for "use the first N"', () => {
    const long = 'word '.repeat(LIMITS.maxSelectionChars);
    const root = buildViewer([{ number: 2, spans: [long] }]);
    const node = spanTexts(layerOf(root, 2))[0]!;
    select(node, 0, node, long.length);
    const captured = capture(root)!;
    expect(captured.overLimit).toBe(true);
    expect(captured.snapshot.kind).toBe('passage');
    expect(captured.snapshot.text.length).toBeLessThanOrEqual(LIMITS.maxSelectionChars);
    expect(captured.fullText!.length).toBeGreaterThan(LIMITS.maxSelectionChars);

    // The toolbar's trim action keeps the page and the source.
    const trimmed = trimCaptured(captured);
    expect(trimmed.snapshot).toMatchObject({ source: 'pdf', page: 2 });
    expect(trimmed.snapshot.text.length).toBeLessThanOrEqual(LIMITS.maxSelectionChars);
    expect(trimmed.snapshot.selectionId).not.toBe(captured.snapshot.selectionId);
    expect(selectionSnapshotSchema.safeParse(trimmed.snapshot).success).toBe(true);
  });

  it('bounds the raw string before normalizing a huge selection', () => {
    const chunk = 'lorem  ipsum\n'.repeat(250_000); // ~3.25 MB
    const root = buildViewer([{ number: 5, spans: [chunk, chunk, chunk, chunk] }]);
    const spans = spanTexts(layerOf(root, 5));
    select(spans[0]!, 0, spans[3]!, chunk.length);
    const spy = vi.spyOn(String.prototype, 'replace');
    const captured = capture(root)!;
    const longest = Math.max(...spy.mock.instances.map((s) => String(s).length));
    spy.mockRestore();
    expect(longest).toBeLessThanOrEqual(RAW_SELECTION_CAP);
    expect(RAW_SELECTION_CAP).toBe(LIMITS.maxSelectionChars * 4);
    expect(captured.overLimit).toBe(true);
    expect(captured.snapshot.page).toBe(5);
    expect(captured.snapshot.text.length).toBeLessThanOrEqual(LIMITS.maxSelectionChars);
  });

  it('does not split a surrogate pair when cutting', () => {
    const emoji = '\u{1F600}';
    const long = `${'a'.repeat(LIMITS.maxSelectionChars - 1)}${emoji}${emoji}`;
    const root = buildViewer([{ number: 1, spans: [long] }]);
    const node = spanTexts(layerOf(root, 1))[0]!;
    select(node, 0, node, long.length);
    const text = capture(root)!.snapshot.text;
    const last = text.charCodeAt(text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('keeps the range live so the toolbar can follow scrolling, and hides it when collapsed', () => {
    const root = buildViewer([{ number: 1, spans: ['abc def ghi'] }]);
    root.classList.add('viewer');
    const node = spanTexts(layerOf(root, 1))[0]!;
    select(node, 0, node, 3);
    const captured = capture(root)!;
    expect(captured.getRects()).not.toBeNull();
    captured.range.collapse();
    expect(captured.getRects()).toBeNull();
  });
});

describe('textLayerOf / pageOfLayer', () => {
  it('finds the text layer and page, only inside the given root', () => {
    const a = buildViewer([{ number: 9, spans: ['x'] }]);
    const b = buildViewer([{ number: 1, spans: ['y'] }]);
    const node = spanTexts(layerOf(a, 9))[0]!;
    expect(textLayerOf(node, a)).toBe(layerOf(a, 9));
    expect(textLayerOf(node, b)).toBeNull();
    expect(textLayerOf(document.body, a)).toBeNull();
    expect(pageOfLayer(layerOf(a, 9))).toBe(9);
    expect(pageOfLayer(document.createElement('div'))).toBeNull();
  });
});

describe('viewerRects (toolbar follows the viewer, hides when scrolled out)', () => {
  const rangeWithRects = (boxes: Array<[number, number, number, number]>): Range => {
    const range = document.createRange();
    range.selectNodeContents(document.body);
    const list = boxes.map(([left, top, right, bottom]) => ({
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    }));
    Object.defineProperty(range, 'getClientRects', { value: () => list });
    return range;
  };
  const viewer = (box: [number, number, number, number]): Element => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () =>
      ({
        left: box[0],
        top: box[1],
        right: box[2],
        bottom: box[3],
        width: box[2] - box[0],
        height: box[3] - box[1],
      }) as DOMRect;
    return el;
  };

  it('returns the rects unchanged while the selection is inside the viewer', () => {
    const rects = viewerRects(rangeWithRects([[100, 200, 300, 220]]), viewer([0, 100, 1000, 700]));
    expect(rects?.bounds).toEqual({ left: 100, top: 200, right: 300, bottom: 220 });
  });

  it('is null when the selection is scrolled completely above or below the viewer', () => {
    const above = viewerRects(rangeWithRects([[100, 20, 300, 40]]), viewer([0, 100, 1000, 700]));
    const below = viewerRects(rangeWithRects([[100, 900, 300, 920]]), viewer([0, 100, 1000, 700]));
    expect(above).toBeNull();
    expect(below).toBeNull();
  });

  it('clips a line that is only partly visible', () => {
    const rects = viewerRects(rangeWithRects([[100, 80, 300, 120]]), viewer([0, 100, 1000, 700]));
    expect(rects?.first).toEqual({ left: 100, top: 100, right: 300, bottom: 120 });
  });

  it('anchors to the visible part when the first line is scrolled out but a later one is not', () => {
    const rects = viewerRects(
      rangeWithRects([
        [100, 60, 300, 80],
        [100, 150, 300, 170],
      ]),
      viewer([0, 100, 1000, 700]),
    )!;
    expect(rects.bounds).toEqual({ left: 100, top: 150, right: 300, bottom: 170 });
    expect(rects.first).toEqual({ left: 100, top: 150, right: 300, bottom: 170 });
    expect(rects.last).toEqual({ left: 100, top: 150, right: 300, bottom: 170 });
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../../lib/config/constants';
import { selectionSnapshotSchema } from '../../../lib/contracts';
import {
  RAW_SELECTION_CAP,
  classifyKind,
  readPdfSelection,
  toPdfSelectionSnapshot,
} from '../../../lib/pdf/selection';

/** Minimal DOM shaped like PDF.js output: .page[data-page-number] > .textLayer > span*. */
function buildViewer(pages: Array<{ number: number; spans: string[] }>): HTMLElement {
  const root = document.createElement('div');
  for (const p of pages) {
    const page = document.createElement('div');
    page.className = 'page';
    page.dataset['pageNumber'] = String(p.number);
    const layer = document.createElement('div');
    layer.className = 'textLayer';
    for (const text of p.spans) {
      const span = document.createElement('span');
      span.textContent = text;
      layer.append(span);
      layer.append(document.createElement('br'));
    }
    page.append(layer);
    root.append(page);
  }
  document.body.append(root);
  return root;
}

function select(from: Node, fromOffset: number, to: Node, toOffset: number): Selection {
  const selection = document.getSelection()!;
  selection.setBaseAndExtent(from, fromOffset, to, toOffset);
  return selection;
}

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

describe('readPdfSelection', () => {
  it('returns the exact selected string and the page it starts on', () => {
    const root = buildViewer([
      { number: 3, spans: ['The quick brown fox jumps over the lazy dog.'] },
    ]);
    const text = root.querySelector('span')!.firstChild!;
    const picked = readPdfSelection(select(text, 4, text, 19), root);
    expect(picked).toEqual({ text: 'quick brown fox', page: 3, truncated: false });
  });

  it('normalises whitespace and line breaks inside a multi-line selection', () => {
    const root = buildViewer([{ number: 1, spans: ['First line  ', 'second   line'] }]);
    const spans = root.querySelectorAll('span');
    const picked = readPdfSelection(
      select(spans[0]!.firstChild!, 0, spans[1]!.firstChild!, 13),
      root,
    );
    expect(picked?.text).toBe('First line second line');
  });

  it('reports the page where a cross-page selection starts', () => {
    const root = buildViewer([
      { number: 7, spans: ['end of page seven'] },
      { number: 8, spans: ['start of page eight'] },
    ]);
    const spans = root.querySelectorAll('span');
    const picked = readPdfSelection(
      select(spans[0]!.firstChild!, 4, spans[1]!.firstChild!, 8),
      root,
    );
    expect(picked?.page).toBe(7);
  });

  it('ignores collapsed selections and nothing selected', () => {
    const root = buildViewer([{ number: 1, spans: ['abc'] }]);
    const text = root.querySelector('span')!.firstChild!;
    expect(readPdfSelection(select(text, 1, text, 1), root)).toBeNull();
    expect(readPdfSelection(null, root)).toBeNull();
  });

  it('ignores a selection whose ends are outside the PDF text layers', () => {
    const root = buildViewer([{ number: 1, spans: ['inside the pdf'] }]);
    const outside = document.createElement('p');
    outside.textContent = 'toolbar text';
    document.body.append(outside);
    const inside = root.querySelector('span')!.firstChild!;
    expect(
      readPdfSelection(select(outside.firstChild!, 0, outside.firstChild!, 7), root),
    ).toBeNull();
    // One end inside, one end outside (a drag that ran off the page) is not a PDF selection either.
    expect(readPdfSelection(select(inside, 0, outside.firstChild!, 7), root)).toBeNull();
  });

  it('ignores a selection in a text layer that belongs to another viewer root', () => {
    const mine = buildViewer([{ number: 1, spans: ['mine'] }]);
    const other = buildViewer([{ number: 1, spans: ['other'] }]);
    const text = other.querySelector('span')!.firstChild!;
    expect(readPdfSelection(select(text, 0, text, 3), mine)).toBeNull();
  });

  it('cuts text longer than the selection limit and flags it', () => {
    const long = 'word '.repeat(LIMITS.maxSelectionChars);
    const root = buildViewer([{ number: 2, spans: [long] }]);
    const text = root.querySelector('span')!.firstChild!;
    const picked = readPdfSelection(select(text, 0, text, long.length), root);
    expect(picked?.truncated).toBe(true);
    expect(picked!.text.length).toBeLessThanOrEqual(LIMITS.maxSelectionChars);
    expect(picked!.text.startsWith('word word')).toBe(true);
  });

  it('bounds the raw string before normalising a huge selection', () => {
    // 3 MB of text in 4 spans: normalising everything would be wasted work and memory.
    const chunk = 'lorem  ipsum\n'.repeat(250_000); // ~3.25 MB
    const root = buildViewer([{ number: 5, spans: [chunk, chunk, chunk, chunk] }]);
    const spans = root.querySelectorAll('span');
    const sel = select(spans[0]!.firstChild!, 0, spans[3]!.firstChild!, chunk.length);
    const spy = vi.spyOn(String.prototype, 'replace');
    const picked = readPdfSelection(sel, root)!;
    const longest = Math.max(...spy.mock.instances.map((s) => String(s).length));
    spy.mockRestore();
    expect(longest).toBeLessThanOrEqual(RAW_SELECTION_CAP);
    expect(RAW_SELECTION_CAP).toBe(LIMITS.maxSelectionChars * 4);
    expect(picked.truncated).toBe(true);
    expect(picked.page).toBe(5);
    expect(picked.text.length).toBeLessThanOrEqual(LIMITS.maxSelectionChars);
    expect(picked.text.startsWith('lorem ipsum lorem ipsum')).toBe(true);
  });

  it('does not split a surrogate pair at the raw cap', () => {
    const emoji = '\u{1F600}';
    const text = `${'a'.repeat(RAW_SELECTION_CAP - 1)}${emoji}${emoji}`;
    const root = buildViewer([{ number: 1, spans: [text] }]);
    const node = root.querySelector('span')!.firstChild!;
    const picked = readPdfSelection(select(node, 0, node, text.length), root)!;
    expect(picked.truncated).toBe(true);
    const last = picked.text.charCodeAt(picked.text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it('does not split a surrogate pair when cutting', () => {
    const emoji = '\u{1F600}'; // two UTF-16 code units
    const long = `${'a'.repeat(LIMITS.maxSelectionChars - 1)}${emoji}${emoji}`;
    const root = buildViewer([{ number: 1, spans: [long] }]);
    const text = root.querySelector('span')!.firstChild!;
    const picked = readPdfSelection(select(text, 0, text, long.length), root)!;
    const last = picked.text.charCodeAt(picked.text.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });
});

describe('toPdfSelectionSnapshot', () => {
  it('builds a schema-valid pdf snapshot with the page number', () => {
    const snapshot = toPdfSelectionSnapshot({
      text: 'A full sentence is here.',
      page: 12,
      truncated: false,
    });
    expect(snapshot).not.toBeNull();
    expect(selectionSnapshotSchema.parse(snapshot)).toMatchObject({
      source: 'pdf',
      page: 12,
      kind: 'sentence',
      text: 'A full sentence is here.',
    });
  });

  it('uses the given selection id and rejects an impossible page', () => {
    const id = '3f2b8c1e-5d4a-4c2b-9e1f-0a1b2c3d4e5f';
    expect(toPdfSelectionSnapshot({ text: 'x', page: 1, truncated: false }, id)?.selectionId).toBe(
      id,
    );
    expect(toPdfSelectionSnapshot({ text: 'x', page: 0, truncated: false })).toBeNull();
  });
});

describe('classifyKind', () => {
  it.each([
    ['Clavis', 'word'],
    ['quick brown fox', 'phrase'],
    ['The quick brown fox jumps over the lazy dog.', 'sentence'],
    ['One sentence here. And a second sentence follows it.', 'passage'],
  ] as const)('classifies %j as %s', (text, kind) => {
    expect(classifyKind(text)).toBe(kind);
  });
});

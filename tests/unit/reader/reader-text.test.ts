// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { TextContent } from 'pdfjs-dist/types/src/display/api';
import {
  buildReaderPageText,
  captureReaderTextSelection,
  readerTextRange,
} from '../../../lib/pdf/reader-text';
import { buildViewer, layerOf, select, spanTexts } from '../pdf/support';

const content = (items: unknown[], lang?: string) =>
  ({ items, ...(lang ? { lang } : {}) }) as TextContent;
const item = (str: string, y = 100, hasEOL = false, height = 10) => ({
  str,
  transform: [1, 0, 0, 1, 0, y],
  height,
  hasEOL,
  width: str.length,
  dir: 'ltr',
  fontName: 'f1',
});

describe('buildReaderPageText', () => {
  it('keeps PDF source offsets across whitespace spans and synthetic line breaks', () => {
    const model = buildReaderPageText(
      4,
      content([item('Hello'), item(' ', 100), item('world', 100, true), item('Again', 80)], 'en'),
    );
    expect(model).toEqual({
      page: 4,
      text: 'Hello world\nAgain',
      runs: [
        { index: 0, start: 0, end: 5 },
        { index: 1, start: 5, end: 6 },
        { index: 2, start: 6, end: 11 },
        { index: 3, start: 12, end: 17 },
      ],
      paragraphs: [
        { start: 0, end: 12 },
        { start: 12, end: 17 },
      ],
      lang: 'en',
    });
  });

  it('omits empty text runs and non-text marked content while preserving EOL offsets', () => {
    const marked = { type: 'beginMarkedContent' };
    const model = buildReaderPageText(
      1,
      content([item(''), marked, item('A', 100, true), item('B', 100)]),
    );
    expect(model.text).toBe('A\nB');
    expect(model.runs).toEqual([
      { index: 0, start: 0, end: 1 },
      { index: 1, start: 2, end: 3 },
    ]);
  });
});

describe('readerTextRange and captureReaderTextSelection', () => {
  it('maps source offsets through spans and Find-split text nodes', () => {
    const root = buildViewer([{ number: 1, spans: ['Hello ', 'world'] }]);
    const spans = Array.from(layerOf(root, 1).querySelectorAll('span'));
    spans.forEach((span) => span.setAttribute('dir', 'ltr'));
    spans[0]!.replaceChildren(
      document.createTextNode('Hel'),
      document.createElement('mark'),
      document.createTextNode('lo '),
    );
    const model = buildReaderPageText(1, content([item('Hello '), item('world')]));
    const range = readerTextRange(root, model, 2, 9)!;
    expect(range.toString()).toBe('llo wor');
    expect(readerTextRange(root, model, 4, 4)).toBeNull();
    expect(readerTextRange(root, model, 30, 35)).toBeNull();
  });

  it('captures page-local source offsets for cross-page selections', async () => {
    const root = buildViewer([
      { number: 1, spans: ['first page'] },
      { number: 2, spans: ['second page'] },
    ]);
    const a = spanTexts(layerOf(root, 1))[0]!;
    const b = spanTexts(layerOf(root, 2))[0]!;
    layerOf(root, 1).querySelector('span')!.setAttribute('dir', 'ltr');
    layerOf(root, 2).querySelector('span')!.setAttribute('dir', 'ltr');
    select(a, 6, b, 6);
    const models = new Map([
      [1, buildReaderPageText(1, content([item('first page')]))],
      [2, buildReaderPageText(2, content([item('second page')]))],
    ]);
    await expect(
      captureReaderTextSelection(root, async (page) => models.get(page) ?? null),
    ).resolves.toEqual([
      { page: 1, start: 6, end: 10 },
      { page: 2, start: 0, end: 6 },
    ]);
  });

  it('keeps source offsets aligned when aria-owns removes role from the first text span', async () => {
    const root = buildViewer([
      {
        number: 1,
        spans: ['linked ', 'middle ', 'last'],
        attrs: {
          0: { dir: 'ltr', 'aria-owns': 'annotation-1' },
          1: { dir: 'ltr', role: 'presentation' },
          2: { dir: 'ltr', role: 'presentation' },
        },
      },
    ]);
    const spans = Array.from(layerOf(root, 1).querySelectorAll('span'));
    const model = buildReaderPageText(1, content([item('linked '), item('middle '), item('last')]));
    const last = spanTexts(layerOf(root, 1))[2]!;
    select(last, 0, last, 'last'.length);

    await expect(captureReaderTextSelection(root, async () => model)).resolves.toEqual([
      { page: 1, start: 14, end: 18 },
    ]);
    expect(readerTextRange(root, model, 0, 6)?.toString()).toBe('linked');
    expect(spans[0]?.hasAttribute('role')).toBe(false);
  });

  it('ignores collapsed, outside-viewer, and stale selections', async () => {
    const root = buildViewer([{ number: 1, spans: ['select me'] }]);
    const node = spanTexts(layerOf(root, 1))[0]!;
    select(node, 2, node, 2);
    await expect(captureReaderTextSelection(root, async () => null)).resolves.toEqual([]);
    document.getSelection()?.removeAllRanges();
    const elsewhere = document.createTextNode('outside');
    document.body.append(elsewhere);
    select(elsewhere, 0, elsewhere, 4);
    await expect(captureReaderTextSelection(root, async () => null)).resolves.toEqual([]);
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIMITS } from '../../../lib/config/constants';
import { extractPdfContext, MAX_VISITED_NODES } from '../../../lib/pdf/context';
import { buildViewer, layerOf, mockPdfLayout, select, spanTexts } from './support';

beforeEach(() => mockPdfLayout());
afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

const rangeIn = (from: Text, a: number, to: Text, b: number): Range => {
  const range = document.createRange();
  range.setStart(from, a);
  range.setEnd(to, b);
  return range;
};

describe('extractPdfContext', () => {
  it('takes the text before and after the selection from nearby text items on the same page', () => {
    const root = buildViewer([
      {
        number: 1,
        spans: [
          'The old bank',
          'stood by the river for',
          'almost two hundred years.',
          'It closed.',
        ],
      },
    ]);
    const spans = spanTexts(layerOf(root, 1));
    // Select "river" inside the second item.
    const at = spans[1]!.data.indexOf('river');
    const range = rangeIn(spans[1]!, at, spans[1]!, at + 5);
    expect(extractPdfContext(range, layerOf(root, 1))).toEqual({
      before: 'The old bank stood by the',
      after: 'for almost two hundred years. It closed.',
    });
  });

  it('never reads another page, even when the neighbouring page sits right next to the selection', () => {
    const root = buildViewer([
      { number: 4, spans: ['SECRET-FROM-PAGE-FOUR end of four.'] },
      { number: 5, spans: ['The selected sentence on page five.'] },
      { number: 6, spans: ['SECRET-FROM-PAGE-SIX start of six.'] },
    ]);
    const spans = spanTexts(layerOf(root, 5));
    const range = rangeIn(spans[0]!, 4, spans[0]!, 12);
    const context = extractPdfContext(range, layerOf(root, 5));
    expect(context).toEqual({ before: 'The', after: 'sentence on page five.' });
    expect(JSON.stringify(context)).not.toContain('SECRET');
  });

  it('has no "after" when the selection ends on a later page, and still reads only its start page', () => {
    const root = buildViewer([
      { number: 7, spans: ['Before text on seven.', 'Selection starts here', 'tail of seven.'] },
      { number: 8, spans: ['Opening of eight.', 'More on eight.'] },
    ]);
    const seven = spanTexts(layerOf(root, 7));
    const eight = spanTexts(layerOf(root, 8));
    const range = rangeIn(seven[1]!, 0, eight[0]!, 7);
    const context = extractPdfContext(range, layerOf(root, 7));
    expect(context.before).toBe('Before text on seven.');
    expect(context.after).toBe('');
  });

  it('keeps before + after within the combined ceiling, cutting on word boundaries', () => {
    const paragraph = (tag: string) =>
      Array.from({ length: 400 }, (_, i) => `${tag}${i}`).join(' ');
    const root = buildViewer([
      { number: 1, spans: [paragraph('b'), 'the chosen words', paragraph('a')] },
    ]);
    const spans = spanTexts(layerOf(root, 1));
    const range = rangeIn(spans[1]!, 4, spans[1]!, 10);
    const { before, after } = extractPdfContext(range, layerOf(root, 1));
    expect(before.length + after.length).toBeLessThanOrEqual(LIMITS.maxContextChars);
    expect(before.length).toBeLessThanOrEqual(LIMITS.maxContextChars / 2);
    expect(after.length).toBeLessThanOrEqual(LIMITS.maxContextChars / 2);
    expect(before.length).toBeGreaterThan(400);
    // Whole words only: the first word after the cut is complete, the last word before is complete.
    expect(before.split(' ').every((w) => /^b\d+$/.test(w) || w === 'the')).toBe(true);
    expect(after.split(' ').every((w) => /^a\d+$/.test(w) || w === 'words')).toBe(true);
    expect(before.endsWith('b399 the')).toBe(true);
    expect(after.startsWith('words')).toBe(true);
  });

  it('honours a smaller ceiling', () => {
    const root = buildViewer([{ number: 1, spans: ['aaaa bbbb cccc', 'XX', 'dddd eeee ffff'] }]);
    const spans = spanTexts(layerOf(root, 1));
    const range = rangeIn(spans[1]!, 0, spans[1]!, 2);
    const { before, after } = extractPdfContext(range, layerOf(root, 1), 20);
    expect(before.length + after.length).toBeLessThanOrEqual(20);
  });

  it('skips hidden text items and the end-of-content marker', () => {
    const root = buildViewer([
      {
        number: 1,
        spans: [
          'visible before',
          'ARIA-HIDDEN',
          'DISPLAY-NONE',
          'HIDDEN-ATTR',
          'TARGET',
          'after visible',
        ],
        attrs: {
          1: { 'aria-hidden': 'true' },
          2: { style: 'display: none' },
          3: { hidden: '' },
        },
      },
    ]);
    const spans = spanTexts(layerOf(root, 1));
    const range = rangeIn(spans[4]!, 0, spans[4]!, 6);
    const context = extractPdfContext(range, layerOf(root, 1));
    expect(context).toEqual({ before: 'visible before', after: 'after visible' });
  });

  it('skips text that lies completely outside the page box', () => {
    const root = buildViewer([
      {
        number: 1,
        spans: ['on the page', 'OFF-PAGE-LEFT', 'OFF-PAGE-BELOW', 'TARGET', 'also on the page'],
        attrs: {
          1: { 'data-box': '-900,10,-800,30' },
          2: { 'data-box': '10,2000,100,2020' },
          3: { 'data-box': '50,100,150,120' },
        },
      },
    ]);
    const spans = spanTexts(layerOf(root, 1));
    const range = rangeIn(spans[3]!, 0, spans[3]!, 6);
    const context = extractPdfContext(range, layerOf(root, 1));
    expect(context).toEqual({ before: 'on the page', after: 'also on the page' });
  });

  it('skips items without any box (zero-size text)', () => {
    const root = buildViewer([
      {
        number: 1,
        spans: ['seen', 'ZERO-SIZE', 'TARGET'],
        attrs: { 1: { 'data-box': '0,0,0,0' } },
      },
    ]);
    const spans = spanTexts(layerOf(root, 1));
    const context = extractPdfContext(rangeIn(spans[2]!, 0, spans[2]!, 6), layerOf(root, 1));
    expect(context.before).toBe('seen');
  });

  it('examines at most MAX_VISITED_NODES text items per side', () => {
    const many = Array.from({ length: MAX_VISITED_NODES * 5 }, (_, i) =>
      String.fromCharCode(97 + (i % 26)),
    );
    const spans = [...many, 'TARGET', ...many];
    const root = buildViewer([{ number: 1, spans }]);
    const nodes = spanTexts(layerOf(root, 1));
    const range = rangeIn(nodes[many.length]!, 0, nodes[many.length]!, 6);
    const { before, after } = extractPdfContext(range, layerOf(root, 1));
    // One letter per item, separated by a space: far below the char ceiling, so only the node cap stops it.
    expect(before.split(' ').length).toBeLessThanOrEqual(MAX_VISITED_NODES);
    expect(after.split(' ').length).toBeLessThanOrEqual(MAX_VISITED_NODES);
  });

  it('works when the selection boundaries sit on elements (a drag that ended between items)', () => {
    const root = buildViewer([{ number: 1, spans: ['one', 'two', 'three', 'four'] }]);
    const layer = layerOf(root, 1);
    // Boundaries are child offsets of the text layer: after "one"+br, before "four"+br.
    const range = document.createRange();
    range.setStart(layer, 2); // before <span>two
    range.setEnd(layer, 6); // after <span>three + br
    expect(extractPdfContext(range, layer)).toEqual({ before: 'one', after: 'four' });
  });

  it('returns empty context for a page with only the selection', () => {
    const root = buildViewer([{ number: 1, spans: ['alone'] }]);
    const span = spanTexts(layerOf(root, 1))[0]!;
    expect(extractPdfContext(rangeIn(span, 0, span, 5), layerOf(root, 1))).toEqual({
      before: '',
      after: '',
    });
  });

  it('does not select with the live selection: the range is read, never modified', () => {
    const root = buildViewer([{ number: 1, spans: ['a b c', 'MID', 'd e f'] }]);
    const spans = spanTexts(layerOf(root, 1));
    select(spans[1]!, 0, spans[1]!, 3);
    const range = document.getSelection()!.getRangeAt(0);
    extractPdfContext(range, layerOf(root, 1));
    expect(document.getSelection()!.toString()).toBe('MID');
  });
});

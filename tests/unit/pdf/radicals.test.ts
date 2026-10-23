// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractPdfContext } from '../../../lib/pdf/context';
import { normalizeKangxiRadicals } from '../../../lib/pdf/radicals';
import { capturePdfSelection } from '../../../lib/pdf/selection';
import { buildViewer, layerOf, mockPdfLayout, select, spanTexts } from './support';

describe('normalizeKangxiRadicals', () => {
  it('maps Kangxi radicals to the unified ideographs they stand for', () => {
    // U+2F47 (⽇) -> U+65E5 (日), U+2F69 (⽩) -> U+767D (白)
    expect(normalizeKangxiRadicals('⽩⽇')).toBe('白日');
    expect(normalizeKangxiRadicals('⼀⿕')).toBe('一龠');
  });

  it('leaves everything else exactly as it is (no blanket NFKC)', () => {
    const text = 'ﬁne Ａ１ ² ㍿ 白日 한글 ǆ ⺀ ⿖ ⻿ café';
    expect(normalizeKangxiRadicals(text)).toBe(text);
  });

  it('covers the whole block and nothing outside it', () => {
    for (let code = 0x2f00; code <= 0x2fd5; code++) {
      const out = normalizeKangxiRadicals(String.fromCodePoint(code));
      expect(out, code.toString(16)).not.toBe(String.fromCodePoint(code));
      expect(out.length).toBe(1);
    }
    expect(normalizeKangxiRadicals('⻿⿖')).toBe('⻿⿖');
  });
});

describe('Kangxi radicals in a PDF selection (D5)', () => {
  beforeEach(() => mockPdfLayout());
  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
  });

  it('the snapshot text and its context carry the real ideographs', () => {
    const root = buildViewer([{ number: 1, spans: ['⽇本語', '⽩⽇の空', '⽇曜⽇'] }]);
    const nodes = spanTexts(layerOf(root, 1));
    select(nodes[1]!, 0, nodes[1]!, 2);
    const captured = capturePdfSelection(window, root)!;
    expect(captured.snapshot.text).toBe('白日');
    expect(captured.snapshot.contextBefore).toBe('日本語');
    expect(captured.snapshot.contextAfter).toBe('の空 日曜日');
    expect(JSON.stringify(captured.snapshot)).not.toMatch(/[⼀-⿕]/);
  });

  it('extractPdfContext alone normalizes too', () => {
    const root = buildViewer([{ number: 1, spans: ['⽇', 'X', '⽩'] }]);
    const nodes = spanTexts(layerOf(root, 1));
    const range = document.createRange();
    range.setStart(nodes[1]!, 0);
    range.setEnd(nodes[1]!, 1);
    expect(extractPdfContext(range, layerOf(root, 1))).toEqual({
      before: '日',
      after: '白',
    });
  });
});

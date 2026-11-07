import { describe, expect, it } from 'vitest';
import { narrationParagraph, narrationWord, nextNarrationChunk } from '../../../lib/pdf/narration';
import type { ReaderPageText } from '../../../lib/pdf/reader-text';

const model: ReaderPageText = {
  page: 1,
  text: '  First sentence.\nSecond paragraph has words.',
  runs: [],
  paragraphs: [
    { start: 2, end: 18 },
    { start: 18, end: 45 },
  ],
};

describe('PDF narration source mapping', () => {
  it('keeps each source-aligned speech chunk inside its paragraph', () => {
    expect(nextNarrationChunk(model, 0, model.text.length)).toEqual({
      start: 2,
      end: 17,
      text: 'First sentence.',
    });
    expect(nextNarrationChunk(model, 18, model.text.length)).toEqual({
      start: 18,
      end: 45,
      text: 'Second paragraph has words.',
    });
    expect(nextNarrationChunk(model, 45, 45)).toBeNull();
  });

  it('locates a whole spoken word from a speech character index', () => {
    const chunk = { start: 10, end: 24, text: 'hello, world!' };
    expect(narrationWord(chunk, 7)).toEqual({ start: 17, end: 22 });
    expect(narrationWord(chunk, 7, 2)).toEqual({ start: 17, end: 19 });
    expect(narrationWord(chunk, -1)).toBeNull();
    expect(narrationWord(chunk, 14)).toBeNull();
  });

  it('bounds long chunks at a useful word boundary and avoids splitting surrogate pairs', () => {
    const long: ReaderPageText = {
      page: 1,
      text: `${'word '.repeat(450)}😀end`,
      runs: [],
      paragraphs: [{ start: 0, end: 2253 }],
    };
    const chunk = nextNarrationChunk(long, 0, long.text.length)!;
    expect(chunk.text.length).toBeLessThanOrEqual(2000);
    expect(chunk.text.endsWith(' ')).toBe(false);
    expect(chunk.start + chunk.text.length).toBe(chunk.end);
  });

  it('maps offsets to their containing paragraph only', () => {
    expect(narrationParagraph(model, 5)).toEqual({ start: 2, end: 18 });
    expect(narrationParagraph(model, 20)).toEqual({ start: 18, end: 45 });
    expect(narrationParagraph(model, 45)).toBeNull();
  });
});

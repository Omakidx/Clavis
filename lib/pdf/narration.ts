import { LIMITS } from '../config/constants';
import type { ReaderPageText, ReaderTextSection } from './reader-text';

export interface NarrationChunk extends ReaderTextSection {
  text: string;
}

/** Return a source-aligned chunk; the speech service receives exactly this trimmed text. */
export function nextNarrationChunk(
  model: ReaderPageText,
  from: number,
  until: number,
): NarrationChunk | null {
  const text = model.text;
  let start = Math.max(0, Math.min(from, text.length));
  const limit = Math.max(start, Math.min(until, text.length));
  while (start < limit && /\s/u.test(text[start]!)) start++;
  if (start >= limit) return null;

  const paragraph =
    model.paragraphs.find((part) => part.start <= start && part.end > start) ??
    model.paragraphs.find((part) => part.start > start);
  const sectionEnd = paragraph ? Math.min(limit, paragraph.end) : limit;
  const hardEnd = Math.min(sectionEnd, start + LIMITS.maxSelectionChars);
  let end = hardEnd;
  if (hardEnd < sectionEnd) {
    const slice = text.slice(start, hardEnd);
    // Prefer an actual sentence or paragraph break. Keep enough words in each utterance.
    const sentence = Math.max(
      slice.lastIndexOf('\n'),
      slice.lastIndexOf('. '),
      slice.lastIndexOf('! '),
      slice.lastIndexOf('? '),
    );
    const space = slice.lastIndexOf(' ');
    const split = sentence >= 300 ? sentence + 1 : space >= 300 ? space + 1 : -1;
    if (split > 0) end = start + split;
    // Avoid cutting a UTF-16 surrogate pair at the request ceiling.
    else if (end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1]!)) end--;
  }
  while (end > start && /\s/u.test(text[end - 1]!)) end--;
  return end > start ? { start, end, text: text.slice(start, end) } : null;
}

/** Use a real speech boundary offset to locate the whole visible word. */
export function narrationWord(
  chunk: NarrationChunk,
  charIndex: number,
  length?: number,
): ReaderTextSection | null {
  if (!Number.isInteger(charIndex) || charIndex < 0 || charIndex >= chunk.text.length) return null;
  if (/\s/u.test(chunk.text[charIndex]!)) return null;
  let end = length && length > 0 ? Math.min(charIndex + length, chunk.text.length) : charIndex;
  if (end === charIndex) {
    const rest = chunk.text.slice(charIndex);
    const match = /^[\p{L}\p{N}\p{M}'’_-]+/u.exec(rest);
    end = charIndex + (match?.[0].length ?? 1);
  }
  return { start: chunk.start + charIndex, end: chunk.start + end };
}

export function narrationParagraph(
  model: ReaderPageText,
  offset: number,
): ReaderTextSection | null {
  return model.paragraphs.find((part) => part.start <= offset && part.end > offset) ?? null;
}

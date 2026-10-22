/**
 * Whitespace and invisible-character normalization for selected text.
 *
 * Framework-free and DOM-free so it can be unit tested in Node and bundled into
 * the always-loaded observer (budget: docs/tech-stack.md section 6).
 */

// Soft hyphen, zero-width space and BOM carry no meaning for an explanation.
// Zero-width joiner/non-joiner are KEPT: they change how Persian, Indic scripts
// and emoji sequences are written.
const INVISIBLE = new RegExp('[\u00ad\u200b\ufeff]', 'g');
const WHITESPACE_RUN = /\s+/g;

/** Collapse every whitespace run (including NBSP and newlines) to one space and trim. */
export function normalizeText(raw: string): string {
  return raw.replace(INVISIBLE, '').replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * Truncate to at most `max` UTF-16 code units without splitting a surrogate
 * pair, then re-trim.
 */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  // A high surrogate at the cut would leave half an emoji or CJK extension character.
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

/** A word boundary this close to the limit (as a share of it) is worth shortening the text for. */
const MIN_KEPT_SHARE = 0.8;
/** Text scanned past the limit, so a cluster or word that straddles it is seen whole (and skipped). */
const LOOKAHEAD = 64;

/** Largest segment end in `[floor, max]` of `text` split by `Intl.Segmenter`, or -1. */
function lastBoundary(
  text: string,
  granularity: 'grapheme' | 'word',
  max: number,
  floor: number,
): number {
  let end = -1;
  for (const { index, segment } of new Intl.Segmenter(undefined, { granularity }).segment(
    text.slice(0, max + LOOKAHEAD),
  )) {
    const stop = index + segment.length;
    if (stop > max) break;
    if (stop >= floor) end = stop;
  }
  return end;
}

/**
 * The "Use the first N characters" cut (FR-016 over-limit action). `text` is NORMALIZED (single
 * spaces). Returns at most `max` UTF-16 code units, never an empty string for non-empty input,
 * and never splits a user-perceived character (surrogate pair, skin-tone or flag sequence, base
 * plus combining marks, joined emoji). Preference: a space, else a word boundary (Thai, CJK and
 * other unspaced scripts have none to find by eye, `Intl.Segmenter` does), else the last
 * grapheme boundary, else (one grapheme longer than the limit) a plain code-point-safe cut.
 */
export function trimToWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const floor = max * MIN_KEPT_SHARE;
  // `text[max]` is the first dropped character: a space means the kept part already ends a word.
  const space = text.charAt(max) === ' ' ? max : text.lastIndexOf(' ', max);
  let end = space >= floor ? space : -1;
  if (end === -1 && typeof Intl.Segmenter === 'function') {
    end = lastBoundary(text, 'word', max, floor);
    if (end === -1) end = lastBoundary(text, 'grapheme', max, 1);
  }
  const cut = end > 0 ? text.slice(0, end).trimEnd() : '';
  // Nothing usable (one cluster longer than the limit, or no Segmenter): cut between code points.
  return cut === '' ? truncateText(text, max) : cut;
}

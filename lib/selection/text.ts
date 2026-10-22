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

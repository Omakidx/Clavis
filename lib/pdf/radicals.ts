/**
 * Kangxi Radicals (U+2F00..U+2FD5) look exactly like common CJK ideographs but are different code
 * points. Chrome's PDF printing (Skia) writes them into the ToUnicode map in place of the real
 * characters (U+2F47 instead of U+65E5, 日), so a selection from such a PDF would reach Groq and the
 * voice as look-alike symbols ("Kangxi radical sun"). NFKC maps each of them to the unified
 * ideograph. Only this block is touched: NFKC on whole selections would also rewrite ligatures,
 * full-width forms and superscripts the document really uses.
 *
 * Not handled: CJK Radicals Supplement (U+2E80..U+2EFF). Almost none of it has a compatibility
 * mapping (only U+2E9F and U+2EF3 do), so there is no reliable table to restore them from.
 */
const KANGXI = /[⼀-⿕]/g;

export function normalizeKangxiRadicals(text: string): string {
  return text.replace(KANGXI, (radical) => radical.normalize('NFKC'));
}

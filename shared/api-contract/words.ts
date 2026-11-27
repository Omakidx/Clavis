// Saved-word identity (design §4.5). Used by both sides; the server recomputes the key and
// rejects a mismatch. Imports nothing but the platform's Web Crypto.

/** NFKC, trim, collapse whitespace runs to one space, lowercase. */
export function normalize(text: string): string {
  return text.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
}

/** `hex(SHA-256(UTF-8(normalize(text))))`. */
export async function wordKey(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(normalize(text));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  let hex = '';
  for (const byte of new Uint8Array(digest)) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Namespaced storage keys and the versioned record wrapper (docs/architecture.md §9).
 *
 * Every Clavis record is `{ v, data }` so a later release can migrate it. Key NAMES are
 * constants and never derived from user data or from the key itself.
 */

export const STORAGE_NAMESPACE = 'clavis.' as const;
export const STORAGE_SCHEMA_VERSION = 1 as const;

export const STORAGE_KEYS = {
  /** Page-local color marks, keyed inside the record by a PDF's SHA-256 digest. */
  readerHighlights: 'clavis.reader-highlights',
  /** Preferences (non-secret). `chrome.storage.local`. */
  preferences: 'clavis.preferences',
  /** Onboarding progress (non-secret). `chrome.storage.local`. */
  onboarding: 'clavis.onboarding',
  /** The Groq key (SECRET). In exactly one area: `local` (persistent) or `session`. */
  apiKey: 'clavis.api-key',
  /**
   * Metadata about the key above (no secret): storage choice, last four characters,
   * verification result and the model list. Lives in the SAME area as the key, so a
   * session-only key never leaves even its last four characters in persistent storage,
   * and a browser restart clears the key and its metadata together.
   */
  keyMeta: 'clavis.key-meta',
} as const;

/** The two records that describe the stored key; always read, written and removed together. */
export const KEY_RECORD_KEYS = [STORAGE_KEYS.apiKey, STORAGE_KEYS.keyMeta] as const;

export interface VersionedRecord {
  v: typeof STORAGE_SCHEMA_VERSION;
  data: unknown;
}

export function wrapRecord(data: unknown): VersionedRecord {
  return { v: STORAGE_SCHEMA_VERSION, data };
}

/** The payload of a stored record, or `undefined` if it is missing, malformed or from another version. */
export function unwrapRecord(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const record = raw as { v?: unknown; data?: unknown };
  return record.v === STORAGE_SCHEMA_VERSION ? record.data : undefined;
}

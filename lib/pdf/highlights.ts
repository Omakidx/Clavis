import { createQueue } from '../storage/area';
import { STORAGE_KEYS, unwrapRecord } from '../storage/keys';

export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];
export const MAX_HIGHLIGHTS_PER_DOCUMENT = 200;
export const MAX_HIGHLIGHT_DOCUMENTS = 2000;

export interface ReaderHighlight {
  id: string;
  page: number;
  start: number;
  end: number;
  color: HighlightColor;
  createdAt: number;
}
type Documents = Record<string, ReaderHighlight[]>;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELDS = new Set(['id', 'page', 'start', 'end', 'color', 'createdAt']);
const boundedInteger = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

/** Small strict validator keeps the reader free of a schema-library startup dependency. */
export function parseHighlight(raw: unknown): ReaderHighlight | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const mark = raw as Record<string, unknown>;
  if (Object.keys(mark).length !== FIELDS.size || Object.keys(mark).some((key) => !FIELDS.has(key)))
    return null;
  const { id, page, start, end, color, createdAt } = mark;
  if (
    typeof id !== 'string' ||
    !UUID.test(id) ||
    !boundedInteger(page, 1, 5000) ||
    !boundedInteger(start, 0, 10_000_000) ||
    !boundedInteger(end, 1, 10_000_000) ||
    end <= start ||
    typeof color !== 'string' ||
    !HIGHLIGHT_COLORS.includes(color as HighlightColor) ||
    !boundedInteger(createdAt, 0, Number.MAX_SAFE_INTEGER)
  )
    return null;
  return { id, page, start, end, color: color as HighlightColor, createdAt };
}

export function assertDocumentId(documentId: string): void {
  if (!FINGERPRINT.test(documentId)) throw new Error('invalid-document');
}

/** Validate a bounded record, discard malformed marks, and never retain document text. */
export function parseHighlightDocuments(raw: unknown): Documents {
  const data = unwrapRecord(raw);
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return {};
  const result: Documents = {};
  for (const [id, marks] of Object.entries(data).slice(0, MAX_HIGHLIGHT_DOCUMENTS)) {
    if (!FINGERPRINT.test(id) || !Array.isArray(marks)) continue;
    result[id] = marks.slice(0, MAX_HIGHLIGHTS_PER_DOCUMENT).flatMap((mark: unknown) => {
      const parsed = parseHighlight(mark);
      return parsed ? [parsed] : [];
    });
  }
  return result;
}

/**
 * The reader's view of its marks. The implementation is `createIdbHighlightStore`
 * (lib/data/highlights.ts): marks live in IndexedDB since Clavis Sync (design 7.3).
 */
export interface HighlightStore {
  list(documentId: string): Promise<ReaderHighlight[]>;
  add(documentId: string, marks: ReaderHighlight[]): Promise<ReaderHighlight[]>;
  remove(documentId: string, id: string): Promise<ReaderHighlight[]>;
  clear(documentId: string): Promise<void>;
}

/**
 * Serializes the migration of the legacy `clavis.reader-highlights` record and Clear all data
 * across extension pages (Web Locks; a local queue where they do not exist).
 */
export async function withHighlightStorageLock<T>(task: () => Promise<T>): Promise<T> {
  return typeof navigator !== 'undefined' && navigator.locks
    ? await navigator.locks.request(STORAGE_KEYS.readerHighlights, task)
    : await serial(task);
}

const serial = createQueue();

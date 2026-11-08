import { createQueue, type StorageAreaLike } from '../storage/area';
import { STORAGE_KEYS, unwrapRecord, wrapRecord } from '../storage/keys';

export const HIGHLIGHT_COLORS = ['yellow', 'green', 'blue', 'pink'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];
export const MAX_HIGHLIGHTS_PER_DOCUMENT = 200;
export const MAX_HIGHLIGHT_DOCUMENTS = 30;

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
function parseHighlight(raw: unknown): ReaderHighlight | null {
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

function assertDocumentId(documentId: string): void {
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

export interface HighlightStore {
  list(documentId: string): Promise<ReaderHighlight[]>;
  add(documentId: string, marks: ReaderHighlight[]): Promise<ReaderHighlight[]>;
  remove(documentId: string, id: string): Promise<ReaderHighlight[]>;
  clear(documentId: string): Promise<void>;
}

export async function withHighlightStorageLock<T>(task: () => Promise<T>): Promise<T> {
  return typeof navigator !== 'undefined' && navigator.locks
    ? await navigator.locks.request(STORAGE_KEYS.readerHighlights, task)
    : await serial(task);
}

/**
 * Web Locks serialize mutations across reader tabs on the extension origin. Each mutation reads
 * fresh storage under the lock, so deletion/clear cannot resurrect cached marks. A local queue
 * also supports test environments without Web Locks (real Chrome supports navigator.locks).
 */
export function createHighlightStore(
  area: StorageAreaLike,
  lock: <T>(task: () => Promise<T>) => Promise<T> = withHighlightStorageLock,
): HighlightStore {
  async function read(): Promise<Documents> {
    return parseHighlightDocuments(
      (await area.get(STORAGE_KEYS.readerHighlights))[STORAGE_KEYS.readerHighlights],
    );
  }
  async function update(
    documentId: string,
    change: (marks: ReaderHighlight[]) => ReaderHighlight[],
  ): Promise<ReaderHighlight[]> {
    assertDocumentId(documentId);
    return lock(async () => {
      const documents = await read();
      const marks = change(documents[documentId] ?? []);
      if (marks.length > MAX_HIGHLIGHTS_PER_DOCUMENT) throw new Error('highlight-limit');
      if (marks.length) documents[documentId] = marks;
      else delete documents[documentId];
      if (Object.keys(documents).length > MAX_HIGHLIGHT_DOCUMENTS)
        throw new Error('highlight-limit');
      await area.set({ [STORAGE_KEYS.readerHighlights]: wrapRecord(documents) });
      return marks;
    });
  }
  return {
    async list(documentId) {
      assertDocumentId(documentId);
      return (await read())[documentId] ?? [];
    },
    add: (documentId, marks) =>
      update(documentId, (current) => [
        ...current,
        ...marks.map((mark) => {
          const parsed = parseHighlight(mark);
          if (!parsed) throw new Error('invalid-highlight');
          return parsed;
        }),
      ]),
    remove: (documentId, id) =>
      update(documentId, (current) => current.filter((mark) => mark.id !== id)),
    async clear(documentId) {
      await update(documentId, () => []);
    },
  };
}

const serial = createQueue();

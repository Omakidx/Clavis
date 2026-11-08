import { describe, expect, it } from 'vitest';
import {
  createHighlightStore,
  MAX_HIGHLIGHTS_PER_DOCUMENT,
  parseHighlightDocuments,
  type ReaderHighlight,
} from '../../../lib/pdf/highlights';
import { STORAGE_KEYS, wrapRecord } from '../../../lib/storage/keys';
import { MemoryArea } from '../storage/memory-area';

let idCounter = 1;
const uid = () => `00000000-0000-4000-8000-${String(idCounter++).padStart(12, '0')}`;
const docA = 'a'.repeat(64);
const docB = 'b'.repeat(64);
const mark = (id: string, extra: Record<string, unknown> = {}): ReaderHighlight =>
  ({
    id,
    page: 2,
    start: 3,
    end: 9,
    color: 'yellow',
    createdAt: 100,
    ...extra,
  }) as ReaderHighlight;

describe('highlight persistence', () => {
  it('persists offsets by document fingerprint and reopens without storing selected text', async () => {
    const area = new MemoryArea();
    const first = createHighlightStore(area);
    const expected = [mark(uid())];
    await first.add(docA, expected);
    const reopened = createHighlightStore(area);
    await expect(reopened.list(docA)).resolves.toEqual(expected);
    await expect(reopened.list(docB)).resolves.toEqual([]);
    expect(JSON.stringify(area.data.get(STORAGE_KEYS.readerHighlights))).not.toContain(
      'selected text',
    );
  });

  it('removes and clears marks without resurrecting deleted records', async () => {
    const area = new MemoryArea();
    const store = createHighlightStore(area);
    const [one, two] = [mark(uid()), mark(uid())];
    await store.add(docA, [one, two]);
    await expect(store.remove(docA, one.id)).resolves.toEqual([two]);
    await store.clear(docA);
    await expect(createHighlightStore(area).list(docA)).resolves.toEqual([]);
  });

  it('serializes concurrent updates under the supplied cross-tab lock', async () => {
    const area = new MemoryArea();
    let queue = Promise.resolve();
    const lock = <T>(task: () => Promise<T>) => {
      const run = queue.then(task);
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    };
    const a = createHighlightStore(area, lock);
    const b = createHighlightStore(area, lock);
    const marks = [mark(uid()), mark(uid())];
    await Promise.all([a.add(docA, [marks[0]!]), b.add(docA, [marks[1]!])]);
    expect(await a.list(docA)).toHaveLength(2);
  });

  it('rejects invalid fingerprints, invalid marks, and over-limit additions without writing', async () => {
    const area = new MemoryArea();
    const store = createHighlightStore(area);
    await expect(store.list('not-a-fingerprint')).rejects.toThrow();
    await expect(store.add(docA, [mark(uid(), { end: 3 })])).rejects.toThrow();
    const many = Array.from({ length: MAX_HIGHLIGHTS_PER_DOCUMENT }, () => mark(uid()));
    await store.add(docA, many);
    await expect(store.add(docA, [mark(uid())])).rejects.toThrow('highlight-limit');
    expect(await store.list(docA)).toHaveLength(MAX_HIGHLIGHTS_PER_DOCUMENT);
  });

  it('propagates storage failures and does not cache them as success', async () => {
    const area = new MemoryArea();
    const store = createHighlightStore(area);
    area.failWith = new Error('storage unavailable');
    await expect(store.clear(docA)).rejects.toThrow('storage unavailable');
    expect(area.set).not.toHaveBeenCalled();
  });
});

describe('parseHighlightDocuments', () => {
  it('drops malformed or untrusted entries and ignores unknown schema versions', () => {
    const parsed = parseHighlightDocuments(
      wrapRecord({
        [docA]: [mark(uid()), { ...mark(uid()), text: 'secret' }, { ...mark('bad') }],
        invalid: [mark(uid())],
        [docB]: 'not-an-array',
      }),
    );
    expect(parsed[docA]).toHaveLength(1);
    expect(parsed[docB]).toBeUndefined();
    expect(parseHighlightDocuments({ v: 999, data: { [docA]: [mark(uid())] } })).toEqual({});
  });
});

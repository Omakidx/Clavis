import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  STORE,
  getAll,
  transact,
  type LocalDocument,
  type LocalHighlight,
} from '../../../lib/data/db';
import { createIdbHighlightStore } from '../../../lib/data/highlights';
import { migrateLegacyHighlights } from '../../../lib/data/migrate';
import { STORAGE_KEYS, wrapRecord } from '../../../lib/storage/keys';

const docA = 'a'.repeat(64);
const docB = 'b'.repeat(64);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const mark = (n: number, createdAt = 1_700_000_000_000 + n) => ({
  id: id(n),
  page: 1,
  start: 0,
  end: 5,
  color: 'green',
  createdAt,
});
const legacy = (documents: object) => ({ [STORAGE_KEYS.readerHighlights]: wrapRecord(documents) });
const area = fakeBrowser.storage.local;
const rows = () =>
  transact([STORE.highlights, STORE.documents], 'readonly', async (tx) => ({
    marks: await getAll<LocalHighlight>(tx.objectStore(STORE.highlights)),
    documents: await getAll<LocalDocument>(tx.objectStore(STORE.documents)),
  }));

describe('migrating clavis.reader-highlights', () => {
  it('does nothing when the legacy key is absent', async () => {
    expect(await migrateLegacyHighlights({ signedIn: () => Promise.resolve(false) })).toBe(0);
    expect((await rows()).marks).toEqual([]);
  });

  it('moves marks and their documents into IndexedDB, then removes the key', async () => {
    await area.set(legacy({ [docA]: [mark(1), mark(2)], [docB]: [mark(3)] }));
    expect(await migrateLegacyHighlights({ signedIn: () => Promise.resolve(false) })).toBe(3);
    const { marks, documents } = await rows();
    expect(marks).toHaveLength(3);
    // createdAt becomes the clientModifiedAt; signed out nothing is dirty.
    expect(marks[0]).toMatchObject({
      clientModifiedAt: marks[0]!.createdAt,
      dirty: 0,
      seq: null,
      rev: 1,
      deleted: 0,
    });
    expect(documents.map((d) => d.fingerprint).sort()).toEqual([docA, docB]);
    expect(documents[0]).toMatchObject({ title: null, lastPage: null });
    expect(
      (await area.get(STORAGE_KEYS.readerHighlights))[STORAGE_KEYS.readerHighlights],
    ).toBeUndefined();
    // The reader's store reads them.
    expect(await createIdbHighlightStore().list(docA)).toHaveLength(2);
  });

  it('is idempotent by highlight id: a run after a partial earlier one writes nothing twice', async () => {
    await createIdbHighlightStore({ signedIn: () => Promise.resolve(false) }).add(docA, [
      mark(1) as never,
    ]);
    await area.set(legacy({ [docA]: [mark(1), mark(2)] }));
    expect(await migrateLegacyHighlights({ signedIn: () => Promise.resolve(false) })).toBe(1);
    expect(await migrateLegacyHighlights({ signedIn: () => Promise.resolve(false) })).toBe(0);
    expect((await rows()).marks).toHaveLength(2);
  });

  it('leaves the legacy key in place when the write fails, and succeeds on the next start', async () => {
    await area.set(legacy({ [docA]: [mark(1)] }));
    const original = globalThis.indexedDB;
    // @ts-expect-error simulate IndexedDB being unavailable
    globalThis.indexedDB = undefined;
    await expect(
      migrateLegacyHighlights({ signedIn: () => Promise.resolve(false) }),
    ).rejects.toThrow();
    globalThis.indexedDB = original;
    expect(
      (await area.get(STORAGE_KEYS.readerHighlights))[STORAGE_KEYS.readerHighlights],
    ).toBeDefined();
    expect(await migrateLegacyHighlights({ signedIn: () => Promise.resolve(false) })).toBe(1);
  });

  it('marks records dirty only while signed in, and clamps pre-2020 times the shared schema would refuse', async () => {
    await area.set(legacy({ [docA]: [mark(1, 100)] }));
    await migrateLegacyHighlights({ signedIn: () => Promise.resolve(true) });
    const { marks, documents } = await rows();
    expect(marks[0]).toMatchObject({
      dirty: 1,
      createdAt: 1_577_836_800_000,
      clientModifiedAt: 1_577_836_800_000,
    });
    expect(documents[0]).toMatchObject({ dirty: 1 });
  });

  it('drops malformed legacy marks (the existing parser) instead of failing', async () => {
    await area.set(legacy({ [docA]: [mark(1), { ...mark(2), color: 'red' }, 'junk'] }));
    expect(await migrateLegacyHighlights({ signedIn: () => Promise.resolve(false) })).toBe(1);
  });
});

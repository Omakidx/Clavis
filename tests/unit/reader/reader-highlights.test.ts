import { describe, expect, it } from 'vitest';
import { onDataChanged } from '../../../lib/data/channel';
import { createIdbHighlightStore } from '../../../lib/data/highlights';
import { STORE, transact, getAll, type LocalHighlight } from '../../../lib/data/db';
import { MAX_HIGHLIGHT_DOCUMENTS } from '../../../lib/pdf/highlights';
import {
  MAX_HIGHLIGHTS_PER_DOCUMENT,
  parseHighlightDocuments,
  type ReaderHighlight,
} from '../../../lib/pdf/highlights';
import { wrapRecord } from '../../../lib/storage/keys';

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
const signedOut = { signedIn: () => Promise.resolve(false) };
const signedIn = { signedIn: () => Promise.resolve(true) };

describe('highlight persistence (IndexedDB)', () => {
  it('persists offsets by document fingerprint and reopens without storing selected text', async () => {
    const first = createIdbHighlightStore(signedOut);
    const expected = [mark(uid())];
    await first.add(docA, expected);
    const reopened = createIdbHighlightStore(signedOut);
    await expect(reopened.list(docA)).resolves.toEqual(expected);
    await expect(reopened.list(docB)).resolves.toEqual([]);
    const rows = await transact([STORE.highlights], 'readonly', (tx) =>
      getAll<LocalHighlight>(tx.objectStore(STORE.highlights)),
    );
    expect(JSON.stringify(rows)).not.toContain('selected text');
    // Signed out: no dirty flag, revision 1, fingerprint kept for the byDoc index.
    expect(rows[0]).toMatchObject({ fingerprint: docA, dirty: 0, rev: 1, deleted: 0, seq: null });
  });

  it('creates the document record with the first mark, so the library can list it', async () => {
    await createIdbHighlightStore(signedOut).add(docA, [mark(uid())]);
    const docs = await transact([STORE.documents], 'readonly', (tx) =>
      getAll<{ fingerprint: string; title: string | null }>(tx.objectStore(STORE.documents)),
    );
    expect(docs).toEqual([expect.objectContaining({ fingerprint: docA, title: null })]);
  });

  it('removes and clears marks directly when signed out, and keeps tombstones while signed in', async () => {
    const store = createIdbHighlightStore(signedOut);
    const [one, two] = [mark(uid()), mark(uid())];
    await store.add(docA, [one, two]);
    await expect(store.remove(docA, one.id)).resolves.toEqual([two]);
    await store.clear(docA);
    await expect(createIdbHighlightStore(signedOut).list(docA)).resolves.toEqual([]);
    const gone = await transact([STORE.highlights], 'readonly', (tx) =>
      getAll(tx.objectStore(STORE.highlights)),
    );
    expect(gone).toEqual([]);

    const sync = createIdbHighlightStore(signedIn);
    const three = mark(uid());
    await sync.add(docB, [three]);
    await expect(sync.remove(docB, three.id)).resolves.toEqual([]);
    const tombstones = await transact([STORE.highlights], 'readonly', (tx) =>
      getAll<LocalHighlight>(tx.objectStore(STORE.highlights)),
    );
    expect(tombstones).toEqual([
      expect.objectContaining({ id: three.id, deleted: 1, dirty: 1, rev: 2 }),
    ]);
  });

  it('keeps concurrent additions from two stores (two tabs)', async () => {
    const a = createIdbHighlightStore(signedOut);
    const b = createIdbHighlightStore(signedOut);
    await Promise.all([a.add(docA, [mark(uid())]), b.add(docA, [mark(uid())])]);
    expect(await a.list(docA)).toHaveLength(2);
  });

  it('rejects invalid fingerprints, invalid marks, and over-limit additions without writing', async () => {
    const store = createIdbHighlightStore(signedOut);
    await expect(store.list('not-a-fingerprint')).rejects.toThrow();
    await expect(store.add(docA, [mark(uid(), { end: 3 })])).rejects.toThrow();
    const many = Array.from({ length: MAX_HIGHLIGHTS_PER_DOCUMENT }, () => mark(uid()));
    await store.add(docA, many);
    await expect(store.add(docA, [mark(uid())])).rejects.toThrow('highlight-limit');
    expect(await store.list(docA)).toHaveLength(MAX_HIGHLIGHTS_PER_DOCUMENT);
    // A batch that would pass the limit writes none of it.
    await expect(
      store.add(docB, [mark(uid()), mark(uid(), { end: 2, start: 5 })]),
    ).rejects.toThrow();
    expect(await store.list(docB)).toEqual([]);
  });

  it('limits the documents to 2,000 and refuses the 2,001st without writing', async () => {
    expect(MAX_HIGHLIGHT_DOCUMENTS).toBe(2000);
    await transact([STORE.documents], 'readwrite', (tx) => {
      const documents = tx.objectStore(STORE.documents);
      for (let i = 0; i < MAX_HIGHLIGHT_DOCUMENTS; i++) {
        documents.put({
          fingerprint: i.toString(16).padStart(64, '0'),
          title: null,
          pageCount: null,
          lastPage: null,
          pageOffset: null,
          fileBytes: null,
          storageState: 'none',
          clientModifiedAt: 1,
          seq: null,
          dirty: 0,
          rev: 1,
          deleted: 0,
        });
      }
    });
    const store = createIdbHighlightStore(signedOut);
    await expect(store.add(docA, [mark(uid())])).rejects.toThrow('highlight-limit');
    expect(await store.list(docA)).toEqual([]);
    // A document that already has a record still takes marks.
    const known = (5).toString(16).padStart(64, '0');
    await expect(store.add(known, [mark(uid())])).resolves.toHaveLength(1);
  });

  it('tells other tabs on the clavis-data channel, so they read the marks again', async () => {
    const heard = new Promise<string[]>((resolve) => {
      const stop = onDataChanged(
        (stores) => {
          stop();
          resolve(stores);
        },
        ['highlights'],
      );
    });
    await createIdbHighlightStore(signedOut).add(docA, [mark(uid())]);
    expect(await heard).toContain('highlights');
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

import { describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  appendChatPair,
  listAllChat,
  listChat,
  MAX_MESSAGES_PER_WORD,
} from '../../../lib/data/chat';
import {
  DB_NAME,
  STORE,
  STORE_NAMES,
  closeDb,
  deleteDatabase,
  getAll,
  openDb,
  request,
  transact,
  type LocalWord,
} from '../../../lib/data/db';
import {
  countHighlightsByDocument,
  deleteDocument,
  getDocument,
  listDocuments,
  saveProgress,
} from '../../../lib/data/documents';
import { createIdbHighlightStore } from '../../../lib/data/highlights';
import { isSignedIn } from '../../../lib/data/sync-flag';
import { deleteWord, getWord, listWords, putWord } from '../../../lib/data/words';
import { STORAGE_KEYS } from '../../../lib/storage/keys';
import { clearClavisStorage } from '../../../lib/storage';
import { MemoryArea } from '../storage/memory-area';
import { sampleWord, KEY_A, KEY_B } from './fixtures';

const out = { signedIn: () => Promise.resolve(false) };
const on = { signedIn: () => Promise.resolve(true) };
const FP = 'c'.repeat(64);

describe('the clavis-data schema', () => {
  it('has the five stores with the documented indexes', async () => {
    const db = await openDb();
    expect(db.name).toBe(DB_NAME);
    expect(db.version).toBe(1);
    expect([...db.objectStoreNames].sort()).toEqual([...STORE_NAMES].sort());
    const tx = db.transaction([...STORE_NAMES], 'readonly');
    const indexes = (name: string) => [...tx.objectStore(name).indexNames].sort();
    expect(indexes(STORE.words)).toEqual(['byCreated', 'byDirty']);
    expect(indexes(STORE.chat)).toEqual(['byDirty', 'byWord']);
    expect(indexes(STORE.documents)).toEqual(['byDirty', 'byRecent']);
    expect(indexes(STORE.highlights)).toEqual(['byDirty', 'byDoc']);
    expect(indexes(STORE.fileHandoff)).toEqual([]);
    expect(tx.objectStore(STORE.chat).index('byWord').keyPath).toEqual(['wordKey', 'createdAt']);
    expect(tx.objectStore(STORE.words).keyPath).toBe('wordKey');
    expect(tx.objectStore(STORE.documents).keyPath).toBe('fingerprint');
  });

  it('keeps file hand-offs by fingerprint', async () => {
    await transact([STORE.fileHandoff], 'readwrite', (tx) =>
      request(
        tx.objectStore(STORE.fileHandoff).put({
          fingerprint: FP,
          blob: new Blob(['%PDF-']),
          direction: 'upload',
          createdAt: 5,
        }),
      ),
    );
    const rows = await transact([STORE.fileHandoff], 'readonly', (tx) =>
      getAll<{ fingerprint: string; direction: string }>(tx.objectStore(STORE.fileHandoff)),
    );
    expect(rows).toEqual([expect.objectContaining({ fingerprint: FP, direction: 'upload' })]);
  });

  it('aborts a transaction whose work throws, writing nothing', async () => {
    await expect(
      transact([STORE.words], 'readwrite', async (tx) => {
        await request(tx.objectStore(STORE.words).put({ ...sampleWord(), wordKey: KEY_A }));
        throw new Error('stop');
      }),
    ).rejects.toThrow('stop');
    expect(await listWords()).toEqual([]);
  });
});

describe('saved words', () => {
  it('saves, lists newest first, reads one and replaces (newest wins, first-saved time kept)', async () => {
    await putWord(KEY_A, sampleWord({ text: 'bank', createdAt: 1_700_000_000_000 }), {
      ...out,
      now: () => 1_700_000_000_000,
    });
    await putWord(KEY_B, sampleWord({ text: 'river', createdAt: 1_700_000_100_000 }), {
      ...out,
      now: () => 1_700_000_100_000,
    });
    expect((await listWords()).map((w) => w.text)).toEqual(['river', 'bank']);

    const again = await putWord(
      KEY_A,
      sampleWord({
        text: 'bank',
        createdAt: 1_800_000_000_000,
        meaning: { title: 'bank', summary: 'newer', model: 'm' },
      }),
      { ...out, now: () => 1_800_000_000_000 },
    );
    expect(again).toMatchObject({ createdAt: 1_700_000_000_000, rev: 2, dirty: 0 });
    expect((await getWord(KEY_A))?.meaning.summary).toBe('newer');
    expect(await getWord('f'.repeat(64))).toBeUndefined();
  });

  it('marks records dirty, with a revision, only while signed in', async () => {
    const a = await putWord(KEY_A, sampleWord(), out);
    expect(a).toMatchObject({ dirty: 0, rev: 1, seq: null, deleted: 0 });
    const b = await putWord(KEY_B, sampleWord({ text: 'river' }), on);
    expect(b).toMatchObject({ dirty: 1, rev: 1 });
    const c = await putWord(KEY_B, sampleWord({ text: 'river' }), on);
    expect(c.rev).toBe(2);
    expect(c.clientModifiedAt).toBeGreaterThan(b.clientModifiedAt);
  });

  it('deletes a word and its chat directly when signed out', async () => {
    await putWord(KEY_A, sampleWord(), out);
    await appendChatPair(KEY_A, pair(1), out);
    expect(await deleteWord(KEY_A, out)).toBe(true);
    expect(await deleteWord(KEY_A, out)).toBe(false);
    const rows = await transact([STORE.words, STORE.chat], 'readonly', async (tx) => [
      await getAll(tx.objectStore(STORE.words)),
      await getAll(tx.objectStore(STORE.chat)),
    ]);
    expect(rows).toEqual([[], []]);
  });

  it('leaves a dirty tombstone for the word (and removes its chat) while signed in', async () => {
    await putWord(KEY_A, sampleWord(), on);
    await appendChatPair(KEY_A, pair(1), on);
    await deleteWord(KEY_A, on);
    expect(await getWord(KEY_A)).toBeUndefined();
    expect(await listWords()).toEqual([]);
    const raw = await transact([STORE.words], 'readonly', (tx) =>
      request<LocalWord>(tx.objectStore(STORE.words).get(KEY_A)),
    );
    expect(raw).toMatchObject({ deleted: 1, dirty: 1, rev: 2 });
    expect(await listAllChat()).toEqual([]);
    // Saving it again resurrects it.
    expect(await putWord(KEY_A, sampleWord(), on)).toMatchObject({ deleted: 0, rev: 3 });
  });
});

const pair = (n: number) =>
  [
    {
      id: `00000000-0000-4000-8000-${String(n * 2).padStart(12, '0')}`,
      role: 'user',
      content: `q${n}`,
      createdAt: 1_700_000_000_000 + n * 10,
    },
    {
      id: `00000000-0000-4000-8000-${String(n * 2 + 1).padStart(12, '0')}`,
      role: 'assistant',
      content: `a${n}`,
      model: 'm',
      createdAt: 1_700_000_000_000 + n * 10 + 1,
    },
  ] as const;

describe('chat', () => {
  it('stores a question and its answer together, ordered by time, per word (byWord index)', async () => {
    await putWord(KEY_A, sampleWord(), out);
    await putWord(KEY_B, sampleWord({ text: 'river' }), out);
    await appendChatPair(KEY_A, pair(2), out);
    await appendChatPair(KEY_A, pair(1), out);
    await appendChatPair(KEY_B, pair(3), out);
    expect((await listChat(KEY_A)).map((m) => m.content)).toEqual(['q1', 'a1', 'q2', 'a2']);
    expect((await listChat(KEY_B)).map((m) => m.content)).toEqual(['q3', 'a3']);
    expect(await listAllChat()).toHaveLength(6);
  });

  it('refuses a pair for a missing word and a pair that would pass 200 messages, writing nothing', async () => {
    await expect(appendChatPair(KEY_A, pair(1), out)).rejects.toThrow('word-missing');
    await putWord(KEY_A, sampleWord(), out);
    for (let i = 0; i < MAX_MESSAGES_PER_WORD / 2; i++) await appendChatPair(KEY_A, pair(i), out);
    expect(await listChat(KEY_A)).toHaveLength(MAX_MESSAGES_PER_WORD);
    await expect(appendChatPair(KEY_A, pair(999), out)).rejects.toThrow('chat-limit');
    expect(await listChat(KEY_A)).toHaveLength(MAX_MESSAGES_PER_WORD);
  });
});

describe('documents and reading progress', () => {
  const progress = (lastPage: number, pageOffset = 0) => ({
    title: 'Paper',
    pageCount: 12,
    fileBytes: 2048,
    lastPage,
    pageOffset,
  });

  it('creates the record on first read, updates it, and skips unchanged positions', async () => {
    expect(await saveProgress(FP, progress(1), out)).toBe(true);
    expect(await saveProgress(FP, progress(1, 0.004), out)).toBe(false); // below the epsilon
    expect(await saveProgress(FP, progress(5, 0.5), out)).toBe(true);
    expect(await getDocument(FP)).toMatchObject({
      lastPage: 5,
      pageOffset: 0.5,
      title: 'Paper',
      pageCount: 12,
      rev: 2,
      dirty: 0,
      storageState: 'none',
    });
  });

  it('lists documents by recency (byRecent) and counts highlights per document', async () => {
    const other = 'd'.repeat(64);
    await saveProgress(FP, progress(2), { ...out, now: () => 1_700_000_000_000 });
    await saveProgress(other, progress(3), { ...out, now: () => 1_700_000_500_000 });
    expect((await listDocuments()).map((d) => d.fingerprint)).toEqual([other, FP]);
    await saveProgress(FP, progress(4), { ...out, now: () => 1_700_000_900_000 });
    expect((await listDocuments()).map((d) => d.fingerprint)).toEqual([FP, other]);
    await createIdbHighlightStore(out).add(FP, [
      {
        id: '00000000-0000-4000-8000-000000000001',
        page: 1,
        start: 0,
        end: 4,
        color: 'blue',
        createdAt: 1,
      },
    ]);
    expect(await countHighlightsByDocument()).toEqual(new Map([[FP, 1]]));
  });

  it('deletes a document with its highlights (directly signed out, as tombstones signed in)', async () => {
    const store = createIdbHighlightStore(out);
    await saveProgress(FP, progress(2), out);
    await store.add(FP, [
      {
        id: '00000000-0000-4000-8000-000000000002',
        page: 1,
        start: 0,
        end: 4,
        color: 'pink',
        createdAt: 1,
      },
    ]);
    expect(await deleteDocument(FP, out)).toBe(true);
    expect(await getDocument(FP)).toBeUndefined();
    expect(await store.list(FP)).toEqual([]);
    expect(await deleteDocument(FP, out)).toBe(false);

    await saveProgress(FP, progress(2), on);
    await createIdbHighlightStore(on).add(FP, [
      {
        id: '00000000-0000-4000-8000-000000000003',
        page: 1,
        start: 0,
        end: 4,
        color: 'pink',
        createdAt: 1,
      },
    ]);
    await deleteDocument(FP, on);
    expect(await getDocument(FP)).toBeUndefined();
    const raw = await transact([STORE.documents, STORE.highlights], 'readonly', async (tx) => [
      await getAll<{ deleted: number; dirty: number }>(tx.objectStore(STORE.documents)),
      await getAll<{ deleted: number; dirty: number }>(tx.objectStore(STORE.highlights)),
    ]);
    expect(raw[0]).toEqual([expect.objectContaining({ deleted: 1, dirty: 1 })]);
    expect(raw[1]).toEqual([expect.objectContaining({ deleted: 1, dirty: 1 })]);
  });
});

describe('highlights on a deleted document', () => {
  it('bring the document back (signed in), keeping what it knew', async () => {
    await saveProgress(
      FP,
      { title: 'Paper', pageCount: 12, fileBytes: 1, lastPage: 3, pageOffset: 0 },
      on,
    );
    await deleteDocument(FP, on);
    expect(await getDocument(FP)).toBeUndefined();
    await createIdbHighlightStore(on).add(FP, [
      {
        id: '00000000-0000-4000-8000-000000000009',
        page: 1,
        start: 0,
        end: 2,
        color: 'green',
        createdAt: 5,
      },
    ]);
    expect(await getDocument(FP)).toMatchObject({ title: 'Paper', deleted: 0, dirty: 1, rev: 3 });
  });
});

describe('sync flag', () => {
  it('is signed in only when clavis.sync-state names an account', async () => {
    expect(await isSignedIn()).toBe(false);
    await fakeBrowser.storage.local.set({ [STORAGE_KEYS.syncState]: { cursor: '0' } });
    expect(await isSignedIn()).toBe(false);
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.syncState]: { accountId: 'acc', cursor: '0' },
    });
    expect(await isSignedIn()).toBe(true);
    // The writers read it themselves.
    expect(await putWord(KEY_A, sampleWord())).toMatchObject({ dirty: 1 });
  });
});

describe('Clear all data', () => {
  it('deletes the clavis-data database together with the storage records', async () => {
    await putWord(KEY_A, sampleWord(), out);
    const local = new MemoryArea();
    await local.set({ [STORAGE_KEYS.preferences]: { v: 1 } });
    await clearClavisStorage([local]);
    expect(local.data.size).toBe(0);
    const db = await openDb();
    expect(await getAll(db.transaction(STORE.words).objectStore(STORE.words))).toEqual([]);
    await closeDb();
  });

  it('can delete a database nobody opened, and re-open afterwards', async () => {
    await deleteDatabase();
    await putWord(KEY_A, sampleWord(), out);
    expect(await listWords()).toHaveLength(1);
    await deleteDatabase();
    expect(await listWords()).toEqual([]);
  });
});

describe('clip by code points (L-3)', async () => {
  const { titleFromFileName } = await import('../../../lib/pdf/state');
  it('a 301-emoji file name keeps whole pairs', () => {
    const title = titleFromFileName(`${'😀'.repeat(301)}.pdf`)!;
    expect(title).toBe('😀'.repeat(150));
  });
});

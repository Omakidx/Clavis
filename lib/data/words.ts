import type { WordData } from '../../shared/api-contract/records';
import { notifyDataChanged } from './channel';
import {
  STORE,
  getAll,
  isLive,
  nextSync,
  request,
  tombstoneOf,
  transact,
  type LocalWord,
} from './db';
import { isSignedIn } from './sync-flag';

/** Most saved words one account holds (shared API limit, design 3.2). */
export const MAX_WORDS = 5000;

export interface WriteDeps {
  now?: () => number;
  signedIn?: () => Promise<boolean>;
}

const nowOf = (deps: WriteDeps): number => (deps.now ?? Date.now)();
const signedInOf = (deps: WriteDeps): Promise<boolean> => (deps.signedIn ?? isSignedIn)();

/** One word by its key, or undefined when it was never saved (or was deleted). */
export async function getWord(key: string): Promise<LocalWord | undefined> {
  const record = await transact([STORE.words], 'readonly', (tx) =>
    request<LocalWord | undefined>(tx.objectStore(STORE.words).get(key)),
  );
  return record !== undefined && isLive(record) ? record : undefined;
}

/** Saved words, newest first. */
export async function listWords(): Promise<LocalWord[]> {
  const all = await transact([STORE.words], 'readonly', (tx) =>
    getAll<LocalWord>(tx.objectStore(STORE.words)),
  );
  return all.filter(isLive).sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Save a word, or replace the meaning, context and source of one already saved (newest wins) and
 * keep its first-saved time and its chat (design 4.5). Throws `word-limit` for a 5,001st word.
 */
export async function putWord(
  key: string,
  data: WordData,
  deps: WriteDeps = {},
): Promise<LocalWord> {
  const signedIn = await signedInOf(deps);
  const now = nowOf(deps);
  const saved = await transact([STORE.words], 'readwrite', async (tx) => {
    const words = tx.objectStore(STORE.words);
    const previous = await request<LocalWord | undefined>(words.get(key));
    // Deleted words (tombstones awaiting a push) do not count against the limit.
    if (previous === undefined || !isLive(previous)) {
      const live = (await getAll<LocalWord>(words)).filter(isLive).length;
      if (live >= MAX_WORDS) throw new Error('word-limit');
    }
    const record: LocalWord = {
      ...data,
      createdAt: previous === undefined ? data.createdAt : previous.createdAt,
      wordKey: key,
      ...nextSync(previous, signedIn, now),
    };
    await request(words.put(record));
    return record;
  });
  notifyDataChanged(['words']);
  return saved;
}

/**
 * Delete a word and its chat (the server cascades the same way). Signed out the records are gone
 * at once; signed in the word stays as a tombstone until the push (design 4.7). True if it existed.
 */
export async function deleteWord(key: string, deps: WriteDeps = {}): Promise<boolean> {
  const signedIn = await signedInOf(deps);
  const now = nowOf(deps);
  const existed = await transact([STORE.words, STORE.chat], 'readwrite', async (tx) => {
    const words = tx.objectStore(STORE.words);
    const previous = await request<LocalWord | undefined>(words.get(key));
    if (previous === undefined || !isLive(previous)) return false;
    if (signedIn) await request(words.put(tombstoneOf(previous, now)));
    else await request(words.delete(key));
    const chat = tx.objectStore(STORE.chat);
    // Local messages go either way: the server removes a deleted word's messages itself.
    const ids = await request(
      chat.index('byWord').getAllKeys(IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER])),
    );
    await Promise.all(ids.map((id) => request(chat.delete(id))));
    return true;
  });
  if (existed) notifyDataChanged(['words', 'chat']);
  return existed;
}

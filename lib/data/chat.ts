import { notifyDataChanged } from './channel';
import {
  STORE,
  getAll,
  isLive,
  nextSync,
  request,
  transact,
  type LocalChatMessage,
  type LocalWord,
} from './db';
import { isSignedIn } from './sync-flag';
import type { WriteDeps } from './words';

/** Most messages one word keeps (shared API limit, design 3.2). */
export const MAX_MESSAGES_PER_WORD = 200;

const wordRange = (key: string): IDBKeyRange =>
  IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]);

const byTime = (a: LocalChatMessage, b: LocalChatMessage): number =>
  a.createdAt - b.createdAt || (a.role === b.role ? 0 : a.role === 'user' ? -1 : 1);

/** A word's chat, oldest first. */
export async function listChat(wordKey: string): Promise<LocalChatMessage[]> {
  const all = await transact([STORE.chat], 'readonly', (tx) =>
    getAll<LocalChatMessage>(tx.objectStore(STORE.chat).index('byWord'), wordRange(wordKey)),
  );
  return all.filter(isLive).sort(byTime);
}

/** Every message of every word (the local JSON export). */
export async function listAllChat(): Promise<LocalChatMessage[]> {
  const all = await transact([STORE.chat], 'readonly', (tx) =>
    getAll<LocalChatMessage>(tx.objectStore(STORE.chat)),
  );
  return all.filter(isLive).sort((a, b) => a.createdAt - b.createdAt);
}

export type NewChatMessage = Pick<LocalChatMessage, 'id' | 'role' | 'content' | 'createdAt'> & {
  model?: string;
};

/**
 * Append one question and its answer together, or nothing. Throws `word-missing` if the word is
 * gone (deleted while the answer was on its way) and `chat-limit` if the pair would pass 200.
 */
export async function appendChatPair(
  wordKey: string,
  pair: readonly [NewChatMessage, NewChatMessage],
  deps: WriteDeps = {},
): Promise<void> {
  const signedIn = await (deps.signedIn ?? isSignedIn)();
  const now = (deps.now ?? Date.now)();
  await transact([STORE.words, STORE.chat], 'readwrite', async (tx) => {
    const word = await request<LocalWord | undefined>(tx.objectStore(STORE.words).get(wordKey));
    if (word === undefined || !isLive(word)) throw new Error('word-missing');
    const chat = tx.objectStore(STORE.chat);
    const count = await request(chat.index('byWord').count(wordRange(wordKey)));
    if (count + pair.length > MAX_MESSAGES_PER_WORD) throw new Error('chat-limit');
    for (const message of pair) {
      const record: LocalChatMessage = {
        ...message,
        wordKey,
        ...nextSync(undefined, signedIn, now),
        clientModifiedAt: message.createdAt,
      };
      await request(chat.add(record));
    }
  });
  notifyDataChanged(['chat']);
}

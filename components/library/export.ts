import type { LocalChatMessage, LocalWord } from '../../lib/data/db';

/** The local JSON export of saved words and their chats (docs/clavis-sync-design.md 7.7). */
export interface WordsExport {
  format: 'clavis-saved-words';
  version: 1;
  exportedAt: string;
  words: {
    wordKey: string;
    text: string;
    language?: string;
    meaning: LocalWord['meaning'];
    contextBefore?: string;
    contextAfter?: string;
    source: LocalWord['source'];
    savedAt: string;
    chat: { role: 'user' | 'assistant'; content: string; model?: string; createdAt: string }[];
  }[];
}

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Words with their chats, oldest first, as plain data. Only the user's own content: the sync
 * bookkeeping (revisions, dirty flags) is left out, and no setting or key can be in a record.
 */
export function buildWordsExport(
  words: readonly LocalWord[],
  messages: readonly LocalChatMessage[],
  now: number,
): WordsExport {
  const byWord = new Map<string, LocalChatMessage[]>();
  for (const message of messages) {
    byWord.set(message.wordKey, [...(byWord.get(message.wordKey) ?? []), message]);
  }
  return {
    format: 'clavis-saved-words',
    version: 1,
    exportedAt: iso(now),
    words: [...words]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((word) => ({
        wordKey: word.wordKey,
        text: word.text,
        ...(word.language === undefined ? {} : { language: word.language }),
        meaning: word.meaning,
        ...(word.contextBefore === undefined ? {} : { contextBefore: word.contextBefore }),
        ...(word.contextAfter === undefined ? {} : { contextAfter: word.contextAfter }),
        source: word.source,
        savedAt: iso(word.createdAt),
        chat: (byWord.get(word.wordKey) ?? [])
          .sort((a, b) => a.createdAt - b.createdAt)
          .map((message) => ({
            role: message.role,
            content: message.content,
            ...(message.model === undefined ? {} : { model: message.model }),
            createdAt: iso(message.createdAt),
          })),
      })),
  };
}

/** Hand the export to the user as a file: a Blob and a link with `download`, no extra permission. */
export function downloadJson(data: unknown, fileName: string): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

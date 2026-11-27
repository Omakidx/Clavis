// Row <-> contract mapping shared by push (stale results), pull and the REST views.
import type {
  ChatData,
  DocumentData,
  HighlightData,
  SavedMeaning,
  ServerChange,
  WordData,
  WordSource,
} from '../../../shared/api-contract';
import type { documents, highlights, savedWords, wordChatMessages } from '../db/schema';

export type WordRow = typeof savedWords.$inferSelect;
export type ChatRow = typeof wordChatMessages.$inferSelect;
export type DocumentRow = typeof documents.$inferSelect;
export type HighlightRow = typeof highlights.$inferSelect;

export const wordSource = (r: WordRow): WordSource =>
  r.sourceKind === 'pdf'
    ? { kind: 'pdf', fingerprint: r.pdfFingerprint, title: r.sourceTitle, page: r.pdfPage ?? 1 }
    : { kind: 'webpage', url: r.sourceUrl, title: r.sourceTitle };

export function wordData(r: WordRow): WordData {
  return {
    text: r.text,
    ...(r.language !== null ? { language: r.language } : {}),
    meaning: r.meaning as SavedMeaning,
    ...(r.contextBefore !== null ? { contextBefore: r.contextBefore } : {}),
    ...(r.contextAfter !== null ? { contextAfter: r.contextAfter } : {}),
    source: wordSource(r),
    createdAt: r.createdAt.getTime(),
  };
}

export function chatData(r: ChatRow): ChatData {
  return {
    wordKey: r.wordKey,
    role: r.role as ChatData['role'],
    content: r.content,
    ...(r.model !== null ? { model: r.model } : {}),
    createdAt: r.createdAt.getTime(),
  };
}

export function documentData(r: DocumentRow): DocumentData {
  return {
    title: r.title,
    pageCount: r.pageCount,
    lastPage: r.lastPage,
    pageOffset: r.pageOffset,
    fileBytes: r.fileBytes === null ? null : Number(r.fileBytes),
  };
}

export function highlightData(r: HighlightRow): HighlightData {
  return {
    fingerprint: r.fingerprint,
    page: r.page,
    start: r.startOffset,
    end: r.endOffset,
    color: r.color as HighlightData['color'],
    createdAt: r.createdAt.getTime(),
  };
}

export const wordChange = (r: WordRow): ServerChange => ({
  kind: 'word',
  key: r.wordKey,
  seq: r.seq.toString(),
  deleted: r.deletedAt !== null,
  clientModifiedAt: r.clientModifiedAt.getTime(),
  data: r.deletedAt === null ? wordData(r) : null,
});

export const chatChange = (r: ChatRow): ServerChange => ({
  kind: 'chat',
  id: r.id,
  seq: r.seq.toString(),
  data: chatData(r),
});

export const documentChange = (r: DocumentRow): ServerChange => ({
  kind: 'document',
  key: r.fingerprint,
  seq: r.seq.toString(),
  deleted: r.deletedAt !== null,
  clientModifiedAt: r.clientModifiedAt.getTime(),
  data: r.deletedAt === null ? documentData(r) : null,
  storage: {
    state: r.storageState === 'stored' ? 'stored' : 'none',
    bytes: r.storedBytes === null ? null : Number(r.storedBytes),
  },
});

export const highlightChange = (r: HighlightRow): ServerChange => ({
  kind: 'highlight',
  id: r.id,
  seq: r.seq.toString(),
  deleted: r.deletedAt !== null,
  clientModifiedAt: r.clientModifiedAt.getTime(),
  fingerprint: r.fingerprint,
  data: r.deletedAt === null ? highlightData(r) : null,
});

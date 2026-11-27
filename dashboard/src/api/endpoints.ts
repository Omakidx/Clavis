import {
  AccountResponse,
  DocumentsResponse,
  SessionResponse,
  WordDetailResponse,
  WordsResponse,
} from '@shared/api-contract/endpoints';
import { request } from './client';

/** One typed function per endpoint the dashboard uses (design §5.4). Every response is zod-parsed. */
export const api = {
  session: (signal?: AbortSignal) =>
    request('/v1/session', {
      schema: SessionResponse,
      quiet401: true,
      ...(signal ? { signal } : {}),
    }),
  account: (signal?: AbortSignal) =>
    request('/v1/account', { schema: AccountResponse, ...(signal ? { signal } : {}) }),
  words: (p: { q?: string; cursor?: string; limit: number }, signal?: AbortSignal) =>
    request('/v1/words', {
      schema: WordsResponse,
      query: { q: p.q, cursor: p.cursor, limit: String(p.limit) },
      ...(signal ? { signal } : {}),
    }),
  word: (key: string, signal?: AbortSignal) =>
    request(`/v1/words/${encodeURIComponent(key)}`, {
      schema: WordDetailResponse,
      ...(signal ? { signal } : {}),
    }),
  deleteWord: (key: string) =>
    request(`/v1/words/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  documents: (p: { cursor?: string; limit: number }, signal?: AbortSignal) =>
    request('/v1/documents', {
      schema: DocumentsResponse,
      query: { cursor: p.cursor, limit: String(p.limit) },
      ...(signal ? { signal } : {}),
    }),
  deleteDocument: (fp: string) =>
    request(`/v1/documents/${encodeURIComponent(fp)}`, { method: 'DELETE' }),
  deleteDocumentFile: (fp: string) =>
    request(`/v1/documents/${encodeURIComponent(fp)}/file`, { method: 'DELETE' }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  logoutAll: () => request('/v1/account/logout-all', { method: 'POST' }),
};

export const fileUrl = (fingerprint: string): string =>
  `/v1/documents/${encodeURIComponent(fingerprint)}/file`;

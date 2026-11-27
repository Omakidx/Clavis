import { PushChange, PushRequest } from '../../shared/api-contract/sync';
import type { LocalChatMessage, LocalDocument, LocalHighlight, LocalWord } from '../data/db';

/**
 * Local record -> push change (docs/clavis-sync-design.md 4.7, 5.3, S-09). Every field of the
 * wire shape is copied BY NAME, and the result is validated by the shared strict zod schema, so
 * a local-only field (dirty, rev, seq, deleted, storageState, anything a future record grows) can
 * never reach the server. There is no code path from the Groq key to this module: it reads
 * records of the four synced stores only.
 */

export type SyncKind = 'document' | 'highlight' | 'word' | 'chat';

export type Candidate =
  | { kind: 'word'; key: string; rev: number; record: LocalWord }
  | { kind: 'chat'; key: string; rev: number; record: LocalChatMessage }
  | { kind: 'document'; key: string; rev: number; record: LocalDocument }
  | { kind: 'highlight'; key: string; rev: number; record: LocalHighlight };

/** The change for a candidate, or null if the record does not satisfy the shared schema. */
export function toChange(candidate: Candidate): PushChange | null {
  let raw: unknown;
  switch (candidate.kind) {
    case 'word': {
      const w = candidate.record;
      raw =
        w.deleted === 1
          ? { kind: 'word', op: 'delete', key: w.wordKey, clientModifiedAt: w.clientModifiedAt }
          : {
              kind: 'word',
              op: 'upsert',
              key: w.wordKey,
              clientModifiedAt: w.clientModifiedAt,
              data: {
                text: w.text,
                ...(w.language === undefined ? {} : { language: w.language }),
                meaning: w.meaning,
                ...(w.contextBefore === undefined ? {} : { contextBefore: w.contextBefore }),
                ...(w.contextAfter === undefined ? {} : { contextAfter: w.contextAfter }),
                source: w.source,
                createdAt: w.createdAt,
              },
            };
      break;
    }
    case 'chat': {
      const m = candidate.record;
      if (m.deleted === 1) return null;
      raw = {
        kind: 'chat',
        op: 'insert',
        id: m.id,
        data: {
          wordKey: m.wordKey,
          role: m.role,
          content: m.content,
          ...(m.model === undefined ? {} : { model: m.model }),
          createdAt: m.createdAt,
        },
      };
      break;
    }
    case 'document': {
      const d = candidate.record;
      raw =
        d.deleted === 1
          ? {
              kind: 'document',
              op: 'delete',
              key: d.fingerprint,
              clientModifiedAt: d.clientModifiedAt,
            }
          : {
              kind: 'document',
              op: 'upsert',
              key: d.fingerprint,
              clientModifiedAt: d.clientModifiedAt,
              data: {
                title: d.title,
                pageCount: d.pageCount,
                lastPage: d.lastPage,
                pageOffset: d.pageOffset,
                fileBytes: d.fileBytes,
              },
            };
      break;
    }
    case 'highlight': {
      const h = candidate.record;
      raw =
        h.deleted === 1
          ? {
              kind: 'highlight',
              op: 'delete',
              id: h.id,
              fingerprint: h.fingerprint,
              clientModifiedAt: h.clientModifiedAt,
            }
          : {
              kind: 'highlight',
              op: 'upsert',
              id: h.id,
              clientModifiedAt: h.clientModifiedAt,
              data: {
                fingerprint: h.fingerprint,
                page: h.page,
                start: h.start,
                end: h.end,
                color: h.color,
                createdAt: h.createdAt,
              },
            };
      break;
    }
  }
  const parsed = PushChange.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The request body: validated again as a whole by the shared schema. */
export function toPushRequest(changes: PushChange[]): PushRequest {
  return PushRequest.parse({ changes });
}

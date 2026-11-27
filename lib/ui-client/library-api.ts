import {
  syncKickResultSchema,
  wordChatCancelResultSchema,
  wordChatResultSchema,
} from '../contracts/words';
import { request } from './request';

/** The library page's typed wrappers for WORD_CHAT_SEND and WORD_CHAT_CANCEL (library only). */
export const libraryApi = {
  /** A paid call: never retried automatically (a restart must not cause a second Groq request). */
  chatSend: (input: { requestId: string; wordKey: string; message: string }) =>
    request({ type: 'WORD_CHAT_SEND', ...input }, wordChatResultSchema, {}, { retry: false }),
  chatCancel: (requestId: string) =>
    request({ type: 'WORD_CHAT_CANCEL', requestId }, wordChatCancelResultSchema),
  syncKick: () => request({ type: 'SYNC_KICK' }, syncKickResultSchema),
} as const;

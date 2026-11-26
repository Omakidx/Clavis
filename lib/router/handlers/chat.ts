import { ChatData } from '../../../shared/api-contract/records';
import { GroqError } from '../../ai/errors';
import type { ChatOptions, ChatReply } from '../../ai/groq';
import type { ChatMessage } from '../../ai/prompts';
import { buildWordChatPrompt } from '../../ai/prompts';
import { EXTENSION_PAGES } from '../../config/constants';
import type { MessageReply } from '../../contracts';
import type { WordChatResult } from '../../contracts/words';
import { appendChatPair, listChat, MAX_MESSAGES_PER_WORD } from '../../data/chat';
import { getWord } from '../../data/words';
import { logger } from '../../security/logger';
import { StorageUnavailableError } from '../../storage';
import type { AiGuard } from '../limiter';
import { failure, success } from '../replies';
import { NOT_READY_CODE, evaluateReadiness, type ReadinessDeps } from './ai';
import type { KeyService } from './key';

/**
 * WORD_CHAT_SEND and WORD_CHAT_CANCEL (S-05, docs/clavis-sync-design.md 7.6). Only the library
 * page may send (the route table), with the user's own Groq key and an acknowledged disclosure.
 * The whole chat lives in the background: the key is read here, used for one request and never
 * stored in a message record or sent anywhere but Groq (S-09).
 */

export interface ChatProvider {
  chat(messages: readonly ChatMessage[], options: ChatOptions): Promise<ChatReply>;
}

export interface ChatHandlerDeps extends ReadinessDeps {
  keyService: Pick<KeyService, 'markInvalid'>;
  provider: ChatProvider;
  guard: AiGuard;
  now?: () => number;
  newId?: () => string;
  /** Fixed delimiter suffix, for tests. */
  nonce?: string;
}

/**
 * The limiter key of every library tab: they share one bucket (D-21's 20 per minute) and one
 * request in flight, like the tab-less pages (design 7.4).
 */
export const LIBRARY_LIMITER_KEY = `page:${EXTENSION_PAGES.library}`;

export function createChatHandlers(deps: ChatHandlerDeps) {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? (() => crypto.randomUUID());

  return {
    async send(payload: {
      requestId: string;
      wordKey: string;
      message: string;
    }): Promise<MessageReply<WordChatResult>> {
      const { requestId, wordKey, message } = payload;
      const decision = deps.guard.buckets.take(LIBRARY_LIMITER_KEY);
      if (!decision.ok) {
        return failure('RATE_LIMITED', {
          requestId,
          retryAfterMs: decision.retryAfterMs,
          reason: 'local-limit',
        });
      }
      // Registered before the key is read: a key change that lands meanwhile aborts this request.
      const inFlight = deps.guard.inFlight.begin(LIBRARY_LIMITER_KEY, requestId);
      let apiKey: string | undefined;
      try {
        const readiness = await evaluateReadiness(deps);
        if (inFlight.signal.aborted) return failure('REQUEST_CANCELLED', { requestId });
        if (readiness.state === 'disclosure_required') {
          // The library shows the first-send prompt, calls ACCEPT_DISCLOSURE and sends again.
          return failure('SETUP_REQUIRED', { requestId, reason: 'disclosure' });
        }
        if (readiness.state !== 'ready') {
          return failure(NOT_READY_CODE[readiness.state], { requestId });
        }
        apiKey = readiness.apiKey;

        const word = await getWord(wordKey);
        if (word === undefined) return failure('NOT_FOUND', { requestId });
        const history = await listChat(wordKey);
        // A question and its answer are two messages; the word keeps at most 200.
        if (history.length + 2 > MAX_MESSAGES_PER_WORD) {
          return failure('LIMIT_EXCEEDED', { requestId });
        }
        if (inFlight.signal.aborted) return failure('REQUEST_CANCELLED', { requestId });

        const reply = await deps.provider.chat(
          buildWordChatPrompt({
            word: word.text,
            meaning: word.meaning,
            contextBefore: word.contextBefore,
            contextAfter: word.contextAfter,
            history,
            question: message,
            explanationLanguage: readiness.explanationLanguage,
            readingLevel: readiness.readingLevel,
            ...(deps.nonce === undefined ? {} : { nonce: deps.nonce }),
          }),
          { apiKey, model: readiness.model, signal: inFlight.signal },
        );
        // Cancelled, or the key changed, while the answer was on its way: nothing is written.
        if (inFlight.signal.aborted) return failure('REQUEST_CANCELLED', { requestId });

        const createdAt = now();
        const user = { id: newId(), role: 'user' as const, content: message, createdAt };
        const assistant = {
          id: newId(),
          role: 'assistant' as const,
          content: reply.text,
          model: reply.model,
          createdAt: createdAt + 1,
        };
        // The record schema a push goes through: what is stored can always be synced.
        for (const { id: _id, ...record } of [user, assistant]) {
          if (!ChatData.safeParse({ ...record, wordKey }).success) {
            return failure('INTERNAL_ERROR', { requestId });
          }
        }
        try {
          await appendChatPair(wordKey, [user, assistant], { now });
        } catch (error) {
          if (error instanceof Error && error.message === 'word-missing') {
            return failure('NOT_FOUND', { requestId });
          }
          if (error instanceof Error && error.message === 'chat-limit') {
            return failure('LIMIT_EXCEEDED', { requestId });
          }
          throw error;
        }
        return success(
          {
            userMessageId: user.id,
            assistant: {
              id: assistant.id,
              role: 'assistant',
              content: assistant.content,
              model: reply.model,
              createdAt: assistant.createdAt,
            },
          },
          requestId,
        );
      } catch (error) {
        if (error instanceof StorageUnavailableError) {
          return failure('STORAGE_UNAVAILABLE', { requestId });
        }
        if (!(error instanceof GroqError)) {
          logger.error('word_chat_unexpected_failure', { requestId });
          return failure('INTERNAL_ERROR', { requestId });
        }
        // FR-072: a rejected key flips the status to invalid but keeps every setting.
        if (error.code === 'INVALID_API_KEY' && apiKey !== undefined) {
          await deps.keyService.markInvalid(apiKey);
        }
        return failure(error.code, {
          requestId,
          retryAfterMs: error.retryAfterMs,
          httpStatus: error.status,
          forbiddenReason: error.forbiddenReason,
        });
      } finally {
        inFlight.end();
      }
    },

    cancel(requestId: string): MessageReply<{ cancelled: boolean }> {
      return success(
        { cancelled: deps.guard.inFlight.cancel(LIBRARY_LIMITER_KEY, requestId) },
        requestId,
      );
    },
  };
}

export type ChatHandlers = ReturnType<typeof createChatHandlers>;

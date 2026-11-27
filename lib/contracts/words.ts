import { z } from 'zod';
import { MESSAGE_VERSION } from '../config/constants';
import { Hex64, Text } from '../../shared/api-contract/primitives';
import { SavedMeaning } from '../../shared/api-contract/records';
import { parseMessage, type MessageParseResult } from './messages';
import { idSchema } from './primitives';
import { selectionSnapshotSchema } from './selection';

/**
 * Saved words, per-word chat and the sync nudge (docs/clavis-sync-design.md 7.4). Kept apart from
 * `messages.ts` and not re-exported by `lib/contracts/index.ts`: the record schemas come from
 * shared/api-contract and only the background and the library page need them, so the reader,
 * the side panel and the card (which send these messages by hand) do not carry them.
 *
 * Every schema is strict and carries `v`. Who may send what is the route table's job
 * (lib/router/routes.ts); these only validate shape.
 */

const v = z.literal(MESSAGE_VERSION);

/** A saved entry is a word or a short phrase of at most this many characters (design 7.4). */
export const MAX_SAVED_TEXT_CHARS = 200;

/**
 * Card / practice page / reader / side panel → background: save the selection with its meaning.
 * The source is NOT in this message: a webpage's address and title come from the browser's own
 * sender fields, the PDF part only from the reader, the side panel's from its tab (handler).
 */
export const saveWordMessageSchema = z
  .strictObject({
    v,
    type: z.literal('SAVE_WORD'),
    snapshot: selectionSnapshotSchema,
    meaning: SavedMeaning,
    /** The PDF the reader is showing. Accepted only from the reader, and only with `snapshot.page`. */
    pdf: z.strictObject({ fingerprint: Hex64.nullable(), title: Text(300).nullable() }).optional(),
  })
  .superRefine((message, ctx) => {
    const { kind, text } = message.snapshot;
    if (kind !== 'word' && kind !== 'phrase') {
      ctx.addIssue({
        code: 'custom',
        path: ['snapshot', 'kind'],
        message: 'Only words and phrases',
      });
    }
    if (text.length > MAX_SAVED_TEXT_CHARS) {
      ctx.addIssue({ code: 'custom', path: ['snapshot', 'text'], message: 'Text is too long' });
    }
  });

export const unsaveWordMessageSchema = z.strictObject({
  v,
  type: z.literal('UNSAVE_WORD'),
  wordKey: Hex64,
});

/** The Save button's toggle state. */
export const getWordSavedMessageSchema = z.strictObject({
  v,
  type: z.literal('GET_WORD_SAVED'),
  text: z.string().trim().min(1).max(MAX_SAVED_TEXT_CHARS),
});

/** The routes a card host may call (content scripts, the reader, the practice page, the panel). */
export const wordMessageSchema = z.discriminatedUnion('type', [
  saveWordMessageSchema,
  unsaveWordMessageSchema,
  getWordSavedMessageSchema,
]);
export type WordMessage = z.infer<typeof wordMessageSchema>;

/** A question to the chat is at most this long (shared API limit for user messages). */
export const MAX_CHAT_QUESTION_CHARS = 2000;

/** Library → background: ask a question about a saved word (S-05: only from the extension). */
export const wordChatSendMessageSchema = z.strictObject({
  v,
  type: z.literal('WORD_CHAT_SEND'),
  requestId: idSchema,
  wordKey: Hex64,
  message: z.string().trim().min(1).max(MAX_CHAT_QUESTION_CHARS),
});

export const wordChatCancelMessageSchema = z.strictObject({
  v,
  type: z.literal('WORD_CHAT_CANCEL'),
  requestId: idSchema,
});

/** Reader / library / options → background: local data changed, wake the sync engine (a no-op until sync exists). */
export const syncKickMessageSchema = z.strictObject({
  v,
  type: z.literal('SYNC_KICK'),
  pull: z.literal(true).optional(),
});

/** Extension pages only; never accepted by a public parser. */
export const libraryMessageSchema = z.discriminatedUnion('type', [
  wordChatSendMessageSchema,
  wordChatCancelMessageSchema,
  syncKickMessageSchema,
]);
export type LibraryMessage = z.infer<typeof libraryMessageSchema>;

export function parseWordMessage(input: unknown): MessageParseResult<WordMessage> {
  return parseMessage(wordMessageSchema, input);
}

export function parseLibraryMessage(input: unknown): MessageParseResult<LibraryMessage> {
  return parseMessage(libraryMessageSchema, input);
}

// ---------------------------------------------------------------------------
// Reply data
// ---------------------------------------------------------------------------

export const saveWordResultSchema = z.strictObject({ wordKey: Hex64 });
export const unsaveWordResultSchema = z.strictObject({ removed: z.boolean() });
export const wordSavedResultSchema = z.strictObject({ saved: z.boolean(), wordKey: Hex64 });

/** What the library draws for an assistant answer. */
export const chatViewSchema = z.strictObject({
  id: z.uuid(),
  role: z.literal('assistant'),
  content: z.string().min(1).max(4000),
  model: Text(128),
  createdAt: z.number().int().nonnegative(),
});
export type ChatView = z.infer<typeof chatViewSchema>;

export const wordChatResultSchema = z.strictObject({
  userMessageId: z.uuid(),
  assistant: chatViewSchema,
});
export type WordChatResult = z.infer<typeof wordChatResultSchema>;

export const wordChatCancelResultSchema = z.strictObject({ cancelled: z.boolean() });
export const syncKickResultSchema = z.strictObject({});

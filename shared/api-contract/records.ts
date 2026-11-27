import { z } from 'zod';
import { LIMITS } from './limits';
import { EpochMs, Hex64, Text } from './primitives';

/** Subset of ExplainResult (lib/contracts/explain.ts), core tab. */
export const SavedMeaning = z.strictObject({
  title: Text(120),
  summary: Text(600),
  contextualMeaning: Text(800).optional(),
  definition: Text(600).optional(),
  examples: z
    .array(z.strictObject({ sentence: Text(300), note: Text(200).optional() }))
    .max(2)
    .optional(),
  caveat: Text(400).optional(),
  model: Text(128),
});

export const WordSource = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('webpage'),
    url: Text(2048).nullable(),
    title: Text(300).nullable(),
  }),
  z.strictObject({
    kind: z.literal('pdf'),
    fingerprint: Hex64.nullable(),
    title: Text(300).nullable(),
    page: z.number().int().min(1).max(5000),
  }),
]);

const wordDataShape = {
  text: z.string().trim().min(1).max(200),
  language: Text(35).optional(),
  meaning: SavedMeaning,
  contextBefore: Text(LIMITS.maxContextChars).optional(),
  contextAfter: Text(LIMITS.maxContextChars).optional(),
  source: WordSource,
  createdAt: EpochMs,
};

export const WordData = z
  .strictObject(wordDataShape)
  .refine(
    (w) => (w.contextBefore?.length ?? 0) + (w.contextAfter?.length ?? 0) <= LIMITS.maxContextChars,
    {
      message: 'contextBefore and contextAfter combined exceed 1000 characters',
      path: ['contextAfter'],
    },
  );

export const ChatData = z
  .strictObject({
    wordKey: Hex64,
    role: z.enum(['user', 'assistant']),
    content: z.string().min(1).max(LIMITS.maxChatChars),
    model: Text(128).optional(),
    createdAt: EpochMs,
  })
  .superRefine((m, ctx) => {
    if (m.role === 'user' && m.content.length > LIMITS.maxUserChatChars) {
      ctx.addIssue({
        code: 'custom',
        path: ['content'],
        message: 'user messages are limited to 2000 characters',
      });
    }
    if (m.role === 'assistant' && !m.model) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'model is required for assistant messages',
      });
    }
    if (m.role === 'user' && m.model !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['model'],
        message: 'model is only allowed on assistant messages',
      });
    }
  });

const documentDataShape = {
  title: Text(300).nullable(),
  pageCount: z.number().int().min(1).max(5000).nullable(),
  lastPage: z.number().int().min(1).max(5000).nullable(),
  pageOffset: z.number().min(0).max(1).nullable(),
  fileBytes: z.number().int().positive().max(LIMITS.quotaBytes).nullable(),
};
export const DocumentData = z.strictObject(documentDataShape);

const highlightDataShape = {
  fingerprint: Hex64,
  page: z.number().int().min(1).max(5000),
  start: z.number().int().min(0).max(10_000_000),
  end: z.number().int().min(1).max(10_000_000),
  color: z.enum(['yellow', 'green', 'blue', 'pink']),
  createdAt: EpochMs,
};
export const HighlightData = z
  .strictObject(highlightDataShape)
  .refine((h) => h.end > h.start, { message: 'end must be greater than start', path: ['end'] });

export const DocumentStorage = z.strictObject({
  state: z.enum(['none', 'stored']),
  bytes: z.number().int().nullable(),
});

// Shapes without refinements, for the REST view types below (zod objects with refinements cannot be extended).
export const wordDataBase = z.strictObject(wordDataShape);
export const documentDataBase = z.strictObject(documentDataShape);
export const highlightDataBase = z.strictObject(highlightDataShape);

export type SavedMeaning = z.infer<typeof SavedMeaning>;
export type WordSource = z.infer<typeof WordSource>;
export type WordData = z.infer<typeof WordData>;
export type ChatData = z.infer<typeof ChatData>;
export type DocumentData = z.infer<typeof DocumentData>;
export type HighlightData = z.infer<typeof HighlightData>;

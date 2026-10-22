import { z } from 'zod';
import { LIMITS } from '../config/constants';
import { idSchema, languageTagSchema } from './primitives';

export const selectionSourceSchema = z.enum(['webpage', 'pdf']);
export type SelectionSource = z.infer<typeof selectionSourceSchema>;

export const selectionKindSchema = z.enum(['word', 'phrase', 'sentence', 'passage']);
export type SelectionKind = z.infer<typeof selectionKindSchema>;

/**
 * Selection captured by the (untrusted) content script or reader.
 *
 * Strict: unknown keys are rejected so a key, HTML, cookie or URL field cannot
 * be smuggled through (architecture §4). Lengths are UTF-16 code units, as
 * measured by `String#length`.
 */
export const selectionSnapshotSchema = z
  .strictObject({
    selectionId: idSchema,
    source: selectionSourceSchema,
    kind: selectionKindSchema,
    text: z.string().trim().min(1).max(LIMITS.maxSelectionChars),
    contextBefore: z.string().max(LIMITS.maxContextChars).optional(),
    contextAfter: z.string().max(LIMITS.maxContextChars).optional(),
    languageHint: languageTagSchema.optional(),
    page: z.number().int().positive().optional(),
  })
  .superRefine((snapshot, ctx) => {
    const combined = (snapshot.contextBefore?.length ?? 0) + (snapshot.contextAfter?.length ?? 0);
    if (combined > LIMITS.maxContextChars) {
      ctx.addIssue({
        code: 'custom',
        path: ['contextBefore'],
        message: `Combined context must be at most ${LIMITS.maxContextChars} characters`,
      });
    }
    if (snapshot.page !== undefined && snapshot.source !== 'pdf') {
      ctx.addIssue({
        code: 'custom',
        path: ['page'],
        message: 'page is only allowed when source is "pdf"',
      });
    }
  });
export type SelectionSnapshot = z.infer<typeof selectionSnapshotSchema>;

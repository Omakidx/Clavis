import { z } from 'zod';
import { LIMITS } from '../config/constants';
import { boundedText, idSchema, languageTagSchema, modelIdSchema } from './primitives';
import { selectionSnapshotSchema } from './selection';

/** 'core' = meaning + definition + 2 examples in one request (D-05); others are lazy tabs. */
export const EXPLAIN_MODES = [
  'core',
  'etymology',
  'related_words',
  'simplify',
  'grammar',
  'translate',
] as const;
export const explainModeSchema = z.enum(EXPLAIN_MODES);
export type ExplainMode = z.infer<typeof explainModeSchema>;

export const detailLevelSchema = z.enum(['brief', 'standard', 'deep']);
export type DetailLevel = z.infer<typeof detailLevelSchema>;

export const explainRequestSchema = z
  .strictObject({
    requestId: idSchema,
    snapshot: selectionSnapshotSchema,
    mode: explainModeSchema,
    targetLanguage: languageTagSchema.optional(),
    detailLevel: detailLevelSchema,
  })
  .superRefine((request, ctx) => {
    if (request.mode === 'translate' && request.targetLanguage === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['targetLanguage'],
        message: 'targetLanguage is required when mode is "translate"',
      });
    }
  });
export type ExplainRequest = z.infer<typeof explainRequestSchema>;

// ---------------------------------------------------------------------------
// Plain-text field bounds shared by model output and the unified result.
// ---------------------------------------------------------------------------

const TEXT_LIMITS = {
  title: 120,
  summary: 600,
  contextualMeaning: 800,
  definition: 600,
  exampleSentence: 300,
  exampleNote: 200,
  caveat: 400,
  etymology: 1200,
  relatedWord: 60,
  relatedWords: 12,
  rewritten: 4000,
  grammar: 2000,
  languageName: 64,
} as const;

const exampleSchema = z.object({
  sentence: boundedText(TEXT_LIMITS.exampleSentence),
  note: boundedText(TEXT_LIMITS.exampleNote).optional(),
});
export type ExplainExample = z.infer<typeof exampleSchema>;

const examplesSchema = z.array(exampleSchema).length(2);
const confidenceSchema = z.enum(['known', 'uncertain']);
const relatedWordsListSchema = z
  .array(boundedText(TEXT_LIMITS.relatedWord))
  .max(TEXT_LIMITS.relatedWords);

// ---------------------------------------------------------------------------
// Per-mode MODEL OUTPUT schemas: what Groq must return, before normalization.
// Plain z.object (unknown keys are stripped, not fatal) and no transforms, so
// z.toJSONSchema() can derive `response_format` from them in Phase 5.
// ---------------------------------------------------------------------------

export const coreOutputSchema = z.object({
  title: boundedText(TEXT_LIMITS.title),
  summary: boundedText(TEXT_LIMITS.summary),
  contextualMeaning: boundedText(TEXT_LIMITS.contextualMeaning),
  definition: boundedText(TEXT_LIMITS.definition),
  examples: examplesSchema,
  caveat: boundedText(TEXT_LIMITS.caveat).optional(),
});
export type CoreOutput = z.infer<typeof coreOutputSchema>;

export const etymologyOutputSchema = z.object({
  overview: boundedText(TEXT_LIMITS.etymology),
  confidence: confidenceSchema,
});
export type EtymologyOutput = z.infer<typeof etymologyOutputSchema>;

/** Empty arrays are valid and mean "Not applicable". */
export const relatedWordsOutputSchema = z.object({
  synonyms: relatedWordsListSchema,
  antonyms: relatedWordsListSchema,
});
export type RelatedWordsOutput = z.infer<typeof relatedWordsOutputSchema>;

export const simplifyOutputSchema = z.object({
  simplifiedText: boundedText(TEXT_LIMITS.rewritten),
});
export type SimplifyOutput = z.infer<typeof simplifyOutputSchema>;

export const grammarOutputSchema = z.object({
  grammar: boundedText(TEXT_LIMITS.grammar),
});
export type GrammarOutput = z.infer<typeof grammarOutputSchema>;

export const translateOutputSchema = z.object({
  language: boundedText(TEXT_LIMITS.languageName),
  text: boundedText(TEXT_LIMITS.rewritten),
});
export type TranslateOutput = z.infer<typeof translateOutputSchema>;

/** Output schema per mode, keyed by `ExplainMode`. */
export const modeOutputSchemas = {
  core: coreOutputSchema,
  etymology: etymologyOutputSchema,
  related_words: relatedWordsOutputSchema,
  simplify: simplifyOutputSchema,
  grammar: grammarOutputSchema,
  translate: translateOutputSchema,
} as const satisfies Record<ExplainMode, z.ZodType>;

export type ModeOutputMap = { [M in ExplainMode]: z.infer<(typeof modeOutputSchemas)[M]> };

// ---------------------------------------------------------------------------
// Unified result handed to the UI after normalization (architecture §4).
// All strings are plain text; the UI renders them as text nodes only (D-10).
// ---------------------------------------------------------------------------

export const explainResultSchema = z.strictObject({
  requestId: idSchema,
  selectedText: boundedText(LIMITS.maxSelectionChars),
  mode: explainModeSchema,
  title: boundedText(TEXT_LIMITS.title),
  summary: boundedText(TEXT_LIMITS.summary),
  contextualMeaning: boundedText(TEXT_LIMITS.contextualMeaning).optional(),
  definition: boundedText(TEXT_LIMITS.definition).optional(),
  examples: examplesSchema.optional(),
  etymology: etymologyOutputSchema.optional(),
  synonyms: relatedWordsListSchema.optional(),
  antonyms: relatedWordsListSchema.optional(),
  grammar: boundedText(TEXT_LIMITS.grammar).optional(),
  simplifiedText: boundedText(TEXT_LIMITS.rewritten).optional(),
  translation: translateOutputSchema.optional(),
  caveat: boundedText(TEXT_LIMITS.caveat).optional(),
  provider: z.literal('groq'),
  model: modelIdSchema,
});
export type ExplainResult = z.infer<typeof explainResultSchema>;

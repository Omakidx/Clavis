import type { z } from 'zod';
import {
  coreOutputSchema,
  etymologyModelOutputSchema,
  explainResultSchema,
  grammarOutputSchema,
  modeOutputSchemas,
  relatedWordsOutputSchema,
  simplifyOutputSchema,
  translateOutputSchema,
  type ExplainMode,
  type ExplainRequest,
  type ExplainResult,
} from '../contracts';
import { dropNulls, toStrictJsonSchema } from './schema';

/** Result field limits that the adapter must respect when it derives a field from another. */
const TITLE_MAX = 120;
const SUMMARY_MAX = 600;
const RELATED_WORD_MAX = 60;
const RELATED_WORDS_MAX = 12;

/** `response_format.json_schema.name` for a mode. */
export function schemaNameFor(mode: ExplainMode): string {
  return `clavis_${mode}`;
}

const strictSchemas = new Map<ExplainMode, Record<string, unknown>>();

/** Strict JSON schema for a mode's model output (derived once from the contract; never mutated). */
export function strictSchemaFor(mode: ExplainMode): Record<string, unknown> {
  let schema = strictSchemas.get(mode);
  if (schema === undefined) {
    schema = toStrictJsonSchema(modeOutputSchemas[mode]);
    strictSchemas.set(mode, schema);
  }
  return schema;
}

/** Cut `text` to at most `max` UTF-16 units without splitting a surrogate pair. */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A short label for the selection, used as the result title of the lazy modes. */
function titleFromSelection(request: ExplainRequest): string {
  return clip(oneLine(request.snapshot.text), TITLE_MAX);
}

/** At most `max` characters ending on a sentence boundary when one is reasonably close. */
function leadSentences(text: string, max: number): string {
  const flat = oneLine(text);
  if (flat.length <= max) return flat;
  const head = flat.slice(0, max);
  const boundary = Math.max(
    head.lastIndexOf('. '),
    head.lastIndexOf('! '),
    head.lastIndexOf('? '),
    head.lastIndexOf('。'),
  );
  return boundary >= max * 0.4 ? head.slice(0, boundary + 1) : clip(flat, max);
}

/**
 * Models sometimes return a messy list: padding, repeats, the selection itself, a stray long
 * sentence. These are normalised (not rejected) so one bad item does not discard an otherwise
 * good answer; the contract schema still validates the result.
 */
function tidyWordList(value: unknown, selection: string): unknown {
  if (!Array.isArray(value)) return value;
  const seen = new Set<string>([selection.trim().toLowerCase()]);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const word = oneLine(item);
    const key = word.toLowerCase();
    if (word === '' || word.length > RELATED_WORD_MAX || seen.has(key)) continue;
    seen.add(key);
    out.push(word);
    if (out.length === RELATED_WORDS_MAX) break;
  }
  return out;
}

/** Small, safe tolerances applied before schema validation. */
function normalize(mode: ExplainMode, json: unknown, request: ExplainRequest): unknown {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return json;
  const record = { ...(json as Record<string, unknown>) };
  if (mode === 'etymology' && typeof record['confidence'] === 'string') {
    record['confidence'] = record['confidence'].trim().toLowerCase();
  }
  if (mode === 'related_words') {
    record['synonyms'] = tidyWordList(record['synonyms'], request.snapshot.text);
    record['antonyms'] = tidyWordList(record['antonyms'], request.snapshot.text);
  }
  return record;
}

type ResultFields = Omit<
  ExplainResult,
  'requestId' | 'selectedText' | 'mode' | 'provider' | 'model'
>;

function mapOutput(
  mode: ExplainMode,
  data: unknown,
  request: ExplainRequest,
): ResultFields | undefined {
  const withCaveat = (caveat: string | undefined): { caveat?: string } =>
    caveat === undefined ? {} : { caveat };
  switch (mode) {
    case 'core': {
      const out = data as z.infer<typeof coreOutputSchema>;
      return {
        title: out.title,
        summary: out.summary,
        contextualMeaning: out.contextualMeaning,
        definition: out.definition,
        examples: out.examples,
        ...withCaveat(out.caveat),
      };
    }
    case 'etymology': {
      const out = data as z.infer<typeof etymologyModelOutputSchema>;
      return {
        title: titleFromSelection(request),
        summary: leadSentences(out.overview, SUMMARY_MAX),
        etymology: { overview: out.overview, confidence: out.confidence },
        ...withCaveat(out.caveat),
      };
    }
    case 'related_words': {
      const out = data as z.infer<typeof relatedWordsOutputSchema>;
      const parts = [
        out.synonyms.length > 0 ? `Synonyms: ${out.synonyms.join(', ')}` : '',
        out.antonyms.length > 0 ? `Antonyms: ${out.antonyms.join(', ')}` : '',
      ].filter((part) => part !== '');
      const title = titleFromSelection(request);
      return {
        title,
        // Empty lists are a valid answer ("Not applicable" in the UI); the summary then repeats the title.
        summary: parts.length > 0 ? clip(parts.join('. '), SUMMARY_MAX) : title,
        synonyms: out.synonyms,
        antonyms: out.antonyms,
      };
    }
    case 'simplify': {
      const out = data as z.infer<typeof simplifyOutputSchema>;
      return {
        title: titleFromSelection(request),
        summary: leadSentences(out.simplifiedText, SUMMARY_MAX),
        simplifiedText: out.simplifiedText,
        ...withCaveat(out.caveat),
      };
    }
    case 'grammar': {
      const out = data as z.infer<typeof grammarOutputSchema>;
      return {
        title: titleFromSelection(request),
        summary: leadSentences(out.grammar, SUMMARY_MAX),
        grammar: out.grammar,
        ...withCaveat(out.caveat),
      };
    }
    case 'translate': {
      const out = data as z.infer<typeof translateOutputSchema>;
      return {
        title: titleFromSelection(request),
        summary: leadSentences(out.text, SUMMARY_MAX),
        translation: {
          language: out.language,
          text: out.text,
          ...(out.literal === undefined ? {} : { literal: out.literal }),
        },
        ...withCaveat(out.caveat),
      };
    }
  }
}

/**
 * Validate a model's JSON against its mode schema and map it into the unified `ExplainResult`.
 * Returns `undefined` on any mismatch (the caller reports INVALID_RESPONSE without the content).
 * `null` members (strict-mode "absent") are dropped first.
 */
export function buildResult(
  request: ExplainRequest,
  model: string,
  json: unknown,
): ExplainResult | undefined {
  const { mode } = request;
  const output = modeOutputSchemas[mode].safeParse(normalize(mode, dropNulls(json), request));
  if (!output.success) return undefined;
  const fields = mapOutput(mode, output.data, request);
  if (fields === undefined) return undefined;
  const result = explainResultSchema.safeParse({
    requestId: request.requestId,
    selectedText: request.snapshot.text,
    mode,
    ...fields,
    provider: 'groq',
    model,
  });
  return result.success ? result.data : undefined;
}

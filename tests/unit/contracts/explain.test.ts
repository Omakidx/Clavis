import { z } from 'zod';
import {
  EXPLAIN_MODES,
  explainRequestSchema,
  explainResultSchema,
  modeOutputSchemas,
  type ExplainMode,
} from '../../../lib/contracts';
import { UUID_B, explainRequest, snapshot } from './fixtures';

const core = {
  title: 'bank',
  summary: 'A financial institution.',
  contextualMeaning: 'Here it means the institution, not a river edge.',
  definition: 'An organization that holds money.',
  examples: [{ sentence: 'I went to the bank.' }, { sentence: 'The bank closed.', note: 'past' }],
};

describe('explainRequestSchema', () => {
  it('accepts a core request', () => {
    expect(explainRequestSchema.safeParse(explainRequest()).success).toBe(true);
  });

  it.each(EXPLAIN_MODES.filter((m) => m !== 'translate'))(
    'accepts mode %s without a target language',
    (mode) => {
      expect(explainRequestSchema.safeParse(explainRequest({ mode })).success).toBe(true);
    },
  );

  it('rejects translate without targetLanguage and accepts it with one', () => {
    expect(explainRequestSchema.safeParse(explainRequest({ mode: 'translate' })).success).toBe(
      false,
    );
    expect(
      explainRequestSchema.safeParse(explainRequest({ mode: 'translate', targetLanguage: 'es' }))
        .success,
    ).toBe(true);
  });

  it('rejects unknown mode, detail level, bad requestId and unknown keys', () => {
    expect(explainRequestSchema.safeParse(explainRequest({ mode: 'define' })).success).toBe(false);
    expect(explainRequestSchema.safeParse(explainRequest({ detailLevel: 'max' })).success).toBe(
      false,
    );
    expect(explainRequestSchema.safeParse(explainRequest({ requestId: 'nope' })).success).toBe(
      false,
    );
    expect(explainRequestSchema.safeParse(explainRequest({ apiKey: 'gsk_x' })).success).toBe(false);
  });

  it('validates the nested snapshot (over-limit text is rejected)', () => {
    const request = explainRequest({ snapshot: snapshot({ text: 'a'.repeat(2001) }) });
    expect(explainRequestSchema.safeParse(request).success).toBe(false);
  });
});

describe('modeOutputSchemas', () => {
  it('has a schema for every mode', () => {
    expect(Object.keys(modeOutputSchemas).sort()).toEqual([...EXPLAIN_MODES].sort());
  });

  it('accepts a valid core output, with and without optional fields', () => {
    expect(modeOutputSchemas.core.safeParse(core).success).toBe(true);
    expect(modeOutputSchemas.core.safeParse({ ...core, caveat: 'Ambiguous.' }).success).toBe(true);
  });

  it.each([0, 1, 3])('rejects core output with %s examples', (count) => {
    const examples = Array.from({ length: count }, () => ({ sentence: 'x' }));
    expect(modeOutputSchemas.core.safeParse({ ...core, examples }).success).toBe(false);
  });

  it('rejects core output with missing or over-long fields', () => {
    const { definition: _definition, ...missing } = core;
    expect(modeOutputSchemas.core.safeParse(missing).success).toBe(false);
    expect(modeOutputSchemas.core.safeParse({ ...core, title: 'a'.repeat(500) }).success).toBe(
      false,
    );
    expect(modeOutputSchemas.core.safeParse({ ...core, summary: '' }).success).toBe(false);
  });

  it('accepts HTML and Markdown in model output as literal plain text', () => {
    const evil = '<script>alert(1)</script> **x** `y`';
    const parsed = modeOutputSchemas.core.safeParse({ ...core, summary: evil });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.summary).toBe(evil);
  });

  it('validates etymology confidence', () => {
    expect(
      modeOutputSchemas.etymology.safeParse({ overview: 'From Old Norse.', confidence: 'known' })
        .success,
    ).toBe(true);
    expect(
      modeOutputSchemas.etymology.safeParse({ overview: 'x', confidence: 'maybe' }).success,
    ).toBe(false);
  });

  it('allows empty related-word arrays ("Not applicable") and bounds their size', () => {
    expect(modeOutputSchemas.related_words.safeParse({ synonyms: [], antonyms: [] }).success).toBe(
      true,
    );
    const tooMany = Array.from({ length: 13 }, (_, i) => `w${i}`);
    expect(
      modeOutputSchemas.related_words.safeParse({ synonyms: tooMany, antonyms: [] }).success,
    ).toBe(false);
  });

  it('validates the single-field lazy modes', () => {
    expect(modeOutputSchemas.simplify.safeParse({ simplifiedText: 'Easy.' }).success).toBe(true);
    expect(modeOutputSchemas.simplify.safeParse({}).success).toBe(false);
    expect(modeOutputSchemas.grammar.safeParse({ grammar: 'Noun.' }).success).toBe(true);
    expect(
      modeOutputSchemas.translate.safeParse({ language: 'Spanish', text: 'banco' }).success,
    ).toBe(true);
    expect(modeOutputSchemas.translate.safeParse({ text: 'banco' }).success).toBe(false);
  });

  it('strips unknown keys from model output instead of failing', () => {
    const parsed = modeOutputSchemas.grammar.safeParse({ grammar: 'Noun.', reasoning: 'secret' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual({ grammar: 'Noun.' });
  });

  it.each(EXPLAIN_MODES)('converts the %s schema to JSON Schema', (mode: ExplainMode) => {
    const json = z.toJSONSchema(modeOutputSchemas[mode]);
    expect(json.type).toBe('object');
    expect(json.properties).toBeDefined();
    expect(Array.isArray(json.required)).toBe(true);
  });

  it('derives a core JSON Schema with exactly-two examples and closed objects', () => {
    const json = z.toJSONSchema(modeOutputSchemas.core);
    const props = json.properties as Record<string, Record<string, unknown>>;
    expect(props.examples).toMatchObject({ type: 'array', minItems: 2, maxItems: 2 });
    expect(json.required).toEqual(
      expect.arrayContaining(['title', 'summary', 'contextualMeaning', 'definition', 'examples']),
    );
    expect(json.required).not.toContain('caveat');
    expect(json.additionalProperties).toBe(false);
  });
});

describe('explainResultSchema', () => {
  const result = {
    requestId: UUID_B,
    selectedText: 'bank',
    mode: 'core',
    title: 'bank',
    summary: 'A financial institution.',
    contextualMeaning: 'x',
    definition: 'y',
    examples: core.examples,
    provider: 'groq',
    model: 'openai/gpt-oss-20b',
  };

  it('accepts a normalized core result and a lazy-mode result', () => {
    expect(explainResultSchema.safeParse(result).success).toBe(true);
    expect(
      explainResultSchema.safeParse({
        requestId: UUID_B,
        selectedText: 'bank',
        mode: 'translate',
        title: 'bank',
        summary: 'Translation',
        translation: { language: 'Spanish', text: 'banco' },
        provider: 'groq',
        model: 'm',
      }).success,
    ).toBe(true);
  });

  it('rejects other providers, unknown keys and a missing model', () => {
    expect(explainResultSchema.safeParse({ ...result, provider: 'openai' }).success).toBe(false);
    expect(explainResultSchema.safeParse({ ...result, apiKey: 'x' }).success).toBe(false);
    const { model: _model, ...noModel } = result;
    expect(explainResultSchema.safeParse(noModel).success).toBe(false);
  });
});

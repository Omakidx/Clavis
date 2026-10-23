import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXPLAIN_MODES,
  explainRequestSchema,
  type ExplainMode,
  type ExplainRequest,
} from '../../../lib/contracts';
import {
  GroqError,
  GroqProvider,
  MODE_TOKEN_BUDGETS,
  createCapabilityCache,
} from '../../../lib/ai';
import { explainRequest, snapshot } from '../contracts/fixtures';
import { nonceOf } from './prompt-helpers';

const FAKE_KEY = 'gsk_TEST_unit_key_that_must_never_leak_0123456789';
const SELECTED = 'SECRETSELECTION';
const GPT = 'openai/gpt-oss-20b';
const LLAMA = 'llama-3.1-8b-instant';

const OUTPUTS: Record<ExplainMode, unknown> = {
  core: {
    title: 'bank',
    summary: 'The land beside a river.',
    contextualMeaning: 'Here it is the riverside.',
    definition: 'The raised ground along a river.',
    examples: [{ sentence: 'We sat on the bank.' }, { sentence: 'The bank flooded.' }],
  },
  etymology: { overview: 'From Old Norse banki.', confidence: 'known' },
  related_words: { synonyms: ['shore'], antonyms: [] },
  simplify: { simplifiedText: 'Plain words.' },
  grammar: { grammar: 'Noun.' },
  translate: { language: 'French', text: 'la rive' },
};

function req(mode: ExplainMode, overrides: Record<string, unknown> = {}): ExplainRequest {
  return explainRequestSchema.parse(
    explainRequest({
      mode,
      snapshot: snapshot({ text: SELECTED, contextBefore: 'CONTEXTMARK ' }),
      ...(mode === 'translate' ? { targetLanguage: 'fr' } : {}),
      ...overrides,
    }),
  );
}

const completion = (content: unknown) => ({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
});
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
/** A fetch implementation answering each request with the valid output of the mode it asks for. */
const answerByMode = async (_url: string, init: RequestInit) => {
  const body = JSON.parse(init.body as string) as { messages: { content: string }[] };
  const mode = /\(mode: (\w+)\)/.exec(body.messages[1]?.content ?? '')?.[1] as ExplainMode;
  return json(completion(JSON.stringify(OUTPUTS[mode])));
};
const reject400 = (message: string) =>
  json({ error: { message, type: 'invalid_request_error' } }, 400);
const FORMAT_REJECTED = () =>
  reject400('`response_format` of type `json_schema` is not supported with this model');
const EFFORT_REJECTED = () => reject400('`reasoning_effort` is not supported with this model');

describe('GroqProvider across modes', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let consoleOutput: unknown[][];

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    consoleOutput = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        consoleOutput.push(args);
      });
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const opts = (extra: Record<string, unknown> = {}) => ({
    apiKey: FAKE_KEY,
    model: GPT,
    ...extra,
  });
  const bodyOf = (index: number) =>
    JSON.parse((fetchMock.mock.calls[index] as [string, RequestInit])[1].body as string);

  it.each(EXPLAIN_MODES)(
    '%s: sends its own schema and budget, and maps the answer',
    async (mode) => {
      fetchMock.mockResolvedValue(json(completion(JSON.stringify(OUTPUTS[mode]))));
      const result = await new GroqProvider().explain(req(mode), opts());
      expect(result).toMatchObject({ mode, provider: 'groq', model: GPT, selectedText: SELECTED });

      const body = bodyOf(0);
      expect(body.response_format.type).toBe('json_schema');
      expect(body.response_format.json_schema.name).toBe(`clavis_${mode}`);
      expect(body.response_format.json_schema.strict).toBe(true);
      expect(body.response_format.json_schema.schema.additionalProperties).toBe(false);
      expect(body.reasoning_effort).toBe('low');
      expect(body.max_completion_tokens).toBe(MODE_TOKEN_BUDGETS[mode].reasoning);
      expect(body.messages[1].content).toContain(`(mode: ${mode})`);
      expect(body.messages[1].content).toMatch(
        new RegExp(`<selected_text_[0-9a-f]{16}>${SELECTED}</selected_text_[0-9a-f]{16}>`),
      );
    },
  );

  it('uses the standard budget for a non-reasoning model and honours an explicit override', async () => {
    fetchMock.mockImplementation(answerByMode);
    const provider = new GroqProvider();
    await provider.explain(req('simplify'), opts({ model: LLAMA }));
    expect(bodyOf(0).max_completion_tokens).toBe(MODE_TOKEN_BUDGETS.simplify.standard);
    await provider.explain(req('simplify'), opts({ model: LLAMA, maxCompletionTokens: 321 }));
    expect(bodyOf(1).max_completion_tokens).toBe(321);
  });

  it('uses a fresh delimiter nonce for every request', async () => {
    fetchMock.mockImplementation(answerByMode);
    const provider = new GroqProvider();
    await provider.explain(req('core'), opts());
    await provider.explain(req('core'), opts());
    const nonces = [0, 1].map((i) => nonceOf(bodyOf(i).messages[1].content));
    expect(nonces[0]).not.toBe(nonces[1]);
    // The system prompt names the same tags as the user message.
    expect(bodyOf(0).messages[0].content).toContain(`<selected_text_${nonces[0]}>`);
  });

  it('passes the reading level into the prompt', async () => {
    fetchMock.mockResolvedValue(json(completion(JSON.stringify(OUTPUTS['simplify']))));
    await new GroqProvider().explain(req('simplify'), opts({ readingLevel: 'simple' }));
    expect(bodyOf(0).messages[0].content).toContain('Reading level: simple');
  });

  it('strips a leading <think> block some models put in content', async () => {
    fetchMock.mockResolvedValue(
      json(
        completion(
          `<think>hmm {"overview":"WRONG"}</think>\n${JSON.stringify(OUTPUTS['etymology'])}`,
        ),
      ),
    );
    const result = await new GroqProvider().explain(req('etymology'), opts());
    expect(result.etymology?.overview).toBe('From Old Norse banki.');
  });

  it('reports a truncated reasoning answer as INVALID_RESPONSE with the token usage', async () => {
    const truncated = completion('{"overview":"Fr');
    truncated.choices[0]!.finish_reason = 'length';
    fetchMock.mockResolvedValue(json(truncated));
    await expect(new GroqProvider().explain(req('etymology'), opts())).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      stage: 'truncated',
      usage: { completionTokens: 20 },
    });
  });

  it('does not call Groq when the caller is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      new GroqProvider().explain(req('core'), opts({ signal: controller.signal })),
    ).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  describe('capability cache: a rejected option is not re-tried on every call', () => {
    it('falls back to json_object once, then starts every later call there', async () => {
      fetchMock.mockResolvedValueOnce(FORMAT_REJECTED()).mockImplementation(answerByMode);
      const provider = new GroqProvider();

      const first = await provider.explainDetailed(req('core'), opts());
      expect(first).toMatchObject({
        startedWith: 'json_schema',
        responseMode: 'json_object',
        fellBack: true,
        requestCount: 2,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const second = await provider.explainDetailed(req('etymology'), opts());
      expect(fetchMock).toHaveBeenCalledTimes(3); // one request, no json_schema attempt
      expect(second).toMatchObject({
        startedWith: 'json_object',
        responseMode: 'json_object',
        fellBack: false,
        requestCount: 1,
      });
      expect(bodyOf(2).response_format).toEqual({ type: 'json_object' });
    });

    it('keeps verdicts per model and re-learns after invalidation (model change)', async () => {
      const cache = createCapabilityCache();
      fetchMock
        .mockResolvedValueOnce(FORMAT_REJECTED())
        .mockImplementation(async () => json(completion(JSON.stringify(OUTPUTS['core']))));
      const provider = new GroqProvider({ capabilityCache: cache });
      await provider.explain(req('core'), opts());
      expect(fetchMock).toHaveBeenCalledTimes(2);

      // Another model has its own verdict: it still starts in json_schema.
      await provider.explain(req('core'), opts({ model: 'openai/gpt-oss-120b' }));
      expect(bodyOf(2).response_format.type).toBe('json_schema');

      // The model preference changed: forget, so the first model is probed again.
      await cache.invalidate();
      fetchMock.mockClear();
      fetchMock.mockImplementation(async () => json(completion(JSON.stringify(OUTPUTS['core']))));
      await provider.explain(req('core'), opts());
      expect(bodyOf(0).response_format.type).toBe('json_schema');
    });

    it('a separate provider (a new cache) does not share verdicts', async () => {
      fetchMock
        .mockResolvedValueOnce(FORMAT_REJECTED())
        .mockImplementation(async () => json(completion(JSON.stringify(OUTPUTS['core']))));
      await new GroqProvider().explain(req('core'), opts());
      await new GroqProvider().explain(req('core'), opts());
      expect(bodyOf(2).response_format.type).toBe('json_schema');
    });

    it('drops reasoning_effort once Groq rejects it and remembers that', async () => {
      fetchMock
        .mockResolvedValueOnce(EFFORT_REJECTED())
        .mockImplementation(async () => json(completion(JSON.stringify(OUTPUTS['core']))));
      const provider = new GroqProvider();
      const first = await provider.explainDetailed(req('core'), opts());
      expect(first).toMatchObject({ reasoningEffort: null, requestCount: 2 });
      expect(bodyOf(0)).toHaveProperty('reasoning_effort', 'low');
      expect(bodyOf(1)).not.toHaveProperty('reasoning_effort');
      // Still json_schema: only the effort parameter was dropped.
      expect(bodyOf(1).response_format.type).toBe('json_schema');

      await provider.explain(req('core'), opts());
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(bodyOf(2)).not.toHaveProperty('reasoning_effort');
    });

    it('handles both rejections in one call, and never exceeds three requests', async () => {
      fetchMock
        .mockResolvedValueOnce(FORMAT_REJECTED())
        .mockResolvedValueOnce(EFFORT_REJECTED())
        .mockImplementation(async () => json(completion(JSON.stringify(OUTPUTS['core']))));
      const details = await new GroqProvider().explainDetailed(req('core'), opts());
      expect(details).toMatchObject({
        requestCount: 3,
        responseMode: 'json_object',
        reasoningEffort: null,
      });

      fetchMock.mockReset();
      fetchMock.mockImplementation(async () => FORMAT_REJECTED());
      await expect(new GroqProvider().explain(req('core'), opts())).rejects.toMatchObject({
        code: 'MODEL_UNAVAILABLE',
      });
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
    });

    it('remembers that json_schema worked for a model the table does not know', async () => {
      const cache = createCapabilityCache();
      fetchMock.mockImplementation(async () => json(completion(JSON.stringify(OUTPUTS['core']))));
      const provider = new GroqProvider({ capabilityCache: cache });
      // Unknown model: json_object by default.
      await provider.explain(req('core'), opts({ model: LLAMA }));
      expect(bodyOf(0).response_format.type).toBe('json_object');
      expect(await cache.get(LLAMA)).toEqual({});
      // An explicit json_schema request that succeeds is remembered, and used from then on.
      await provider.explain(req('core'), opts({ model: LLAMA, responseMode: 'json_schema' }));
      expect(await cache.get(LLAMA)).toEqual({ jsonSchema: true });
      await provider.explain(req('core'), opts({ model: LLAMA }));
      expect(bodyOf(2).response_format.type).toBe('json_schema');
      expect(bodyOf(2).response_format.json_schema.strict).toBe(false);
    });

    it('json_validate_failed is a model output failure: no fallback, no cached verdict, even if the message names the format', async () => {
      const cache = createCapabilityCache();
      fetchMock.mockImplementation(async () =>
        json(
          {
            error: {
              message: 'response_format json_schema: generated JSON does not match the schema',
              type: 'invalid_request_error',
              code: 'json_validate_failed',
            },
          },
          400,
        ),
      );
      await expect(
        new GroqProvider({ capabilityCache: cache }).explain(req('core'), opts()),
      ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', stage: 'schema' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await cache.get(GPT)).toEqual({});
    });

    it('an unrelated 400 caches nothing and is not retried', async () => {
      const cache = createCapabilityCache();
      fetchMock.mockResolvedValue(reject400('max_completion_tokens is too large'));
      await expect(
        new GroqProvider({ capabilityCache: cache }).explain(req('core'), opts()),
      ).rejects.toMatchObject({ code: 'MODEL_UNAVAILABLE' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await cache.get(GPT)).toEqual({});
    });
  });

  it('logs metadata only: no selection, context, prompt, answer or key', async () => {
    fetchMock.mockResolvedValueOnce(json(completion(JSON.stringify(OUTPUTS['simplify']))));
    await new GroqProvider().explain(req('simplify'), opts());
    fetchMock.mockResolvedValueOnce(json({ error: { message: `no ${SELECTED}` } }, 500));
    await expect(new GroqProvider().explain(req('simplify'), opts())).rejects.toBeInstanceOf(
      GroqError,
    );
    const logged = JSON.stringify(consoleOutput);
    expect(logged).toContain('groq_explain_failed');
    expect(logged).toContain('simplify');
    for (const secret of [
      SELECTED,
      'CONTEXTMARK',
      'Plain words',
      FAKE_KEY,
      'Bearer',
      'untrusted',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});

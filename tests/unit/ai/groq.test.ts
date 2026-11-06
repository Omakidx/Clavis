import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GROQ } from '../../../lib/config/constants';
import { explainRequestSchema, type ExplainRequest } from '../../../lib/contracts';
import { GroqError, GroqProvider, parseRetryAfter } from '../../../lib/ai';
import { explainRequest, snapshot } from '../contracts/fixtures';

const FAKE_KEY = 'gsk_TEST_unit_key_that_must_never_leak_0123456789';
const SELECTED = 'bank';

const CORE_OUTPUT = {
  title: 'bank',
  summary: 'The sloping land beside a river.',
  contextualMeaning: 'Here it means the riverside, not a financial institution.',
  definition: 'The raised ground along the edge of a river or lake.',
  examples: [{ sentence: 'We sat on the grassy bank.' }, { sentence: 'The river burst its bank.' }],
};

function request(overrides: Record<string, unknown> = {}): ExplainRequest {
  return explainRequestSchema.parse(
    explainRequest({
      snapshot: snapshot({ text: SELECTED, contextBefore: 'We fished from the river ' }),
      ...overrides,
    }),
  );
}

function completion(content: unknown, extra: Record<string, unknown> = {}) {
  return {
    choices: [{ message: { content, ...extra }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 80,
      total_tokens: 180,
      completion_tokens_details: { reasoning_tokens: 30 },
    },
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function errorBody(message: string, code?: string) {
  return { error: { message, type: 'invalid_request_error', ...(code ? { code } : {}) } };
}

describe('GroqProvider.explain', () => {
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
    model: 'openai/gpt-oss-20b',
    ...extra,
  });

  async function failure(promise: Promise<unknown>): Promise<GroqError> {
    try {
      await promise;
    } catch (error) {
      expect(error).toBeInstanceOf(GroqError);
      return error as GroqError;
    }
    throw new Error('expected the call to fail');
  }

  function expectNoLeak(error?: GroqError) {
    const text = JSON.stringify(consoleOutput) + (error ? error.message + String(error.stack) : '');
    expect(text).not.toContain(FAKE_KEY);
    expect(text).not.toContain('Bearer');
    expect(text).not.toContain('river'); // context text
  }

  it('maps a valid core JSON answer to an ExplainResult and sends a correct request', async () => {
    fetchMock.mockResolvedValue(json(completion(JSON.stringify(CORE_OUTPUT))));
    const result = await new GroqProvider().explain(request(), opts());

    expect(result).toMatchObject({
      mode: 'core',
      selectedText: SELECTED,
      title: 'bank',
      provider: 'groq',
      model: 'openai/gpt-oss-20b',
    });
    expect(result.examples).toHaveLength(2);
    expect(result).not.toHaveProperty('caveat');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GROQ.chatCompletionsUrl);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${FAKE_KEY}`);
    expect((init.headers as Record<string, string>)['Accept']).toBe('application/json');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'openai/gpt-oss-20b',
      reasoning_effort: 'low',
      response_format: { type: 'json_schema', json_schema: { strict: true } },
    });
    expect(body.response_format.json_schema.schema.required).toContain('caveat');
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    // The key must never be placed in the body.
    expect(init.body).not.toContain(FAKE_KEY);
    expectNoLeak();
  });

  it('accepts null for optional fields (strict mode shape) and keeps a real caveat', async () => {
    const strictShape = {
      ...CORE_OUTPUT,
      examples: [
        { sentence: 'One.', note: null },
        { sentence: 'Two.', note: 'a note' },
      ],
      caveat: 'Context is thin.',
    };
    fetchMock.mockResolvedValue(json(completion(JSON.stringify(strictShape))));
    const result = await new GroqProvider().explain(request(), opts());
    expect(result.caveat).toBe('Context is thin.');
    expect(result.examples?.[0]).toEqual({ sentence: 'One.' });

    fetchMock.mockResolvedValue(json(completion(JSON.stringify({ ...CORE_OUTPUT, caveat: null }))));
    expect(await new GroqProvider().explain(request(), opts())).not.toHaveProperty('caveat');
  });

  it('ignores the reasoning field and uses only choices[0].message.content', async () => {
    const body = completion(JSON.stringify(CORE_OUTPUT), {
      reasoning: 'secret chain of thought: {"title":"WRONG"}',
    });
    fetchMock.mockResolvedValue(json(body));
    const details = await new GroqProvider().explainDetailed(request(), opts());
    expect(details.result.title).toBe('bank');
    expect(JSON.stringify(details.result)).not.toContain('chain of thought');
    expect(details.usage).toEqual({
      promptTokens: 100,
      completionTokens: 80,
      totalTokens: 180,
      reasoningTokens: 30,
    });
    expect(details).toMatchObject({
      responseMode: 'json_schema',
      fellBack: false,
      requestCount: 1,
    });
  });

  it('only sends reasoning_effort to models known to accept it', async () => {
    fetchMock.mockResolvedValue(json(completion(JSON.stringify(CORE_OUTPUT))));
    await new GroqProvider().explain(request(), opts({ model: 'llama-3.1-8b-instant' }));
    const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty('reasoning_effort');
    // Unknown model: json_object by default, shape spelled out in the prompt.
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].content).toMatch(/JSON/);
  });

  it('INVALID_RESPONSE when content is not JSON', async () => {
    fetchMock.mockResolvedValue(json(completion('Sure! Here is the explanation: bank is...')));
    const error = await failure(new GroqProvider().explain(request(), opts()));
    expect(error).toMatchObject({ code: 'INVALID_RESPONSE', stage: 'json' });
    expect(error.usage?.completionTokens).toBe(80);
    expect(error.message).not.toContain('Sure');
  });

  it('INVALID_RESPONSE when JSON fails the schema', async () => {
    const bad = { ...CORE_OUTPUT, examples: [{ sentence: 'only one' }] };
    fetchMock.mockResolvedValue(json(completion(JSON.stringify(bad))));
    expect(await failure(new GroqProvider().explain(request(), opts()))).toMatchObject({
      code: 'INVALID_RESPONSE',
      stage: 'schema',
    });
  });

  it('INVALID_RESPONSE for empty content, truncation and a malformed body', async () => {
    const provider = new GroqProvider();
    fetchMock.mockResolvedValueOnce(json(completion(null)));
    expect(await failure(provider.explain(request(), opts()))).toMatchObject({ stage: 'empty' });

    const truncated = completion('{"title":"ba');
    truncated.choices[0]!.finish_reason = 'length';
    fetchMock.mockResolvedValueOnce(json(truncated));
    expect(await failure(provider.explain(request(), opts()))).toMatchObject({
      stage: 'truncated',
    });

    fetchMock.mockResolvedValueOnce(new Response('<html>oops</html>', { status: 200 }));
    expect(await failure(provider.explain(request(), opts()))).toMatchObject({ stage: 'body' });
  });

  describe('400 handling', () => {
    it('retries once in json_object mode when response_format is unsupported', async () => {
      fetchMock
        .mockResolvedValueOnce(
          json(
            errorBody('`response_format` of type `json_schema` is not supported with this model'),
            {
              status: 400,
            },
          ),
        )
        .mockResolvedValueOnce(json(completion(JSON.stringify(CORE_OUTPUT))));
      const details = await new GroqProvider().explainDetailed(request(), opts());

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const second = JSON.parse(
        (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
      );
      expect(second.response_format).toEqual({ type: 'json_object' });
      expect(details).toMatchObject({
        responseMode: 'json_object',
        fellBack: true,
        requestCount: 2,
      });
    });

    it('does not loop: a second 400 in json_object mode is final', async () => {
      fetchMock.mockImplementation(async () =>
        json(errorBody('response_format unsupported'), { status: 400 }),
      );
      const error = await failure(new GroqProvider().explain(request(), opts()));
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(error).toMatchObject({ code: 'MODEL_UNAVAILABLE', status: 400 });
    });

    it('does not fall back on an unrelated 400', async () => {
      fetchMock.mockResolvedValue(
        json(errorBody('max_completion_tokens is too large'), { status: 400 }),
      );
      const error = await failure(new GroqProvider().explain(request(), opts()));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(error).toMatchObject({ code: 'MODEL_UNAVAILABLE', status: 400 });
      expect(error.providerErrorType).toBe('invalid_request_error');
    });

    it('maps json_validate_failed to INVALID_RESPONSE without falling back', async () => {
      fetchMock.mockResolvedValue(
        json(
          errorBody('Generated JSON does not match the expected schema.', 'json_validate_failed'),
          {
            status: 400,
          },
        ),
      );
      const error = await failure(new GroqProvider().explain(request(), opts()));
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(error).toMatchObject({ code: 'INVALID_RESPONSE', stage: 'schema' });
    });
  });

  it.each([
    [401, 'INVALID_API_KEY'],
    [403, 'NETWORK_ERROR'],
    [404, 'MODEL_UNAVAILABLE'],
    [408, 'TIMEOUT'],
    // The request (selection plus context) is larger than the model takes: not a connection problem.
    [413, 'SELECTION_TOO_LONG'],
    [500, 'NETWORK_ERROR'],
    [503, 'NETWORK_ERROR'],
  ])('maps HTTP %i to %s without leaking the key', async (status, code) => {
    fetchMock.mockResolvedValue(
      json({ error: { message: `bad key ${FAKE_KEY}`, type: 'x' } }, { status }),
    );
    const error = await failure(new GroqProvider().explain(request(), opts()));
    expect(error).toMatchObject({ code, status });
    expect(error.toEnvelope()).toEqual({
      code,
      message: error.message,
      httpStatus: status,
      ...(status === 403 ? { forbiddenReason: 'unknown' } : {}),
    });
    expectNoLeak(error);
  });

  it.each([
    ['code', 'model_permission_blocked'],
    ['code', 'model_permission_blocked_org'],
    ['code', 'model_permission_blocked_project'],
    ['type', 'model_permission_blocked_project'],
  ] as const)('maps a 403 %s=%s to MODEL_UNAVAILABLE', async (field, providerCode) => {
    fetchMock.mockResolvedValue(
      json({ error: { message: 'Access blocked', [field]: providerCode } }, { status: 403 }),
    );
    const error = await failure(new GroqProvider().explain(request(), opts()));
    expect(error).toMatchObject({ code: 'MODEL_UNAVAILABLE', status: 403 });
    expectNoLeak(error);
  });

  describe('429', () => {
    it('parses Retry-After in seconds', async () => {
      fetchMock.mockResolvedValue(
        json(errorBody('rate'), { status: 429, headers: { 'retry-after': '7' } }),
      );
      const error = await failure(new GroqProvider().explain(request(), opts()));
      expect(error).toMatchObject({ code: 'RATE_LIMITED', retryAfterMs: 7000 });
      expect(error.toEnvelope().retryAfterMs).toBe(7000);
    });

    it('parses Retry-After as an HTTP-date', async () => {
      const wall = Date.parse('2026-10-22T12:00:00Z');
      fetchMock.mockResolvedValue(
        json(errorBody('rate'), {
          status: 429,
          headers: { 'retry-after': 'Thu, 22 Oct 2026 12:00:30 GMT' },
        }),
      );
      const error = await failure(
        new GroqProvider({ wallNow: () => wall }).explain(request(), opts()),
      );
      expect(error.retryAfterMs).toBe(30_000);
    });

    it('clamps to one hour and omits the value when absent or junk', async () => {
      fetchMock.mockResolvedValueOnce(
        json(errorBody('rate'), { status: 429, headers: { 'retry-after': '999999' } }),
      );
      expect((await failure(new GroqProvider().explain(request(), opts()))).retryAfterMs).toBe(
        3_600_000,
      );
      fetchMock.mockResolvedValueOnce(
        json(errorBody('rate'), { status: 429, headers: { 'retry-after': 'soon' } }),
      );
      expect((await failure(new GroqProvider().explain(request(), opts()))).retryAfterMs).toBe(
        undefined,
      );
      fetchMock.mockResolvedValueOnce(json(errorBody('rate'), { status: 429 }));
      expect((await failure(new GroqProvider().explain(request(), opts()))).retryAfterMs).toBe(
        undefined,
      );
    });
  });

  it('maps a network TypeError to NETWORK_ERROR without forwarding its message', async () => {
    fetchMock.mockRejectedValue(new TypeError(`Failed to fetch https://x?key=${FAKE_KEY}`));
    const error = await failure(new GroqProvider().explain(request(), opts()));
    expect(error.code).toBe('NETWORK_ERROR');
    expectNoLeak(error);
  });

  it('maps the deadline to TIMEOUT and a caller abort to REQUEST_CANCELLED', async () => {
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const provider = new GroqProvider();
    expect(await failure(provider.explain(request(), opts({ timeoutMs: 20 })))).toMatchObject({
      code: 'TIMEOUT',
    });

    const controller = new AbortController();
    const pending = failure(provider.explain(request(), opts({ signal: controller.signal })));
    controller.abort();
    expect(await pending).toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  describe('transport hardening', () => {
    const HARDENED = {
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    };

    it('sends hardened fetch options on chat and models calls', async () => {
      fetchMock.mockImplementation(async (url: string) =>
        url === GROQ.modelsUrl ? json({ data: [] }) : json(completion(JSON.stringify(CORE_OUTPUT))),
      );
      const provider = new GroqProvider();
      await provider.explain(request(), opts());
      await provider.listModels(FAKE_KEY);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const call of fetchMock.mock.calls as [string, RequestInit][]) {
        expect(call[1]).toMatchObject(HARDENED);
      }
    });

    it('maps a refused redirect (fetch rejects with TypeError) to NETWORK_ERROR', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch: redirect mode is "error"'));
      const error = await failure(new GroqProvider().explain(request(), opts()));
      expect(error.code).toBe('NETWORK_ERROR');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expectNoLeak(error);
    });

    it('maps a 3xx response to NETWORK_ERROR and never follows it', async () => {
      fetchMock.mockImplementation(
        async () =>
          new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } }),
      );
      const error = await failure(new GroqProvider().explain(request(), opts()));
      expect(error).toMatchObject({ code: 'NETWORK_ERROR', status: 302 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    function endlessBody() {
      const state = { pulls: 0, cancelled: false };
      const chunk = new Uint8Array(256 * 1024).fill(0x61);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          state.pulls += 1;
          controller.enqueue(chunk);
        },
        cancel() {
          state.cancelled = true;
        },
      });
      return { state, stream };
    }

    it('aborts an oversize streamed body without reading it all', async () => {
      const { state, stream } = endlessBody();
      fetchMock.mockImplementation(async () => new Response(stream, { status: 200 }));
      const error = await failure(new GroqProvider().explain(request(), opts()));
      expect(error).toMatchObject({ code: 'INVALID_RESPONSE', stage: 'body' });
      expect(state.cancelled).toBe(true);
      // 1 MiB cap / 256 KiB chunks: a handful of pulls (plus stream buffering), never unbounded.
      expect(state.pulls).toBeLessThan(10);
    });

    it('rejects on a declared Content-Length over the cap without reading the body', async () => {
      const { state, stream } = endlessBody();
      fetchMock.mockImplementation(
        async () =>
          new Response(stream, { status: 200, headers: { 'content-length': '99999999' } }),
      );
      const error = await failure(new GroqProvider().explain(request(), opts()));
      expect(error).toMatchObject({ code: 'INVALID_RESPONSE', stage: 'body' });
      expect(state.cancelled).toBe(true);
      expect(state.pulls).toBeLessThan(3); // only the stream's initial buffering, not a read loop
    });

    it('applies the same cap to error bodies and to the models list', async () => {
      const { state, stream } = endlessBody();
      fetchMock.mockImplementation(async () => new Response(stream, { status: 500 }));
      expect(await failure(new GroqProvider().listModels(FAKE_KEY))).toMatchObject({
        code: 'INVALID_RESPONSE',
        stage: 'body',
      });
      expect(state.cancelled).toBe(true);
    });

    it('still reads a normal multi-chunk body correctly', async () => {
      const bytes = new TextEncoder().encode(
        JSON.stringify(completion(JSON.stringify(CORE_OUTPUT))),
      );
      const half = Math.floor(bytes.length / 2);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, half));
          controller.enqueue(bytes.slice(half));
          controller.close();
        },
      });
      fetchMock.mockImplementation(async () => new Response(stream, { status: 200 }));
      const result = await new GroqProvider().explain(request(), opts());
      expect(result.title).toBe('bank');
    });
  });

  it('rejects bad input before any network call', async () => {
    const provider = new GroqProvider();
    for (const apiKey of ['', 'gsk_TEST bad\nkey', 'x'.repeat(600)]) {
      expect(await failure(provider.explain(request(), opts({ apiKey })))).toMatchObject({
        code: 'INVALID_API_KEY',
      });
    }
    await expect(
      provider.explain({ ...request(), requestId: 'nope' } as ExplainRequest, opts()),
    ).rejects.toThrow(/Invalid explain request/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs metadata only', async () => {
    fetchMock.mockResolvedValueOnce(json(completion(JSON.stringify(CORE_OUTPUT))));
    await new GroqProvider().explain(request(), opts());
    fetchMock.mockResolvedValueOnce(json(errorBody('x'), { status: 401 }));
    await failure(new GroqProvider().explain(request(), opts()));
    expect(consoleOutput.length).toBeGreaterThan(0);
    const logged = JSON.stringify(consoleOutput);
    expect(logged).toContain('groq_explain_failed');
    expect(logged).toContain('INVALID_API_KEY');
    expectNoLeak();
  });
});

describe('GroqProvider.listModels', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('parses the model list and flags JSON-schema capable models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      json({
        object: 'list',
        data: [
          { id: 'openai/gpt-oss-20b', owned_by: 'OpenAI', active: true, context_window: 131072 },
          { id: 'llama-3.1-8b-instant', owned_by: 'Meta', active: true },
          { id: 'whisper-large-v3', extra: 'ignored' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const models = await new GroqProvider().listModels(FAKE_KEY);

    expect(models).toEqual([
      {
        id: 'openai/gpt-oss-20b',
        ownedBy: 'OpenAI',
        active: true,
        contextWindow: 131072,
        supportsJsonSchema: true,
      },
      { id: 'llama-3.1-8b-instant', ownedBy: 'Meta', active: true, supportsJsonSchema: false },
      { id: 'whisper-large-v3', supportsJsonSchema: false },
    ]);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GROQ.modelsUrl);
    expect(init.method).toBe('GET');
    expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${FAKE_KEY}`);
    expect((init.headers as Record<string, string>)['Accept']).toBe('application/json');
    expect(init.body).toBeUndefined();
  });

  it.each([
    [401, 'INVALID_API_KEY'],
    [403, 'NETWORK_ERROR'],
    [429, 'RATE_LIMITED'],
    [502, 'NETWORK_ERROR'],
  ])('maps HTTP %i to %s', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(errorBody('no'), { status })));
    await expect(new GroqProvider().listModels(FAKE_KEY)).rejects.toMatchObject({ code });
  });

  it.each([
    ['model_permission_blocked_org', 'model_permission_org'],
    ['model_permission_blocked_project', 'model_permission_project'],
    ['model_permission_blocked', 'model_permission'],
  ] as const)(
    'classifies allowlisted %s without exposing its message',
    async (providerCode, reason) => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          json(
            {
              error: {
                code: providerCode,
                type: 'permissions_error',
                message: `secret ${FAKE_KEY}`,
              },
            },
            { status: 403 },
          ),
        ),
      );
      try {
        await new GroqProvider().listModels(FAKE_KEY);
        throw new Error('expected 403');
      } catch (error) {
        expect(error).toMatchObject({ status: 403, forbiddenReason: reason });
        expect((error as GroqError).toEnvelope()).toMatchObject({ forbiddenReason: reason });
        expect(JSON.stringify((error as GroqError).toEnvelope())).not.toContain(FAKE_KEY);
        expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
      }
    },
  );

  it.each([
    ['1009', '<html>Cloudflare Error 1009 secret ' + FAKE_KEY + '</html>', 'region_block'],
    ['1010', '<html>Cloudflare Error 1010 secret ' + FAKE_KEY + '</html>', 'edge_block'],
    ['1020', 'Cloudflare Error 1020 secret ' + FAKE_KEY, 'edge_block'],
    ['unidentified', '<html>Cloudflare block secret ' + FAKE_KEY + '</html>', 'unknown'],
    ['no Cloudflare marker', '<html>Error 1010 secret ' + FAKE_KEY + '</html>', 'unknown'],
  ] as const)(
    'classifies a 403 edge response conservatively (%s)',
    async (_label, body, reason) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 403 })));
      try {
        await new GroqProvider().listModels(FAKE_KEY);
        throw new Error('expected 403');
      } catch (error) {
        expect(error).toMatchObject({ status: 403, forbiddenReason: reason });
        expect(JSON.stringify((error as GroqError).toEnvelope())).not.toContain(FAKE_KEY);
        expect(JSON.stringify(error)).not.toContain(FAKE_KEY);
      }
    },
  );

  it('INVALID_RESPONSE on a malformed list and NETWORK_ERROR when offline', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ data: 'nope' })));
    await expect(new GroqProvider().listModels(FAKE_KEY)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(new GroqProvider().listModels(FAKE_KEY)).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });

  it('honours a caller abort', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      ),
    );
    const controller = new AbortController();
    const pending = new GroqProvider().listModels(FAKE_KEY, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_CANCELLED' });
  });

  it.each([
    [401, 'auth-required'],
    [403, 'forbidden'],
    [200, 'other-response'],
  ] as const)(
    'classifies keyless models HTTP %i without reading its body',
    async (status, expected) => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(`private ${FAKE_KEY}`, { status }));
      const provider = new GroqProvider({ fetch: fetchMock });
      expect(await provider.probeUnauthenticatedAccess()).toBe(expected);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(GROQ.modelsUrl);
      expect(init.method).toBe('GET');
      expect(init.headers).toEqual({ Accept: 'application/json' });
      expect(JSON.stringify(init)).not.toContain(FAKE_KEY);
      expect(init.body).toBeUndefined();
      expect(init.credentials).toBe('omit');
      expect(init.referrerPolicy).toBe('no-referrer');
      expect(init.cache).toBe('no-store');
      expect(init.redirect).toBe('error');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    },
  );

  it('classifies keyless transport failure as unreachable', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError(`private ${FAKE_KEY}`));
    expect(await new GroqProvider({ fetch: fetchMock }).probeUnauthenticatedAccess()).toBe(
      'unreachable',
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  it('handles seconds, decimals, dates in the past, and junk', () => {
    expect(parseRetryAfter('3', now)).toBe(3000);
    expect(parseRetryAfter('1.5', now)).toBe(1500);
    expect(parseRetryAfter('Thu, 22 Oct 2026 11:00:00 GMT', now)).toBe(0);
    expect(parseRetryAfter('-5', now)).toBeUndefined();
    expect(parseRetryAfter('', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroqProvider } from '../../../lib/ai/groq';
import {
  aiStatusSchema,
  explainResultSchema,
  messageReplySchema,
  publicSettingsSchema,
} from '../../../lib/contracts';
import { MODEL_CANDIDATES } from '../../../lib/config/constants';
import { createAiHandlers } from '../../../lib/router/handlers/ai';
import { createKeyService } from '../../../lib/router/handlers/key';
import { createAiGuard } from '../../../lib/router/limiter';
import { createApiKeyStore, createSettingsStore } from '../../../lib/storage';
import { MemoryArea } from '../storage/memory-area';
import {
  FAKE_KEY,
  KEY_MESSAGES,
  PUBLIC_MESSAGES,
  REQ_A,
  REQ_B,
  RESULT,
  SETTINGS_MESSAGES,
  contentSender,
  createHarness,
  explainMessage,
  failWith,
  makeReady,
  pageSender,
  popupSender,
  type Harness,
} from './harness';

const status = (h: Harness, sender = contentSender()) =>
  h.call(PUBLIC_MESSAGES['GET_AI_STATUS'], sender);
const options = pageSender('/options.html');

describe('GET_AI_STATUS', () => {
  it('walks storage_unavailable, setup_required, disclosure_required, invalid_key, ready', async () => {
    const locked = createHarness({ lockedDown: false });
    expect(await status(locked)).toEqual({ ok: true, data: { state: 'storage_unavailable' } });

    const h = createHarness();
    expect(await status(h)).toEqual({ ok: true, data: { state: 'setup_required' } });

    await h.call(KEY_MESSAGES['SET_API_KEY'], options);
    expect(await status(h)).toEqual({
      ok: true,
      data: { state: 'disclosure_required', model: MODEL_CANDIDATES.quick },
    });

    await h.call(SETTINGS_MESSAGES['ACCEPT_DISCLOSURE'], options);
    expect(await status(h)).toEqual({
      ok: true,
      data: { state: 'ready', model: MODEL_CANDIDATES.quick },
    });

    h.provider.listModels.mockRejectedValue(failWith('INVALID_API_KEY', 401));
    await h.call(KEY_MESSAGES['TEST_API_KEY'], options);
    expect(await status(h)).toMatchObject({ ok: true, data: { state: 'invalid_key' } });
  });

  it('is ready, not blocked, when the key could not be verified (offline)', async () => {
    const h = createHarness();
    h.provider.listModels.mockRejectedValue(failWith('NETWORK_ERROR'));
    await makeReady(h);
    expect(await status(h)).toMatchObject({ ok: true, data: { state: 'ready' } });
  });

  it('stays ready and reports the preferred model, even if it left the model list (FR-005)', async () => {
    const h = createHarness();
    await makeReady(h);
    await h.call(
      { v: 1, type: 'UPDATE_PREFERENCES', patch: { model: 'retired/model-1' } },
      options,
    );
    expect(await status(h)).toEqual({
      ok: true,
      data: { state: 'ready', model: 'retired/model-1' },
    });
    // The UI learns the model is missing from KeyStatus.models and prompts; nothing switches silently.
    const keyStatus = (await h.call(KEY_MESSAGES['GET_KEY_STATUS'], options)) as {
      data: { models: { id: string }[] };
    };
    expect(keyStatus.data.models.map((m) => m.id)).not.toContain('retired/model-1');
    expect((await h.settingsStore.getPreferences()).model).toBe('retired/model-1');
  });

  it('matches the contract and exposes nothing key-related', async () => {
    const h = createHarness();
    await makeReady(h);
    const reply = messageReplySchema(aiStatusSchema).parse(await status(h));
    expect(JSON.stringify(reply)).not.toContain(FAKE_KEY);
  });
});

describe('GET_PUBLIC_SETTINGS (secret boundary rule 3)', () => {
  const reply = messageReplySchema(publicSettingsSchema);

  it('returns hasKey and non-secret settings only, in a strict shape', async () => {
    const h = createHarness();
    const empty = reply.parse(
      await h.call(PUBLIC_MESSAGES['GET_PUBLIC_SETTINGS'], contentSender()),
    );
    expect(empty).toEqual({
      ok: true,
      data: {
        hasKey: false,
        disclosureAccepted: false,
        explanationLanguage: 'en',
        readingLevel: 'standard',
        tooltipBehavior: 'automatic',
        ttsRate: 1,
      },
    });

    await makeReady(h);
    await h.call(
      { v: 1, type: 'UPDATE_PREFERENCES', patch: { ttsLang: 'en-GB', model: 'm', ttsRate: 0.75 } },
      options,
    );
    const full = reply.parse(await h.call(PUBLIC_MESSAGES['GET_PUBLIC_SETTINGS'], contentSender()));
    expect(full).toMatchObject({
      ok: true,
      data: { hasKey: true, disclosureAccepted: true, ttsLang: 'en-GB', model: 'm', ttsRate: 0.75 },
    });
    const text = JSON.stringify(full);
    for (const secret of [FAKE_KEY, '1234', 'local', 'session', 'verification', 'last4']) {
      expect(text).not.toContain(secret);
    }
  });

  it('says hasKey:false rather than failing when storage is locked down', async () => {
    const h = createHarness({ lockedDown: false });
    expect(await h.call(PUBLIC_MESSAGES['GET_PUBLIC_SETTINGS'], contentSender())).toMatchObject({
      ok: true,
      data: { hasKey: false },
    });
  });

  it('does not list the disabled sites to web pages', async () => {
    const h = createHarness();
    await h.call(
      { v: 1, type: 'UPDATE_PREFERENCES', patch: { disabledSites: ['private.example'] } },
      options,
    );
    expect(
      JSON.stringify(await h.call(PUBLIC_MESSAGES['GET_PUBLIC_SETTINGS'], contentSender())),
    ).not.toContain('private.example');
  });
});

describe('AI_EXPLAIN readiness gate', () => {
  it('SETUP_REQUIRED without a key, without calling the provider', async () => {
    const h = createHarness();
    expect(await h.call(explainMessage(), contentSender())).toEqual({
      ok: false,
      requestId: REQ_A,
      error: expect.objectContaining({ code: 'SETUP_REQUIRED' }),
    });
    expect(h.provider.explain).not.toHaveBeenCalled();
  });

  it('SETUP_REQUIRED until the disclosure is accepted (FR-002)', async () => {
    const h = createHarness();
    await h.call(KEY_MESSAGES['SET_API_KEY'], options);
    expect(await h.call(explainMessage(), contentSender())).toMatchObject({
      ok: false,
      error: { code: 'SETUP_REQUIRED' },
    });
    expect(h.provider.explain).not.toHaveBeenCalled();
  });

  it('STORAGE_UNAVAILABLE (fail closed) when the lockdown failed', async () => {
    const h = createHarness({ lockedDown: false });
    expect(await h.call(explainMessage(), contentSender())).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_UNAVAILABLE' },
    });
    expect(h.provider.explain).not.toHaveBeenCalled();
    expect(h.local.get).not.toHaveBeenCalled();
    expect(h.session.get).not.toHaveBeenCalled();
  });

  it('INVALID_API_KEY when the last check said so, without a network call', async () => {
    const h = createHarness();
    await makeReady(h);
    h.provider.listModels.mockRejectedValue(failWith('INVALID_API_KEY', 401));
    await h.call(KEY_MESSAGES['TEST_API_KEY'], options);
    expect(await h.call(explainMessage(), contentSender())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_API_KEY' },
    });
    expect(h.provider.explain).not.toHaveBeenCalled();
  });

  it('INVALID_REQUEST for modes other than core (Phase 5), after the sender checks', async () => {
    const h = createHarness();
    await makeReady(h);
    expect(
      await h.call(explainMessage(REQ_A, { mode: 'etymology' }), contentSender()),
    ).toMatchObject({ ok: false, requestId: REQ_A, error: { code: 'INVALID_REQUEST' } });
    expect(h.provider.explain).not.toHaveBeenCalled();
  });
});

describe('AI_EXPLAIN', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness();
    await makeReady(h);
  });

  it('calls the provider with the stored key and the default model, and returns the result', async () => {
    const reply = messageReplySchema(explainResultSchema).parse(
      await h.call(explainMessage(), contentSender()),
    );
    expect(reply).toEqual({ ok: true, requestId: REQ_A, data: RESULT });
    expect(h.provider.explain).toHaveBeenCalledTimes(1);
    const [request, options_] = h.provider.explain.mock.calls[0]!;
    expect(request.snapshot.text).toBe('bank');
    expect(options_).toMatchObject({ apiKey: FAKE_KEY, model: MODEL_CANDIDATES.quick });
    expect(options_.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(reply)).not.toContain(FAKE_KEY);
  });

  it('uses the preferred model and fills in the explanation language from preferences', async () => {
    await h.call(
      {
        v: 1,
        type: 'UPDATE_PREFERENCES',
        patch: { model: 'openai/gpt-oss-120b', explanationLanguage: 'fr' },
      },
      options,
    );
    await h.call(explainMessage(), contentSender());
    const [request, options_] = h.provider.explain.mock.calls[0]!;
    expect(options_.model).toBe('openai/gpt-oss-120b');
    expect(request.targetLanguage).toBe('fr');
    await h.call(explainMessage(REQ_B, { targetLanguage: 'de' }), contentSender(6));
    expect(h.provider.explain.mock.calls[1]![0].targetLanguage).toBe('de');
  });

  it('maps provider errors to envelopes, keeping retryAfterMs for rate limits', async () => {
    const rateLimited = Object.assign(failWith('RATE_LIMITED', 429), { retryAfterMs: 7_000 });
    h.provider.explain.mockRejectedValueOnce(rateLimited);
    expect(await h.call(explainMessage(), contentSender())).toEqual({
      ok: false,
      requestId: REQ_A,
      error: expect.objectContaining({ code: 'RATE_LIMITED', retryAfterMs: 7_000 }),
    });
    for (const code of [
      'NETWORK_ERROR',
      'TIMEOUT',
      'MODEL_UNAVAILABLE',
      'INVALID_RESPONSE',
    ] as const) {
      h.provider.explain.mockRejectedValueOnce(failWith(code));
      expect(await h.call(explainMessage(REQ_A), contentSender(20))).toMatchObject({
        ok: false,
        error: { code },
      });
    }
  });

  it('an unexpected error becomes a generic envelope without its text', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    h.provider.explain.mockRejectedValueOnce(new Error(`secret ${FAKE_KEY}`));
    const reply = await h.call(explainMessage(), contentSender());
    expect(reply).toMatchObject({ ok: false });
    expect(JSON.stringify(reply)).not.toContain('gsk_TEST');
  });

  it('a 401 from Groq flips the key to invalid and keeps every setting (FR-072)', async () => {
    await h.call(
      { v: 1, type: 'UPDATE_PREFERENCES', patch: { readingLevel: 'advanced' } },
      options,
    );
    h.provider.explain.mockRejectedValueOnce(failWith('INVALID_API_KEY', 401));
    expect(await h.call(explainMessage(), contentSender())).toMatchObject({
      ok: false,
      error: { code: 'INVALID_API_KEY' },
    });
    expect(await status(h)).toMatchObject({ data: { state: 'invalid_key' } });
    expect((await h.call(KEY_MESSAGES['GET_KEY_STATUS'], options)) as object).toMatchObject({
      data: { hasKey: true, verification: 'invalid' },
    });
    expect(await h.settingsStore.getPreferences()).toMatchObject({ readingLevel: 'advanced' });
  });

  it('works from the reader and the practice page too', async () => {
    for (const sender of [
      pageSender('/reader.html', 3),
      pageSender('/practice.html', 4),
      popupSender(),
    ]) {
      expect(await h.call(explainMessage(REQ_A), sender)).toMatchObject({ ok: true });
    }
  });
});

describe('one in-flight request per sender, and a rate limit', () => {
  /** A provider whose explain() stays pending until released, and rejects when aborted. */
  function slowProvider(h: Harness) {
    const pending: { signal: AbortSignal; finish: () => void }[] = [];
    h.provider.explain.mockImplementation(
      (_request, opts) =>
        new Promise((resolve, reject) => {
          const signal = opts.signal as AbortSignal;
          pending.push({ signal, finish: () => resolve(RESULT) });
          signal.addEventListener('abort', () => reject(failWith('REQUEST_CANCELLED')));
        }),
    );
    return pending;
  }

  it('a new AI_EXPLAIN from the same tab aborts the previous one', async () => {
    const h = createHarness();
    await makeReady(h);
    const pending = slowProvider(h);
    const first = h.call(explainMessage(REQ_A), contentSender(5));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    const second = h.call(explainMessage(REQ_B), contentSender(5));
    await vi.waitFor(() => expect(pending).toHaveLength(2));

    expect(pending[0]!.signal.aborted).toBe(true);
    expect(pending[1]!.signal.aborted).toBe(false);
    expect(await first).toMatchObject({
      ok: false,
      requestId: REQ_A,
      error: { code: 'REQUEST_CANCELLED' },
    });
    pending[1]!.finish();
    expect(await second).toMatchObject({ ok: true, requestId: REQ_B });
    expect(h.guard.inFlight.size).toBe(0);
  });

  it('different tabs do not abort each other', async () => {
    const h = createHarness();
    await makeReady(h);
    const pending = slowProvider(h);
    const a = h.call(explainMessage(REQ_A), contentSender(1));
    const b = h.call(explainMessage(REQ_B), contentSender(2));
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    expect(pending.every((p) => !p.signal.aborted)).toBe(true);
    pending.forEach((p) => p.finish());
    expect(await a).toMatchObject({ ok: true });
    expect(await b).toMatchObject({ ok: true });
  });

  it('AI_CANCEL aborts the sender own request, and only that one', async () => {
    const h = createHarness();
    await makeReady(h);
    const pending = slowProvider(h);
    const request = h.call(explainMessage(REQ_A), contentSender(5));
    await vi.waitFor(() => expect(pending).toHaveLength(1));

    const cancel = { v: 1, type: 'AI_CANCEL', requestId: REQ_A };
    // Another tab cannot cancel it.
    expect(await h.call(cancel, contentSender(6))).toEqual({
      ok: true,
      requestId: REQ_A,
      data: { cancelled: false },
    });
    expect(pending[0]!.signal.aborted).toBe(false);
    expect(await h.call(cancel, contentSender(5))).toEqual({
      ok: true,
      requestId: REQ_A,
      data: { cancelled: true },
    });
    expect(await request).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
  });

  it('removing the key aborts an in-flight request', async () => {
    const h = createHarness();
    await makeReady(h);
    const pending = slowProvider(h);
    const request = h.call(explainMessage(REQ_A), contentSender(5));
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await h.call(KEY_MESSAGES['REMOVE_API_KEY'], options);
    expect(pending[0]!.signal.aborted).toBe(true);
    expect(await request).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
  });

  describe('rate limit', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('allows 10 per minute per tab, then RATE_LIMITED with retryAfterMs; other tabs unaffected', async () => {
      const h = createHarness();
      await makeReady(h);
      for (let i = 0; i < 10; i++) {
        expect(await h.call(explainMessage(), contentSender(5))).toMatchObject({ ok: true });
      }
      const limited = await h.call(explainMessage(), contentSender(5));
      expect(limited).toEqual({
        ok: false,
        requestId: REQ_A,
        error: expect.objectContaining({ code: 'RATE_LIMITED', retryAfterMs: 6_000 }),
      });
      expect(h.provider.explain).toHaveBeenCalledTimes(10);
      expect(await h.call(explainMessage(), contentSender(6))).toMatchObject({ ok: true });

      vi.advanceTimersByTime(6_000);
      expect(await h.call(explainMessage(), contentSender(5))).toMatchObject({ ok: true });
    });

    it('a rate-limited request does not abort the one already running', async () => {
      const h = createHarness();
      await makeReady(h);
      const pending = slowProvider(h);
      const first = h.call(explainMessage(REQ_A), contentSender(5));
      await vi.waitFor(() => expect(pending).toHaveLength(1));
      for (let i = 0; i < 9; i++) h.guard.buckets.take('tab:5');
      expect(await h.call(explainMessage(REQ_B), contentSender(5))).toMatchObject({
        ok: false,
        error: { code: 'RATE_LIMITED' },
      });
      expect(pending[0]!.signal.aborted).toBe(false);
      pending[0]!.finish();
      expect(await first).toMatchObject({ ok: true });
    });
  });
});

describe('AI_EXPLAIN through the real GroqProvider with a mocked fetch', () => {
  function build(fetchImpl: typeof fetch) {
    const local = new MemoryArea();
    const session = new MemoryArea();
    const lockedDown = () => Promise.resolve(true);
    const provider = new GroqProvider({
      fetch: fetchImpl as never,
      logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const settings = createSettingsStore({ area: local });
    const keys = createApiKeyStore({ local, session, lockedDown });
    const guard = createAiGuard();
    const keyService = createKeyService({
      store: keys,
      provider,
      now: Date.now,
      onKeyChanged: () => undefined,
    });
    const ai = createAiHandlers({ settings, keys, keyService, provider, guard, lockedDown });
    return { local, settings, keys, keyService, ai };
  }

  const completion = {
    choices: [
      {
        message: {
          content: JSON.stringify({
            title: 'bank',
            summary: 'An institution that holds money.',
            contextualMeaning: 'A place for money.',
            definition: 'A financial institution.',
            examples: [{ sentence: 'I went to the bank.' }, { sentence: 'The bank is closed.' }],
          }),
        },
        finish_reason: 'stop',
      },
    ],
  };
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('sends the key only in the Authorization header, and nothing key-like comes back', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(
        url.endsWith('/models') ? json({ data: [{ id: 'openai/gpt-oss-20b' }] }) : json(completion),
      );
    });
    const { keyService, settings, ai } = build(fetchMock as never);
    await keyService.set(FAKE_KEY, 'local');
    await settings.acceptDisclosure();
    const request = explainMessage().payload as never;
    const reply = await ai.explain(request, { sender: { kind: 'content', tabId: 1 } });
    expect(reply).toMatchObject({
      ok: true,
      data: { mode: 'core', title: 'bank', provider: 'groq' },
    });

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.groq.com/openai/v1/models',
      'https://api.groq.com/openai/v1/chat/completions',
    ]);
    for (const { init } of calls) {
      expect((init.headers as Record<string, string>)['Authorization']).toBe(`Bearer ${FAKE_KEY}`);
      expect(String(init.body ?? '')).not.toContain(FAKE_KEY);
      expect(init.redirect).toBe('error');
    }
    expect(JSON.stringify(reply)).not.toContain(FAKE_KEY);
  });

  it('a real 401 from the explain endpoint maps to INVALID_API_KEY and marks the key invalid', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/models')
          ? json({ data: [] })
          : json({ error: { message: 'Invalid API Key', type: 'invalid_request_error' } }, 401),
      ),
    );
    const { keyService, settings, ai, keys } = build(fetchMock as never);
    await keyService.set(FAKE_KEY, 'local');
    await settings.acceptDisclosure();
    const reply = await ai.explain(explainMessage().payload as never, {
      sender: { kind: 'content', tabId: 1 },
    });
    expect(reply).toMatchObject({ ok: false, error: { code: 'INVALID_API_KEY' } });
    expect((await keys.getStatus()).verification).toBe('invalid');
  });

  it('a network failure on the key check is "unverified", not invalid', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    const { keyService } = build(fetchMock as never);
    const reply = await keyService.set(FAKE_KEY, 'session');
    expect(reply).toMatchObject({
      ok: true,
      data: { verification: 'unverified', storage: 'session' },
    });
  });

  it('a 403 on the key check is invalid', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json({ error: { message: 'forbidden' } }, 403)));
    const { keyService } = build(fetchMock as never);
    expect(await keyService.set(FAKE_KEY, 'local')).toMatchObject({
      ok: true,
      data: { verification: 'invalid' },
    });
  });
});

describe('a key change during readiness evaluation cancels the request (LOW-3)', () => {
  /** A settings store whose first read waits for `release`, to hold AI_EXPLAIN mid-readiness. */
  function heldSettings(h: Harness) {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const reads = vi.fn();
    const settings = {
      ...h.settingsStore,
      getPreferences: () => {
        reads();
        return gate.then(() => h.settingsStore.getPreferences());
      },
    };
    const ai = createAiHandlers({
      settings,
      keys: h.keyStore,
      keyService: h.keyService,
      provider: h.provider,
      guard: h.guard,
      lockedDown: () => Promise.resolve(true),
    });
    return { ai, release, reads };
  }
  const context = { sender: { kind: 'content' as const, tabId: 1 } };

  it('REMOVE_API_KEY after the key was read but before the provider call: provider never called', async () => {
    const h = createHarness();
    await makeReady(h);
    const { ai, release, reads } = heldSettings(h);
    const pending = ai.explain(explainMessage().payload as never, context);
    // The key has been read by now; evaluate() is waiting on preferences.
    await vi.waitFor(() => expect(reads).toHaveBeenCalled());
    await h.keyService.remove();
    release();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
    expect(h.provider.explain).not.toHaveBeenCalled();
  });

  it('replacing the key (SET_API_KEY) cancels it too', async () => {
    const h = createHarness();
    await makeReady(h);
    const { ai, release, reads } = heldSettings(h);
    const pending = ai.explain(explainMessage().payload as never, context);
    await vi.waitFor(() => expect(reads).toHaveBeenCalled());
    await h.keyService.set('gsk_TESTreplacement0000000000000000', 'local');
    release();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
    expect(h.provider.explain).not.toHaveBeenCalled();
  });

  it('CLEAR_ALL_DATA cancels it too', async () => {
    const h = createHarness();
    await makeReady(h);
    const { ai, release, reads } = heldSettings(h);
    const pending = ai.explain(explainMessage().payload as never, context);
    await vi.waitFor(() => expect(reads).toHaveBeenCalled());
    await h.call(KEY_MESSAGES['CLEAR_ALL_DATA'], options);
    release();
    expect(await pending).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
    expect(h.provider.explain).not.toHaveBeenCalled();
  });

  it('leaves no in-flight entry behind when readiness fails', async () => {
    const h = createHarness();
    await h.call(explainMessage(), contentSender());
    expect(h.guard.inFlight.size).toBe(0);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { keyStatusSchema, messageReplySchema } from '../../../lib/contracts';
import { toModelInfos } from '../../../lib/router/handlers/key';
import { STORAGE_KEYS } from '../../../lib/storage';
import { FAKE_KEY, KEY_MESSAGES, MODELS, createHarness, failWith, pageSender } from './harness';

const keyReply = messageReplySchema(keyStatusSchema);
const options = pageSender('/options.html');
const setKey = (storage: 'local' | 'session' = 'local', apiKey = FAKE_KEY) => ({
  v: 1,
  type: 'SET_API_KEY',
  apiKey,
  storage,
});

async function status(h: ReturnType<typeof createHarness>) {
  const reply = keyReply.parse(await h.call(KEY_MESSAGES['GET_KEY_STATUS'], options));
  if (!reply.ok) throw new Error('status failed');
  return reply.data;
}

describe('SET_API_KEY', () => {
  it('stores the key and immediately checks it with the model list (valid)', async () => {
    const h = createHarness({ now: () => 1234 });
    const reply = keyReply.parse(await h.call(setKey('local'), options));
    expect(reply).toEqual({
      ok: true,
      data: {
        hasKey: true,
        storage: 'local',
        last4: '1234',
        verification: 'valid',
        verifiedAt: 1234,
        models: [
          { id: 'openai/gpt-oss-120b', supportsJsonSchema: true },
          { id: 'openai/gpt-oss-20b', supportsJsonSchema: true },
        ],
      },
    });
    expect(h.provider.listModels).toHaveBeenCalledTimes(1);
    expect(h.provider.listModels).toHaveBeenCalledWith(FAKE_KEY);
  });

  it('401/403 from Groq: stored but marked invalid, verification cleared (FR-072)', async () => {
    const h = createHarness();
    h.provider.listModels.mockRejectedValue(failWith('INVALID_API_KEY', 401));
    const reply = keyReply.parse(await h.call(setKey('local'), options));
    expect(reply).toMatchObject({
      ok: true,
      data: { hasKey: true, verification: 'invalid', verifiedAt: null, models: [] },
    });
    // The key is kept so the user can see "invalid", fix or replace it.
    expect((await status(h)).hasKey).toBe(true);
  });

  it.each([
    ['network error', failWith('NETWORK_ERROR')],
    ['timeout', failWith('TIMEOUT')],
    ['rate limit', failWith('RATE_LIMITED', 429)],
    ['bad response', failWith('INVALID_RESPONSE')],
    ['unexpected error', new TypeError('boom')],
  ])('%s: "connection not verified", NOT invalid (architecture §6)', async (_name, error) => {
    const h = createHarness();
    h.provider.listModels.mockRejectedValue(error);
    const reply = keyReply.parse(await h.call(setKey('local'), options));
    expect(reply).toMatchObject({ ok: true, data: { hasKey: true, verification: 'unverified' } });
  });

  it('local keys live in storage.local only; session keys in storage.session only', async () => {
    const h = createHarness();
    await h.call(setKey('local'), options);
    expect(h.local.data.has(STORAGE_KEYS.apiKey)).toBe(true);
    expect(h.session.data.has(STORAGE_KEYS.apiKey)).toBe(false);

    await h.call(setKey('session', 'gsk_TESTsessionkey0000000000000009876'), options);
    expect(h.local.data.has(STORAGE_KEYS.apiKey)).toBe(false);
    expect(h.session.data.has(STORAGE_KEYS.apiKey)).toBe(true);
    expect((await status(h)).storage).toBe('session');
    expect((await status(h)).last4).toBe('9876');
  });

  it('replacing the key resets the previous verification before checking again', async () => {
    const h = createHarness();
    await h.call(setKey('local'), options);
    h.provider.listModels.mockRejectedValue(failWith('NETWORK_ERROR'));
    const reply = keyReply.parse(
      await h.call(setKey('local', 'gsk_TESTnewkey00000000000000000005555'), options),
    );
    expect(reply).toMatchObject({
      data: { verification: 'unverified', verifiedAt: null, models: [], last4: '5555' },
    });
  });

  it('never returns, logs or echoes the key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const h = createHarness();
    const replies = [
      await h.call(setKey('local'), options),
      await h.call(KEY_MESSAGES['GET_KEY_STATUS'], options),
      await h.call(KEY_MESSAGES['TEST_API_KEY'], options),
    ];
    for (const reply of replies) expect(JSON.stringify(reply)).not.toContain(FAKE_KEY);
    h.provider.listModels.mockRejectedValue(new Error(`leak ${FAKE_KEY}`));
    expect(JSON.stringify(await h.call(KEY_MESSAGES['TEST_API_KEY'], options))).not.toContain(
      FAKE_KEY,
    );
    expect(JSON.stringify([...warn.mock.calls, ...error.mock.calls])).not.toContain('gsk_TEST');
  });
});

describe('TEST_API_KEY', () => {
  it('SETUP_REQUIRED when there is no key', async () => {
    const h = createHarness();
    expect(await h.call(KEY_MESSAGES['TEST_API_KEY'], options)).toMatchObject({
      ok: false,
      error: { code: 'SETUP_REQUIRED' },
    });
    expect(h.provider.listModels).not.toHaveBeenCalled();
  });

  it('re-checks the stored key and updates status and models', async () => {
    const h = createHarness({ now: () => 50 });
    h.provider.listModels.mockRejectedValueOnce(failWith('NETWORK_ERROR'));
    await h.call(setKey('local'), options);
    expect((await status(h)).verification).toBe('unverified');
    const reply = keyReply.parse(await h.call(KEY_MESSAGES['TEST_API_KEY'], options));
    expect(reply).toMatchObject({ ok: true, data: { verification: 'valid', verifiedAt: 50 } });
  });

  it('a revoked key flips from valid to invalid and clears the models, keeping the settings', async () => {
    const h = createHarness();
    await h.call(setKey('local'), options);
    await h.call(
      { v: 1, type: 'UPDATE_PREFERENCES', patch: { explanationLanguage: 'fr' } },
      options,
    );
    h.provider.listModels.mockRejectedValue(failWith('INVALID_API_KEY', 403));
    const reply = keyReply.parse(await h.call(KEY_MESSAGES['TEST_API_KEY'], options));
    expect(reply).toMatchObject({
      data: { verification: 'invalid', verifiedAt: null, models: [] },
    });
    expect(await h.settingsStore.getPreferences()).toMatchObject({ explanationLanguage: 'fr' });
  });

  it('discards a check that finished after the key was replaced', async () => {
    const h = createHarness();
    await h.call(setKey('local'), options);
    let release: (models: typeof MODELS) => void = () => undefined;
    h.provider.listModels.mockImplementationOnce(
      () => new Promise((resolve) => (release = resolve)),
    );
    const slow = h.call(KEY_MESSAGES['TEST_API_KEY'], options);
    await h.call(setKey('local', 'gsk_TESTreplaced0000000000000000008888'), options);
    release(MODELS);
    const result = keyReply.parse(await slow);
    // The slow check belonged to the OLD key: it must not mark the new one verified.
    expect(result).toMatchObject({ ok: true, data: { last4: '8888' } });
    expect((await status(h)).last4).toBe('8888');
    expect(h.provider.listModels).toHaveBeenLastCalledWith(
      'gsk_TESTreplaced0000000000000000008888',
    );
  });
});

describe('REMOVE_API_KEY (FR-007)', () => {
  it('clears both areas, metadata and aborts in-flight requests', async () => {
    const h = createHarness();
    await h.call(setKey('local'), options);
    h.session.data.set(STORAGE_KEYS.apiKey, { v: 1, data: { key: 'stale' } });
    const inflight = h.guard.inFlight.begin('tab:1', 'r1');
    const reply = keyReply.parse(await h.call(KEY_MESSAGES['REMOVE_API_KEY'], options));
    expect(reply).toEqual({
      ok: true,
      data: {
        hasKey: false,
        storage: null,
        last4: null,
        verification: 'never',
        verifiedAt: null,
        models: [],
      },
    });
    expect(h.local.keys()).toEqual([]);
    expect(h.session.keys()).toEqual([]);
    expect(inflight.signal.aborted).toBe(true);
  });

  it('keeps preferences and onboarding when only the key is removed', async () => {
    const h = createHarness();
    await h.call(setKey('local'), options);
    await h.call({ v: 1, type: 'UPDATE_PREFERENCES', patch: { readingLevel: 'simple' } }, options);
    await h.call(KEY_MESSAGES['REMOVE_API_KEY'], options);
    expect(h.local.keys()).toEqual([STORAGE_KEYS.preferences]);
  });

  it('is idempotent', async () => {
    const h = createHarness();
    for (let i = 0; i < 2; i++) {
      expect(await h.call(KEY_MESSAGES['REMOVE_API_KEY'], options)).toMatchObject({ ok: true });
    }
  });
});

describe('fail closed when the storage lockdown did not succeed', () => {
  it('SET, TEST and GET_KEY_STATUS reply STORAGE_UNAVAILABLE and touch no storage', async () => {
    const h = createHarness({ lockedDown: false });
    for (const message of [
      setKey('local'),
      KEY_MESSAGES['TEST_API_KEY'],
      KEY_MESSAGES['GET_KEY_STATUS'],
    ]) {
      expect(await h.call(message, options)).toMatchObject({
        ok: false,
        error: { code: 'STORAGE_UNAVAILABLE' },
      });
    }
    expect(h.local.keys()).toEqual([]);
    expect(h.session.keys()).toEqual([]);
    expect(h.local.get).not.toHaveBeenCalled();
    expect(h.session.get).not.toHaveBeenCalled();
    expect(h.provider.listModels).not.toHaveBeenCalled();
  });

  it('a storage area that rejects also replies STORAGE_UNAVAILABLE', async () => {
    const h = createHarness();
    h.local.failWith = new Error('disk full');
    expect(await h.call(setKey('local'), options)).toMatchObject({
      ok: false,
      error: { code: 'STORAGE_UNAVAILABLE' },
    });
  });
});

describe('toModelInfos (FR-005)', () => {
  it('offers only active, text-capable, unique models, sorted, with the JSON-schema flag', () => {
    expect(
      toModelInfos([
        ...MODELS,
        { id: 'openai/gpt-oss-20b', supportsJsonSchema: true },
        { id: 'old/model', supportsJsonSchema: false, active: false },
        { id: 'playai-tts', supportsJsonSchema: false },
        { id: 'x'.repeat(200), supportsJsonSchema: false },
      ]),
    ).toEqual([
      { id: 'openai/gpt-oss-120b', supportsJsonSchema: true },
      { id: 'openai/gpt-oss-20b', supportsJsonSchema: true },
    ]);
  });

  it('caps the list at the contract bound', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({
      id: `m-${String(i).padStart(3, '0')}`,
      supportsJsonSchema: false,
    }));
    expect(toModelInfos(many)).toHaveLength(200);
  });
});

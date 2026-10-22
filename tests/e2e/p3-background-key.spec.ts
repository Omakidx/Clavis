import { expect, test } from './fixtures';
import {
  FAKE_KEY,
  OTHER_FAKE_KEY,
  clavisKeys,
  mockGroq,
  openExtensionPage,
  readStorage,
  restartWorker,
  send,
  type GroqMode,
} from './p3-support/background';

// Phase 3: the Groq key lifecycle in the BUILT extension. The service worker's calls to
// Groq are answered by the test (no real key exists); everything else is the real code.

const setKey = (storage: 'local' | 'session', apiKey = FAKE_KEY) => ({
  v: 1,
  type: 'SET_API_KEY',
  apiKey,
  storage,
});

test.describe('key lifecycle', () => {
  test('a persistent key lives in storage.local, survives a worker restart, and is reported as last4 only', async ({
    context,
    serviceWorker,
    extensionId,
  }) => {
    const groq: { current: GroqMode } = { current: 401 };
    await mockGroq(context, groq);
    const options = await openExtensionPage(context, extensionId, 'options');

    const set = await send(options, setKey('local'));
    // Groq answered 401: the key is kept, flagged invalid (FR-072), models cleared.
    expect(set).toMatchObject({
      ok: true,
      data: { hasKey: true, storage: 'local', last4: 'AbCd', verification: 'invalid', models: [] },
    });
    expect(JSON.stringify(set)).not.toContain(FAKE_KEY);

    expect(await clavisKeys(serviceWorker, 'local')).toEqual(['clavis.api-key', 'clavis.key-meta']);
    expect(await clavisKeys(serviceWorker, 'session')).toEqual([]);
    expect(JSON.stringify(await readStorage(serviceWorker, 'local'))).toContain(FAKE_KEY);

    await serviceWorker.evaluate(() => {
      (globalThis as { __beforeRestart?: boolean }).__beforeRestart = true;
    });
    const restarted = await restartWorker(context, options);
    // A genuinely new worker: its globals are gone, its storage is not.
    expect(
      await restarted.evaluate(() => (globalThis as { __beforeRestart?: boolean }).__beforeRestart),
    ).toBeUndefined();
    const status = await send(options, { v: 1, type: 'GET_KEY_STATUS' });
    expect(status).toMatchObject({
      ok: true,
      data: { hasKey: true, storage: 'local', last4: 'AbCd' },
    });
    expect(JSON.stringify(status)).not.toContain(FAKE_KEY);
    expect(await clavisKeys(restarted, 'local')).toEqual(['clavis.api-key', 'clavis.key-meta']);
  });

  test('a session-only key lives in storage.session, never in storage.local', async ({
    context,
    serviceWorker,
    extensionId,
  }) => {
    await mockGroq(context, { current: 'offline' });
    const options = await openExtensionPage(context, extensionId, 'options');
    // No network: "connection not verified", NOT "invalid key" (architecture §6).
    expect(await send(options, setKey('session'))).toMatchObject({
      ok: true,
      data: { hasKey: true, storage: 'session', verification: 'unverified' },
    });
    expect(await clavisKeys(serviceWorker, 'session')).toEqual([
      'clavis.api-key',
      'clavis.key-meta',
    ]);
    expect(await clavisKeys(serviceWorker, 'local')).toEqual([]);
    expect(JSON.stringify(await readStorage(serviceWorker, 'local'))).not.toContain(FAKE_KEY);
    expect(JSON.stringify(await readStorage(serviceWorker, 'local'))).not.toContain('AbCd');

    // Session storage outlives a worker restart (only closing the browser clears it).
    const restarted = await restartWorker(context, options);
    expect(await send(options, { v: 1, type: 'GET_KEY_STATUS' })).toMatchObject({
      ok: true,
      data: { hasKey: true, storage: 'session' },
    });
    expect(await clavisKeys(restarted, 'session')).toEqual(['clavis.api-key', 'clavis.key-meta']);
  });

  test('switching storage moves the key: never in both areas', async ({
    context,
    serviceWorker,
    extensionId,
  }) => {
    await mockGroq(context, { current: 'ok' });
    const options = await openExtensionPage(context, extensionId, 'options');
    await send(options, setKey('local'));
    await send(options, setKey('session', OTHER_FAKE_KEY));
    expect(await clavisKeys(serviceWorker, 'local')).toEqual([]);
    expect(await clavisKeys(serviceWorker, 'session')).toEqual([
      'clavis.api-key',
      'clavis.key-meta',
    ]);
    await send(options, setKey('local'));
    expect(await clavisKeys(serviceWorker, 'session')).toEqual([]);
    expect(await clavisKeys(serviceWorker, 'local')).toEqual(['clavis.api-key', 'clavis.key-meta']);
  });

  test('a valid key reports the usable models; TEST_API_KEY re-checks; 401 flips it to invalid', async ({
    context,
    extensionId,
  }) => {
    const groq: { current: GroqMode } = { current: 'ok' };
    const seen = await mockGroq(context, groq);
    const options = await openExtensionPage(context, extensionId, 'options');

    const set = await send(options, setKey('local'));
    expect(set).toMatchObject({ ok: true, data: { verification: 'valid' } });
    // Chat-capable models only: the speech model is filtered out (FR-005).
    expect(set?.data?.models).toEqual([
      { id: 'openai/gpt-oss-120b', supportsJsonSchema: true },
      { id: 'openai/gpt-oss-20b', supportsJsonSchema: true },
    ]);
    expect(seen.every((url) => url === 'https://api.groq.com/openai/v1/models')).toBe(true);

    groq.current = 401;
    expect(await send(options, { v: 1, type: 'TEST_API_KEY' })).toMatchObject({
      ok: true,
      data: { hasKey: true, verification: 'invalid', models: [] },
    });
    // The extension reports readiness honestly to any context.
    expect(await send(options, { v: 1, type: 'GET_AI_STATUS' })).toMatchObject({
      ok: true,
      data: { state: 'disclosure_required' },
    });
    await send(options, { v: 1, type: 'ACCEPT_DISCLOSURE' });
    expect(await send(options, { v: 1, type: 'GET_AI_STATUS' })).toMatchObject({
      data: { state: 'invalid_key' },
    });

    groq.current = 'offline';
    expect(await send(options, { v: 1, type: 'TEST_API_KEY' })).toMatchObject({
      data: { verification: 'unverified' },
    });
  });

  test('REMOVE_API_KEY clears both areas and the status; AI then asks for setup', async ({
    context,
    serviceWorker,
    extensionId,
  }) => {
    await mockGroq(context, { current: 'ok' });
    const options = await openExtensionPage(context, extensionId, 'options');
    await send(options, setKey('local'));
    await send(options, { v: 1, type: 'ACCEPT_DISCLOSURE' });
    expect(await send(options, { v: 1, type: 'GET_AI_STATUS' })).toMatchObject({
      data: { state: 'ready' },
    });

    expect(await send(options, { v: 1, type: 'REMOVE_API_KEY' })).toMatchObject({
      ok: true,
      data: { hasKey: false, storage: null, last4: null, verification: 'never', models: [] },
    });
    // Only the key and its metadata go; the disclosure acknowledgement stays.
    expect(await clavisKeys(serviceWorker, 'local')).toEqual(['clavis.onboarding']);
    expect(await clavisKeys(serviceWorker, 'session')).toEqual([]);
    expect(await send(options, { v: 1, type: 'GET_AI_STATUS' })).toMatchObject({
      data: { state: 'setup_required' },
    });
    expect(
      await send(options, {
        v: 1,
        type: 'AI_EXPLAIN',
        payload: {
          requestId: crypto.randomUUID(),
          snapshot: {
            selectionId: crypto.randomUUID(),
            source: 'webpage',
            kind: 'word',
            text: 'bank',
          },
          mode: 'core',
          detailLevel: 'standard',
        },
      }),
    ).toMatchObject({ ok: false, error: { code: 'SETUP_REQUIRED' } });
  });

  test('GET_PUBLIC_SETTINGS exposes hasKey and non-secret settings, nothing key-related', async ({
    context,
    extensionId,
  }) => {
    await mockGroq(context, { current: 'ok' });
    const options = await openExtensionPage(context, extensionId, 'options');
    await send(options, setKey('session'));
    const reply = await send(options, { v: 1, type: 'GET_PUBLIC_SETTINGS' });
    expect(reply).toEqual({
      ok: true,
      data: {
        hasKey: true,
        disclosureAccepted: false,
        explanationLanguage: 'en',
        readingLevel: 'standard',
        tooltipBehavior: 'automatic',
        ttsRate: 1,
      },
    });
    const text = JSON.stringify(reply);
    for (const secret of [FAKE_KEY, 'AbCd', 'gsk_', 'session', 'local', 'verification']) {
      expect(text).not.toContain(secret);
    }
  });
});

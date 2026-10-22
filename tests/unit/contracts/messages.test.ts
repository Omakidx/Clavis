import { z } from 'zod';
import {
  errorEnvelopeSchema,
  messageReplySchema,
  parsePrivilegedMessage,
  parsePublicMessage,
  privilegedMessageSchema,
  publicMessageSchema,
  publicSettingsSchema,
} from '../../../lib/contracts';
import { UUID_A, UUID_B, explainRequest } from './fixtures';

const base = { v: 1 };
const publicMessages = {
  AI_EXPLAIN: { ...base, type: 'AI_EXPLAIN', payload: explainRequest() },
  AI_CANCEL: { ...base, type: 'AI_CANCEL', requestId: UUID_B },
  TTS_SPEAK: {
    ...base,
    type: 'TTS_SPEAK',
    requestId: UUID_B,
    text: 'hello',
    lang: 'en-US',
    rate: 1,
  },
  TTS_STOP: { ...base, type: 'TTS_STOP' },
  GET_PUBLIC_SETTINGS: { ...base, type: 'GET_PUBLIC_SETTINGS' },
  GET_AI_STATUS: { ...base, type: 'GET_AI_STATUS' },
};
const privilegedMessages = {
  SET_API_KEY: { ...base, type: 'SET_API_KEY', apiKey: 'gsk_abc123', storage: 'session' },
  TEST_API_KEY: { ...base, type: 'TEST_API_KEY' },
  REMOVE_API_KEY: { ...base, type: 'REMOVE_API_KEY' },
};

describe('publicMessageSchema / parsePublicMessage', () => {
  it.each(Object.entries(publicMessages))('accepts %s', (_type, message) => {
    const result = parsePublicMessage(message);
    expect(result.ok).toBe(true);
    expect(publicMessageSchema.safeParse(message).success).toBe(true);
  });

  it('accepts TTS_STOP with an optional requestId', () => {
    expect(parsePublicMessage({ ...publicMessages.TTS_STOP, requestId: UUID_A }).ok).toBe(true);
    expect(parsePublicMessage({ ...publicMessages.TTS_STOP, requestId: 'x' }).ok).toBe(false);
  });

  it.each(Object.entries(privilegedMessages))('rejects privileged message %s', (_type, message) => {
    const result = parsePublicMessage(message);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('invalid');
  });

  it.each([0, 2, '1', undefined])('rejects wrong or missing version %j', (version) => {
    const message = { ...publicMessages.GET_AI_STATUS, v: version };
    expect(parsePublicMessage(message).ok).toBe(false);
  });

  it('rejects unknown types, unknown keys and non-object input without throwing', () => {
    expect(parsePublicMessage({ ...base, type: 'GET_API_KEY' }).ok).toBe(false);
    expect(parsePublicMessage({ ...publicMessages.GET_AI_STATUS, apiKey: 'x' }).ok).toBe(false);
    for (const input of [null, undefined, 'str', 7, [], () => 1]) {
      expect(() => parsePublicMessage(input)).not.toThrow();
      expect(parsePublicMessage(input).ok).toBe(false);
    }
  });

  it('rejects TTS_SPEAK with over-limit text, out-of-bounds rate or empty text', () => {
    const speak = publicMessages.TTS_SPEAK;
    expect(parsePublicMessage({ ...speak, text: 'a'.repeat(2001) }).ok).toBe(false);
    expect(parsePublicMessage({ ...speak, text: '   ' }).ok).toBe(false);
    expect(parsePublicMessage({ ...speak, rate: 0.1 }).ok).toBe(false);
    expect(parsePublicMessage({ ...speak, rate: 3 }).ok).toBe(false);
    expect(parsePublicMessage({ ...speak, rate: 0.75 }).ok).toBe(true);
    expect(parsePublicMessage({ ...speak, text: 'a'.repeat(2000) }).ok).toBe(true);
  });

  it('rejects AI_EXPLAIN carrying an invalid nested payload', () => {
    const message = {
      ...base,
      type: 'AI_EXPLAIN',
      payload: explainRequest({ mode: 'translate' }),
    };
    expect(parsePublicMessage(message).ok).toBe(false);
  });

  it('rejects messages over the byte cap before schema parsing', () => {
    const result = parsePublicMessage({
      ...publicMessages.GET_AI_STATUS,
      junk: 'x'.repeat(40_000),
    });
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
  });

  it('rejects unserializable input (cycles, bigint) without throwing', () => {
    const cyclic: Record<string, unknown> = { ...publicMessages.GET_AI_STATUS };
    cyclic.self = cyclic;
    expect(parsePublicMessage(cyclic)).toMatchObject({ ok: false, reason: 'unserializable' });
    expect(parsePublicMessage({ ...base, n: 10n })).toMatchObject({
      ok: false,
      reason: 'unserializable',
    });
    expect(parsePublicMessage(() => 1)).toMatchObject({ ok: false, reason: 'unserializable' });
  });

  it('reports issue paths and codes only, never input values', () => {
    const secret = 'gsk_SUPERSECRET';
    const result = parsePublicMessage({ ...base, type: 'TTS_STOP', requestId: secret });
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(secret);
    if (!result.ok) expect(result.issues[0]).toEqual({ path: 'requestId', code: 'invalid_format' });
  });

  it('returns parsed (trimmed) data on success', () => {
    const result = parsePublicMessage({ ...publicMessages.TTS_SPEAK, text: '  hi  ' });
    expect(result.ok && result.message.type === 'TTS_SPEAK' && result.message.text).toBe('hi');
  });
});

describe('privilegedMessageSchema / parsePrivilegedMessage', () => {
  it.each(Object.entries(privilegedMessages))('accepts %s', (_type, message) => {
    expect(parsePrivilegedMessage(message).ok).toBe(true);
    expect(privilegedMessageSchema.safeParse(message).success).toBe(true);
  });

  it.each(Object.entries(publicMessages))('does not accept public message %s', (_type, message) => {
    expect(parsePrivilegedMessage(message).ok).toBe(false);
  });

  it('rejects bad storage, empty/whitespace/oversize keys and unknown keys', () => {
    const set = privilegedMessages.SET_API_KEY;
    expect(parsePrivilegedMessage({ ...set, storage: 'sync' }).ok).toBe(false);
    expect(parsePrivilegedMessage({ ...set, apiKey: '' }).ok).toBe(false);
    expect(parsePrivilegedMessage({ ...set, apiKey: 'gsk abc' }).ok).toBe(false);
    expect(parsePrivilegedMessage({ ...set, apiKey: 'k'.repeat(513) }).ok).toBe(false);
    expect(parsePrivilegedMessage({ ...set, extra: 1 }).ok).toBe(false);
    expect(parsePrivilegedMessage({ ...set, v: 2 }).ok).toBe(false);
    expect(parsePrivilegedMessage({ ...privilegedMessages.TEST_API_KEY, apiKey: 'x' }).ok).toBe(
      false,
    );
  });

  it('does not echo a rejected key in the issue list', () => {
    const result = parsePrivilegedMessage({
      ...privilegedMessages.SET_API_KEY,
      apiKey: 'gsk bad key',
      storage: 'x',
    });
    expect(JSON.stringify(result)).not.toContain('gsk bad key');
  });

  it('keeps privileged types out of the public union', () => {
    const publicTypes = publicMessageSchema.options.map((o) => o.shape.type.value);
    expect(publicTypes).not.toContain('SET_API_KEY');
    expect(publicTypes).not.toContain('TEST_API_KEY');
    expect(publicTypes).not.toContain('REMOVE_API_KEY');
  });
});

describe('messageReplySchema', () => {
  const schema = messageReplySchema(publicSettingsSchema);
  const settings = {
    hasKey: false,
    disclosureAccepted: false,
    explanationLanguage: 'en',
    readingLevel: 'standard',
    tooltipBehavior: 'automatic',
    ttsRate: 1,
  };

  it('accepts ok and error replies', () => {
    expect(schema.safeParse({ ok: true, data: settings }).success).toBe(true);
    expect(schema.safeParse({ ok: true, requestId: UUID_A, data: settings }).success).toBe(true);
    expect(
      schema.safeParse({
        ok: false,
        requestId: UUID_A,
        error: { code: 'SETUP_REQUIRED', message: 'Add a key' },
      }).success,
    ).toBe(true);
  });

  it('validates the data payload and the error envelope', () => {
    expect(schema.safeParse({ ok: true, data: { ...settings, apiKey: 'x' } }).success).toBe(false);
    expect(schema.safeParse({ ok: false, error: { code: 'NOPE', message: 'x' } }).success).toBe(
      false,
    );
    expect(
      schema.safeParse({ ok: true, data: settings, error: { code: 'TIMEOUT', message: 'x' } })
        .success,
    ).toBe(false);
  });

  it('works with arbitrary data schemas and reuses the error envelope schema', () => {
    const boolReply = messageReplySchema(z.boolean());
    expect(boolReply.safeParse({ ok: true, data: true }).success).toBe(true);
    expect(boolReply.safeParse({ ok: true, data: 'true' }).success).toBe(false);
    expect(errorEnvelopeSchema.safeParse({ code: 'TIMEOUT', message: 'x' }).success).toBe(true);
  });
});

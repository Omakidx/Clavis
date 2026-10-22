import {
  ERROR_CODES,
  errorCodeSchema,
  errorEnvelopeSchema,
  publicSettingsSchema,
} from '../../../lib/contracts';

describe('errorCodeSchema / errorEnvelopeSchema', () => {
  it('contains the architecture §4 codes including SELECTION_TOO_LONG', () => {
    expect(ERROR_CODES).toHaveLength(13);
    for (const code of ERROR_CODES) expect(errorCodeSchema.safeParse(code).success).toBe(true);
    expect(errorCodeSchema.safeParse('SELECTION_TOO_LONG').success).toBe(true);
    expect(errorCodeSchema.safeParse('UNKNOWN').success).toBe(false);
  });

  it('accepts an envelope with and without retryAfterMs', () => {
    expect(
      errorEnvelopeSchema.safeParse({
        code: 'RATE_LIMITED',
        message: 'Slow down',
        retryAfterMs: 2000,
      }).success,
    ).toBe(true);
    expect(errorEnvelopeSchema.safeParse({ code: 'TIMEOUT', message: 'Timed out' }).success).toBe(
      true,
    );
  });

  it('rejects negative/fractional retry, over-long message and unknown keys', () => {
    expect(
      errorEnvelopeSchema.safeParse({ code: 'TIMEOUT', message: 'x', retryAfterMs: -1 }).success,
    ).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse({ code: 'TIMEOUT', message: 'x', retryAfterMs: 1.5 }).success,
    ).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse({ code: 'TIMEOUT', message: 'x'.repeat(501) }).success,
    ).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse({ code: 'TIMEOUT', message: 'x', headers: {} }).success,
    ).toBe(false);
  });
});

describe('publicSettingsSchema', () => {
  const settings = {
    hasKey: true,
    model: 'openai/gpt-oss-20b',
    explanationLanguage: 'en',
    ttsRate: 0.75,
  };

  it('accepts valid settings with and without ttsLang', () => {
    expect(publicSettingsSchema.safeParse(settings).success).toBe(true);
    expect(publicSettingsSchema.safeParse({ ...settings, ttsLang: 'en-GB' }).success).toBe(true);
  });

  it('rejects any field that could carry the key', () => {
    for (const key of ['apiKey', 'key', 'keySuffix', 'last4', 'storage', 'authorization']) {
      expect(publicSettingsSchema.safeParse({ ...settings, [key]: 'gsk_secret' }).success).toBe(
        false,
      );
    }
  });

  it('declares no key-carrying field in its shape', () => {
    expect(Object.keys(publicSettingsSchema.shape).sort()).toEqual([
      'explanationLanguage',
      'hasKey',
      'model',
      'ttsLang',
      'ttsRate',
    ]);
  });

  it('requires a boolean hasKey and an in-bounds rate', () => {
    expect(publicSettingsSchema.safeParse({ ...settings, hasKey: 'yes' }).success).toBe(false);
    expect(publicSettingsSchema.safeParse({ ...settings, ttsRate: 0.1 }).success).toBe(false);
    expect(publicSettingsSchema.safeParse({ ...settings, ttsRate: 5 }).success).toBe(false);
  });
});

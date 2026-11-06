import {
  ERROR_CODES,
  errorCodeSchema,
  errorEnvelopeSchema,
  publicSettingsSchema,
} from '../../../lib/contracts';

describe('errorCodeSchema / errorEnvelopeSchema', () => {
  it('contains the architecture §4 codes plus the Phase 3 INVALID_REQUEST, STORAGE_UNAVAILABLE and INTERNAL_ERROR', () => {
    expect(ERROR_CODES).toHaveLength(16);
    for (const code of ERROR_CODES) expect(errorCodeSchema.safeParse(code).success).toBe(true);
    expect(errorCodeSchema.safeParse('SELECTION_TOO_LONG').success).toBe(true);
    expect(errorCodeSchema.safeParse('INVALID_REQUEST').success).toBe(true);
    expect(errorCodeSchema.safeParse('STORAGE_UNAVAILABLE').success).toBe(true);
    expect(errorCodeSchema.safeParse('INTERNAL_ERROR').success).toBe(true);
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

  it('accepts only bounded HTTP status and a fixed forbidden reason', () => {
    const base = { code: 'NETWORK_ERROR', message: 'Fixed' };
    expect(
      errorEnvelopeSchema.safeParse({ ...base, httpStatus: 403, forbiddenReason: 'edge_block' })
        .success,
    ).toBe(true);
    expect(errorEnvelopeSchema.safeParse({ ...base, httpStatus: 500 }).success).toBe(true);
    for (const httpStatus of [99, 600, 403.5, '403']) {
      expect(errorEnvelopeSchema.safeParse({ ...base, httpStatus }).success).toBe(false);
    }
    expect(
      errorEnvelopeSchema.safeParse({
        ...base,
        httpStatus: 403,
        forbiddenReason: 'arbitrary_provider_code',
      }).success,
    ).toBe(false);
    expect(
      errorEnvelopeSchema.safeParse({ ...base, httpStatus: 403, providerMessage: 'secret' })
        .success,
    ).toBe(false);
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
    disclosureAccepted: true,
    model: 'openai/gpt-oss-20b',
    explanationLanguage: 'en',
    readingLevel: 'standard',
    tooltipBehavior: 'automatic',
    ttsRate: 0.75,
  };

  it('accepts valid settings with and without ttsLang and model', () => {
    expect(publicSettingsSchema.safeParse(settings).success).toBe(true);
    const { model: _model, ...withoutModel } = settings;
    expect(publicSettingsSchema.safeParse(withoutModel).success).toBe(true);
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
      'disclosureAccepted',
      'explanationLanguage',
      'hasKey',
      'model',
      'readingLevel',
      'tooltipBehavior',
      'translationLanguage',
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

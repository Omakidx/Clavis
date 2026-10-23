import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ONBOARDING,
  DEFAULT_PREFERENCES,
  KEY_ROUTES,
  aiCancelResultSchema,
  aiStatusSchema,
  clearAllDataResultSchema,
  hostnameSchema,
  keyStatusSchema,
  keyStorageSchema,
  modelInfoSchema,
  onboardingStateSchema,
  parsePrivilegedMessage,
  parsePublicMessage,
  preferencesPatchSchema,
  preferencesSchema,
  privilegedMessageSchema,
  publicMessageSchema,
  settingsSnapshotSchema,
  siteAccessStatusSchema,
} from '../../../lib/contracts';

const base = { v: 1 };
const privileged = {
  SET_API_KEY: { ...base, type: 'SET_API_KEY', apiKey: 'gsk_TESTabc', storage: 'local' },
  TEST_API_KEY: { ...base, type: 'TEST_API_KEY' },
  REMOVE_API_KEY: { ...base, type: 'REMOVE_API_KEY' },
  GET_KEY_STATUS: { ...base, type: 'GET_KEY_STATUS' },
  GET_SETTINGS: { ...base, type: 'GET_SETTINGS' },
  UPDATE_PREFERENCES: { ...base, type: 'UPDATE_PREFERENCES', patch: { ttsRate: 1.5 } },
  RESET_PREFERENCES: { ...base, type: 'RESET_PREFERENCES' },
  ACCEPT_DISCLOSURE: { ...base, type: 'ACCEPT_DISCLOSURE' },
  UPDATE_ONBOARDING: { ...base, type: 'UPDATE_ONBOARDING', completed: true },
  GET_SITE_ACCESS_STATUS: { ...base, type: 'GET_SITE_ACCESS_STATUS' },
  GET_VOICES: { ...base, type: 'GET_VOICES' },
  CLEAR_ALL_DATA: { ...base, type: 'CLEAR_ALL_DATA' },
};

describe('privileged messages', () => {
  it.each(Object.entries(privileged))(
    'accepts %s on the privileged parser only',
    (_type, message) => {
      expect(parsePrivilegedMessage(message).ok).toBe(true);
      expect(parsePublicMessage(message).ok).toBe(false);
      expect(publicMessageSchema.safeParse(message).success).toBe(false);
    },
  );

  it('covers every privileged type, and KEY_ROUTES is a subset of them', () => {
    const types = privilegedMessageSchema.options.map((o) => o.shape.type.value).sort();
    expect(types).toEqual(Object.keys(privileged).sort());
    for (const route of KEY_ROUTES) expect(types).toContain(route);
    expect([...KEY_ROUTES].sort()).toEqual([
      'CLEAR_ALL_DATA',
      'GET_KEY_STATUS',
      'REMOVE_API_KEY',
      'SET_API_KEY',
      'TEST_API_KEY',
    ]);
  });

  it('rejects an empty UPDATE_ONBOARDING and a client-supplied disclosure time', () => {
    expect(parsePrivilegedMessage({ ...base, type: 'UPDATE_ONBOARDING' }).ok).toBe(false);
    expect(
      parsePrivilegedMessage({ ...base, type: 'UPDATE_ONBOARDING', disclosureAcceptedAt: 1 }).ok,
    ).toBe(false);
  });
});

describe('preferences', () => {
  it('defaults are valid and strict', () => {
    expect(preferencesSchema.safeParse(DEFAULT_PREFERENCES).success).toBe(true);
    expect(preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, extra: 1 }).success).toBe(false);
    expect(onboardingStateSchema.safeParse(DEFAULT_ONBOARDING).success).toBe(true);
  });

  it('patch: at least one field, null clears optional fields only', () => {
    expect(preferencesPatchSchema.safeParse({}).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ ttsLang: null, model: null }).success).toBe(true);
    expect(preferencesPatchSchema.safeParse({ ttsRate: null }).success).toBe(false);
    expect(preferencesPatchSchema.safeParse({ readingLevel: null }).success).toBe(false);
  });

  it.each(['example.com', 'a.b.example.co.uk', 'localhost', 'xn--bcher-kva.example', '127.0.0.1'])(
    'accepts hostname %s',
    (host) => expect(hostnameSchema.safeParse(host).success).toBe(true),
  );

  it.each([
    '',
    'Example.com',
    'a b.test',
    'https://a.test',
    'a.test/path',
    'a.test:8080',
    '*.a.test',
    '-a.test',
    'a..test',
  ])('rejects hostname %j', (host) => expect(hostnameSchema.safeParse(host).success).toBe(false));

  it('snapshot is strict', () => {
    const snapshot = { preferences: DEFAULT_PREFERENCES, onboarding: DEFAULT_ONBOARDING };
    expect(settingsSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(settingsSnapshotSchema.safeParse({ ...snapshot, apiKey: 'x' }).success).toBe(false);
  });
});

describe('key, AI and site-access status', () => {
  const status = {
    hasKey: true,
    storage: 'local',
    last4: '1234',
    verification: 'valid',
    verifiedAt: 1,
    models: [{ id: 'm', supportsJsonSchema: true }],
  };

  it('key status carries at most four characters and no secret field', () => {
    expect(keyStatusSchema.safeParse(status).success).toBe(true);
    expect(keyStatusSchema.safeParse({ ...status, last4: '12345' }).success).toBe(false);
    expect(keyStatusSchema.safeParse({ ...status, apiKey: 'gsk_x' }).success).toBe(false);
    expect(Object.keys(keyStatusSchema.shape).sort()).toEqual([
      'hasKey',
      'last4',
      'models',
      'storage',
      'verification',
      'verifiedAt',
    ]);
  });

  it('keeps the storage choice to local or session, never sync', () => {
    expect(keyStorageSchema.safeParse('sync').success).toBe(false);
    expect(modelInfoSchema.safeParse({ id: 'm', supportsJsonSchema: true, extra: 1 }).success).toBe(
      false,
    );
  });

  it('AI status states match the Phase 3 list', () => {
    for (const state of [
      'storage_unavailable',
      'setup_required',
      'disclosure_required',
      'invalid_key',
      'ready',
    ]) {
      expect(aiStatusSchema.safeParse({ state }).success).toBe(true);
    }
    expect(aiStatusSchema.safeParse({ state: 'maybe' }).success).toBe(false);
  });

  it('site access status and the small reply schemas are strict', () => {
    expect(
      siteAccessStatusSchema.safeParse({ granted: true, registered: false, choice: 'unset' })
        .success,
    ).toBe(true);
    expect(siteAccessStatusSchema.safeParse({ granted: true, registered: false }).success).toBe(
      false,
    );
    expect(aiCancelResultSchema.safeParse({ cancelled: true }).success).toBe(true);
    expect(clearAllDataResultSchema.safeParse({ cleared: true }).success).toBe(true);
    expect(clearAllDataResultSchema.safeParse({ cleared: false }).success).toBe(false);
  });
});

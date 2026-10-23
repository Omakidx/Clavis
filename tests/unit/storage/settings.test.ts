import { describe, expect, it } from 'vitest';
import { DEFAULT_ONBOARDING, DEFAULT_PREFERENCES } from '../../../lib/contracts';
import {
  STORAGE_KEYS,
  StorageUnavailableError,
  applyPreferencesPatch,
  createSettingsStore,
  parseOnboarding,
  parsePreferences,
  wrapRecord,
} from '../../../lib/storage';
import { MemoryArea } from './memory-area';

function setup(now = 1_700_000_000_000) {
  const area = new MemoryArea();
  const store = createSettingsStore({ area, now: () => now });
  return { area, store };
}

describe('parsePreferences (validate on read)', () => {
  it('returns defaults for missing, malformed or other-version records, never throwing', () => {
    for (const raw of [undefined, null, 'x', 42, [], {}, { v: 2, data: DEFAULT_PREFERENCES }]) {
      expect(parsePreferences(raw)).toEqual(DEFAULT_PREFERENCES);
    }
    expect(parsePreferences({ v: 1, data: 'nope' })).toEqual(DEFAULT_PREFERENCES);
  });

  it('returns a fresh object each time so callers cannot corrupt the defaults', () => {
    const a = parsePreferences(undefined);
    a.disabledSites.push('x.test');
    expect(parsePreferences(undefined).disabledSites).toEqual([]);
    expect(DEFAULT_PREFERENCES.disabledSites).toEqual([]);
  });

  it('repairs only the corrupt field and keeps the user other choices', () => {
    const corrupt = wrapRecord({
      explanationLanguage: 'fr',
      readingLevel: 'galaxy-brain',
      tooltipBehavior: 'on-demand',
      ttsRate: 99,
      disabledSites: ['ok.test', 'BAD HOST'],
      model: 'openai/gpt-oss-120b',
      unexpected: true,
    });
    expect(parsePreferences(corrupt)).toEqual({
      ...DEFAULT_PREFERENCES,
      explanationLanguage: 'fr',
      tooltipBehavior: 'on-demand',
      model: 'openai/gpt-oss-120b',
    });
  });

  it('accepts a valid record unchanged and de-duplicates the disabled sites', () => {
    const good = {
      ...DEFAULT_PREFERENCES,
      ttsLang: 'en-GB',
      disabledSites: ['a.test', 'b.test', 'a.test'],
    };
    expect(parsePreferences(wrapRecord(good))).toEqual({
      ...good,
      disabledSites: ['a.test', 'b.test'],
    });
  });
});

describe('parseOnboarding', () => {
  it('returns defaults when missing or corrupt, and repairs per field', () => {
    expect(parseOnboarding(undefined)).toEqual(DEFAULT_ONBOARDING);
    expect(parseOnboarding(wrapRecord({ completed: 'yes' }))).toEqual(DEFAULT_ONBOARDING);
    expect(
      parseOnboarding(
        wrapRecord({ completed: true, disclosureAcceptedAt: -5, siteAccessChoice: 'granted' }),
      ),
    ).toEqual({ completed: true, disclosureAcceptedAt: null, siteAccessChoice: 'granted' });
  });
});

describe('applyPreferencesPatch', () => {
  it('merges fields, and null clears an optional field', () => {
    const current = { ...DEFAULT_PREFERENCES, ttsLang: 'en-US', model: 'm' };
    expect(applyPreferencesPatch(current, { ttsRate: 0.75, ttsLang: null, model: null })).toEqual({
      ...DEFAULT_PREFERENCES,
      ttsRate: 0.75,
    });
  });
});

describe('ttsVoice preference (FR-025)', () => {
  it('is saved, read back, cleared by null and reset with the other preferences', async () => {
    const { store } = setup();
    expect((await store.updatePreferences({ ttsVoice: 'Google UK English Female' })).ttsVoice).toBe(
      'Google UK English Female',
    );
    expect((await store.getPreferences()).ttsVoice).toBe('Google UK English Female');
    expect('ttsVoice' in (await store.updatePreferences({ ttsVoice: null }))).toBe(false);
    await store.updatePreferences({ ttsVoice: 'Alex' });
    expect(await store.resetPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('a corrupt stored voice resets only itself', () => {
    const repaired = parsePreferences(
      wrapRecord({ ...DEFAULT_PREFERENCES, ttsRate: 1.5, ttsVoice: 'x'.repeat(500) }),
    );
    expect(repaired.ttsRate).toBe(1.5);
    expect('ttsVoice' in repaired).toBe(false);
  });
});

describe('settings store', () => {
  it('reads defaults from empty storage without writing anything', async () => {
    const { area, store } = setup();
    expect(await store.getSnapshot()).toEqual({
      preferences: DEFAULT_PREFERENCES,
      onboarding: DEFAULT_ONBOARDING,
    });
    expect(area.set).not.toHaveBeenCalled();
  });

  it('persists a validated patch under namespaced, versioned keys', async () => {
    const { area, store } = setup();
    const next = await store.updatePreferences({
      explanationLanguage: 'es',
      readingLevel: 'simple',
      disabledSites: ['a.test'],
    });
    expect(next).toMatchObject({ explanationLanguage: 'es', readingLevel: 'simple' });
    expect(area.keys()).toEqual([STORAGE_KEYS.preferences]);
    expect(area.data.get(STORAGE_KEYS.preferences)).toMatchObject({ v: 1 });
    expect((await store.getPreferences()).disabledSites).toEqual(['a.test']);
  });

  it('applies concurrent patches without losing either (serialized read-modify-write)', async () => {
    const { store } = setup();
    await Promise.all([
      store.updatePreferences({ explanationLanguage: 'de' }),
      store.updatePreferences({ readingLevel: 'advanced' }),
      store.updatePreferences({ ttsRate: 1.5 }),
    ]);
    expect(await store.getPreferences()).toMatchObject({
      explanationLanguage: 'de',
      readingLevel: 'advanced',
      ttsRate: 1.5,
    });
  });

  it('reset keeps the per-site disable list and resets everything else (FR-006, FR-009)', async () => {
    const { store } = setup();
    await store.updatePreferences({
      explanationLanguage: 'fr',
      readingLevel: 'advanced',
      tooltipBehavior: 'on-demand',
      ttsRate: 1.5,
      ttsLang: 'fr-FR',
      model: 'm',
      disabledSites: ['a.test', 'b.test'],
    });
    expect(await store.resetPreferences()).toEqual({
      ...DEFAULT_PREFERENCES,
      disabledSites: ['a.test', 'b.test'],
    });
    expect(await store.getPreferences()).toEqual({
      ...DEFAULT_PREFERENCES,
      disabledSites: ['a.test', 'b.test'],
    });
  });

  it('resets to the defaults by removing the record when no site is disabled (FR-006)', async () => {
    const { area, store } = setup();
    await store.updatePreferences({ explanationLanguage: 'fr', model: 'm' });
    expect(await store.resetPreferences()).toEqual(DEFAULT_PREFERENCES);
    expect(area.keys()).toEqual([]);
    expect(await store.getPreferences()).toEqual(DEFAULT_PREFERENCES);
  });

  it('records the disclosure once and keeps the first timestamp', async () => {
    let clock = 1000;
    const area = new MemoryArea();
    const store = createSettingsStore({ area, now: () => clock });
    expect((await store.acceptDisclosure()).disclosureAcceptedAt).toBe(1000);
    clock = 9000;
    expect((await store.acceptDisclosure()).disclosureAcceptedAt).toBe(1000);
  });

  it('updates onboarding fields independently', async () => {
    const { store } = setup();
    await store.updateOnboarding({ siteAccessChoice: 'declined' });
    expect(await store.updateOnboarding({ completed: true })).toEqual({
      completed: true,
      disclosureAcceptedAt: null,
      siteAccessChoice: 'declined',
    });
  });

  it('survives corrupt stored data: reads fall back, the next write repairs it', async () => {
    const { area, store } = setup();
    area.data.set(STORAGE_KEYS.preferences, { v: 1, data: { ttsRate: 'fast' } });
    area.data.set(STORAGE_KEYS.onboarding, 'garbage');
    expect(await store.getSnapshot()).toEqual({
      preferences: DEFAULT_PREFERENCES,
      onboarding: DEFAULT_ONBOARDING,
    });
    await store.updatePreferences({ readingLevel: 'simple' });
    expect(await store.getPreferences()).toEqual({
      ...DEFAULT_PREFERENCES,
      readingLevel: 'simple',
    });
  });

  it('reads never throw when storage itself fails; writes report STORAGE_UNAVAILABLE', async () => {
    const { area, store } = setup();
    area.failWith = new Error('quota');
    expect(await store.getPreferences()).toEqual(DEFAULT_PREFERENCES);
    expect(await store.getOnboarding()).toEqual(DEFAULT_ONBOARDING);
    await expect(store.updatePreferences({ ttsRate: 1.5 })).rejects.toBeInstanceOf(
      StorageUnavailableError,
    );
    await expect(store.acceptDisclosure()).rejects.toBeInstanceOf(StorageUnavailableError);
    await expect(store.resetPreferences()).rejects.toBeInstanceOf(StorageUnavailableError);
  });

  it('keeps working after a failed write', async () => {
    const { area, store } = setup();
    area.failWith = new Error('x');
    await expect(store.updatePreferences({ ttsRate: 1.5 })).rejects.toThrow();
    area.failWith = undefined;
    expect((await store.updatePreferences({ ttsRate: 1.5 })).ttsRate).toBe(1.5);
  });
});

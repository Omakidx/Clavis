import { describe, expect, it } from 'vitest';
import {
  findNamedVoice,
  hasUsableVoice,
  normalizeLang,
  resolveLanguage,
  sameLanguage,
  selectVoice,
  toLanguageTag,
} from '../../../lib/speech/voice-selection';
import { voice } from './helpers';

describe('normalizeLang', () => {
  it('lowercases, trims and uses hyphens', () => {
    expect(normalizeLang(' en_US ')).toBe('en-us');
    expect(normalizeLang(undefined)).toBe('');
  });
});

describe('selectVoice', () => {
  it('reports no-voices when nothing is installed', () => {
    expect(selectVoice([], 'en-US')).toEqual({ ok: false, reason: 'no-voices' });
    expect(selectVoice([])).toEqual({ ok: false, reason: 'no-voices' });
  });

  it('without a language accepts any voice and lets the engine pick its default', () => {
    expect(selectVoice([voice('chrome-tts', 'de-DE')])).toEqual({ ok: true, voice: undefined });
  });

  it('prefers the exact locale over the same language in another region', () => {
    const gb = voice('chrome-tts', 'en-GB');
    const us = voice('chrome-tts', 'en-US');
    expect(selectVoice([gb, us], 'en-US')).toEqual({ ok: true, voice: us });
  });

  it('falls back to the same primary language when the region is not installed', () => {
    const gb = voice('chrome-tts', 'en-GB');
    expect(selectVoice([voice('chrome-tts', 'fr-FR'), gb], 'en-US')).toEqual({
      ok: true,
      voice: gb,
    });
  });

  it('never substitutes a voice for a different language (no silent mispronunciation)', () => {
    expect(selectVoice([voice('chrome-tts', 'en-US')], 'fr-FR')).toEqual({
      ok: false,
      reason: 'no-language-match',
    });
  });

  it('prefers a local voice over a remote one of equal match quality', () => {
    const remote = voice('chrome-tts', 'en-US', { name: 'remote', remote: true });
    const local = voice('chrome-tts', 'en-US', { name: 'local' });
    expect(selectVoice([remote, local], 'en-US')).toEqual({ ok: true, voice: local });
  });

  it('uses an exact remote voice before a local voice of another region', () => {
    const remoteExact = voice('chrome-tts', 'en-US', { remote: true });
    const localOther = voice('chrome-tts', 'en-GB');
    expect(selectVoice([localOther, remoteExact], 'en-US')).toEqual({
      ok: true,
      voice: remoteExact,
    });
  });

  it('ignores voices that list their events but omit start (they could never prove audio began)', () => {
    const silent = voice('chrome-tts', 'en-US', { eventTypes: ['end', 'error'] });
    expect(selectVoice([silent], 'en-US')).toEqual({ ok: false, reason: 'no-voices' });
    const ok = voice('chrome-tts', 'en-US', { eventTypes: ['start', 'end'] });
    expect(selectVoice([silent, ok], 'en-US')).toEqual({ ok: true, voice: ok });
  });

  it('skips voices that report no language when a language is requested', () => {
    expect(selectVoice([voice('chrome-tts', '')], 'en-US')).toEqual({
      ok: false,
      reason: 'no-language-match',
    });
  });
});

describe('resolveLanguage', () => {
  it('uses the message language, else the saved language', () => {
    expect(resolveLanguage('fr', 'en-GB')).toBe('fr');
    expect(resolveLanguage(undefined, 'en-GB')).toBe('en-GB');
    expect(resolveLanguage('de-DE', undefined)).toBe('de-DE');
    expect(resolveLanguage(undefined, undefined)).toBeUndefined();
  });

  it('lets a regional preference refine a bare language of the same language only', () => {
    expect(resolveLanguage('en', 'en-GB')).toBe('en-GB');
    expect(resolveLanguage('EN', 'en_GB')).toBe('en_GB');
    expect(resolveLanguage('en-US', 'en-GB')).toBe('en-US');
    expect(resolveLanguage('fr', 'en-GB')).toBe('fr');
    expect(resolveLanguage('en', 'en')).toBe('en');
  });
});

describe('sameLanguage', () => {
  it('compares the primary language and ignores the region', () => {
    expect(sameLanguage('en-GB', 'en_US')).toBe(true);
    expect(sameLanguage('en', 'fr')).toBe(false);
    expect(sameLanguage('', 'en')).toBe(false);
    expect(sameLanguage(undefined, undefined)).toBe(false);
  });
});

describe('findNamedVoice and hasUsableVoice', () => {
  const a = voice('chrome-tts', 'en-US', { name: 'Alex' });
  const mute = voice('chrome-tts', 'en-US', { name: 'Mute', eventTypes: ['end'] });

  it('finds an exact, case-sensitive name that could prove it started', () => {
    expect(findNamedVoice([a, mute], 'Alex')).toBe(a);
    expect(findNamedVoice([a, mute], 'alex')).toBeUndefined();
    expect(findNamedVoice([a, mute], 'Mute')).toBeUndefined();
  });

  it('knows whether any voice is usable', () => {
    expect(hasUsableVoice([])).toBe(false);
    expect(hasUsableVoice([mute])).toBe(false);
    expect(hasUsableVoice([mute, a])).toBe(true);
  });
});

describe('toLanguageTag', () => {
  it('normalises engine tags and drops what is not a tag', () => {
    expect(toLanguageTag('en_US')).toBe('en-US');
    expect(toLanguageTag(' fr-FR ')).toBe('fr-FR');
    expect(toLanguageTag('')).toBeUndefined();
    expect(toLanguageTag('english (united states)')).toBeUndefined();
    expect(toLanguageTag(undefined)).toBeUndefined();
  });
});

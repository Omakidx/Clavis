import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, TTS_RATES } from '../../../lib/config/constants';
import type { SelectionSnapshot } from '../../../lib/contracts';
import { api } from '../../../lib/ui-client/api';
import { FALLBACK_PREFS, runExplain, runListen } from '../../../entrypoints/practice/actions';
import { createFakeBackend, installBackend, installCatalog } from './support';

const snapshot: SelectionSnapshot = {
  selectionId: '2d8a3a8e-0c1b-4d63-a1de-0f6a9f6f3a11',
  source: 'webpage',
  kind: 'sentence',
  text: 'She finally broke the ice.',
  contextBefore: 'Everyone was quiet at first. ',
  languageHint: 'en',
};

beforeEach(() => installCatalog());

describe('practice page actions', () => {
  it('Explain without a key ends in SETUP_REQUIRED with a Connect Groq action', async () => {
    const backend = createFakeBackend();
    installBackend(backend);
    const state = await runExplain(snapshot, FALLBACK_PREFS);
    // The fake backend validates the message with the real contract: INVALID_REQUEST would show here.
    expect(state.kind).toBe('error');
    if (state.kind === 'error') {
      expect(state.error.code).toBe('SETUP_REQUIRED');
      expect(state.error.action).toBe('connect');
    }
    expect(backend.calls.map((c) => c.type)).toEqual(['AI_EXPLAIN']);
    expect(backend.calls[0]).toMatchObject({ payload: { mode: 'core', targetLanguage: 'en' } });
  });

  it('Listen sends TTS_SPEAK with the saved rate and works without a key', async () => {
    const backend = createFakeBackend();
    installBackend(backend);
    const state = await runListen(snapshot, { ...FALLBACK_PREFS, ttsRate: TTS_RATES.slow });
    expect(state.kind).toBe('speaking');
    expect(backend.calls[0]).toMatchObject({ type: 'TTS_SPEAK', rate: 0.75, lang: 'en' });
    expect(snapshot.text.length).toBeLessThanOrEqual(LIMITS.maxSelectionChars);
  });

  it('prefers the saved voice language over the page language hint', async () => {
    const backend = createFakeBackend();
    installBackend(backend);
    await runListen(snapshot, { ...FALLBACK_PREFS, ttsLang: 'fr' });
    expect(backend.calls[0]).toMatchObject({ lang: 'fr' });
  });

  it('exposes the api wrappers the page relies on', () => {
    expect(typeof api.explain).toBe('function');
  });
});

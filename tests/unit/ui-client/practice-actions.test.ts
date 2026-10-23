import { beforeEach, describe, expect, it } from 'vitest';
import { LIMITS, TTS_RATES } from '../../../lib/config/constants';
import type { SelectionSnapshot } from '../../../lib/contracts';
import { api } from '../../../lib/ui-client/api';
import * as actionsModule from '../../../entrypoints/practice/actions';
import { FALLBACK_PREFS, runListen } from '../../../entrypoints/practice/actions';
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
    expect(typeof api.speak).toBe('function');
    // Explain is no longer driven from the practice page: the shared card sends it (components/explanation).
    expect('runExplain' in actionsModule).toBe(false);
  });
});

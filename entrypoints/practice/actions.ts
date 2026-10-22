import { TTS_RATES } from '../../lib/config/constants';
import type { ExplainResult } from '../../lib/contracts/explain';
import type { SelectionSnapshot } from '../../lib/contracts/selection';
import { DEFAULT_PREFERENCES, type PublicSettings } from '../../lib/contracts/setup';
import { api, type Api } from '../../lib/ui-client/api';
import type { ClientError } from '../../lib/ui-client/errors';

/** What the result panel shows. Plain data only: it is rendered as text nodes. */
export type PracticeState =
  | { kind: 'idle' }
  | { kind: 'working'; action: 'listen' | 'explain'; text: string }
  | { kind: 'speaking'; text: string }
  | { kind: 'explained'; text: string; result: ExplainResult }
  | { kind: 'error'; action: 'listen' | 'explain'; text: string; error: ClientError };

type PracticeApi = Pick<Api, 'speak' | 'explain'>;

/** The preferences the practice actions need; falls back to defaults without a backend. */
export type PracticePrefs = Pick<PublicSettings, 'explanationLanguage' | 'ttsRate'> & {
  ttsLang?: string | undefined;
};

export const FALLBACK_PREFS: PracticePrefs = {
  explanationLanguage: DEFAULT_PREFERENCES.explanationLanguage,
  ttsRate: TTS_RATES.normal,
};

/** Listen: TTS_SPEAK for the selection. Works without a Groq key. */
export async function runListen(
  snapshot: SelectionSnapshot,
  prefs: PracticePrefs,
  client: PracticeApi = api,
): Promise<PracticeState> {
  const lang = prefs.ttsLang ?? snapshot.languageHint;
  const result = await client.speak({
    requestId: crypto.randomUUID(),
    text: snapshot.text,
    ...(lang === undefined ? {} : { lang }),
    rate: prefs.ttsRate,
  });
  return result.ok
    ? { kind: 'speaking', text: snapshot.text }
    : { kind: 'error', action: 'listen', text: snapshot.text, error: result.error };
}

/**
 * Explain: AI_EXPLAIN in `core` mode. Phase 5 builds the real card; this panel only proves the
 * end-to-end path and shows the mapped error (SETUP_REQUIRED leads to "Connect Groq").
 */
export async function runExplain(
  snapshot: SelectionSnapshot,
  prefs: PracticePrefs,
  client: PracticeApi = api,
): Promise<PracticeState> {
  const result = await client.explain({
    requestId: crypto.randomUUID(),
    snapshot,
    mode: 'core',
    targetLanguage: prefs.explanationLanguage,
    detailLevel: 'standard',
  });
  return result.ok
    ? { kind: 'explained', text: snapshot.text, result: result.data }
    : { kind: 'error', action: 'explain', text: snapshot.text, error: result.error };
}

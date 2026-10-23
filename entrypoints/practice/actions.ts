import { TTS_RATES } from '../../lib/config/constants';
import type { SelectionSnapshot } from '../../lib/contracts/selection';
import { DEFAULT_PREFERENCES, type PublicSettings } from '../../lib/contracts/setup';
import { api, type Api } from '../../lib/ui-client/api';
import type { ClientError } from '../../lib/ui-client/errors';

/**
 * What the result panel shows. Plain data only: it is rendered as text nodes. Only Listen reports
 * here; Explain draws its answer in the same card the toolbar opens on web pages (Phase 5).
 */
export type PracticeState =
  | { kind: 'idle' }
  | { kind: 'working'; action: 'listen'; text: string }
  | { kind: 'speaking'; text: string }
  | { kind: 'error'; action: 'listen'; text: string; error: ClientError };

type PracticeApi = Pick<Api, 'speak'>;

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

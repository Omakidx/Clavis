import type { SpeechVoice } from './types';

/** Lowercase, `_` to `-`, trimmed. Empty input stays empty. */
export function normalizeLang(lang: string | undefined): string {
  return (lang ?? '').trim().replace(/_/g, '-').toLowerCase();
}

function primarySubtag(normalized: string): string {
  return normalized.split('-')[0] ?? '';
}

export type VoiceSelection =
  | { ok: true; voice: SpeechVoice | undefined }
  | { ok: false; reason: 'no-voices' | 'no-language-match' };

/** A chrome.tts voice that lists its event types but omits `start` could never prove audio began. */
function canReportStart(voice: SpeechVoice): boolean {
  return voice.eventTypes === undefined || voice.eventTypes.includes('start');
}

/**
 * Choose a voice for `lang` without silently mispronouncing (FR-024, tech-stack §8).
 *
 * - No `lang`: any usable voice is fine; `voice` is undefined so the engine uses its default.
 * - With `lang`: only voices for the same language qualify (exact tag beats primary
 *   subtag; local beats remote). A voice for another language is never used as a stand-in.
 */
export function selectVoice(voices: readonly SpeechVoice[], lang?: string): VoiceSelection {
  const usable = voices.filter(canReportStart);
  if (usable.length === 0) return { ok: false, reason: 'no-voices' };

  const wanted = normalizeLang(lang);
  if (wanted === '') return { ok: true, voice: undefined };

  const wantedPrimary = primarySubtag(wanted);
  let best: SpeechVoice | undefined;
  let bestRank = Number.POSITIVE_INFINITY;
  for (const voice of usable) {
    const have = normalizeLang(voice.lang);
    if (have === '') continue;
    let rank: number;
    if (have === wanted) rank = 0;
    else if (primarySubtag(have) === wantedPrimary) rank = 2;
    else continue;
    if (voice.remote) rank += 1;
    if (rank < bestRank) {
      best = voice;
      bestRank = rank;
    }
  }
  return best === undefined
    ? { ok: false, reason: 'no-language-match' }
    : { ok: true, voice: best };
}

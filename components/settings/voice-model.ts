import type { VoiceInfo, VoicesReport } from '../../lib/contracts/speech';

/** Pure helpers for the Settings voice chooser (FR-025). */

export const ALL_LANGUAGES = '';

/**
 * Every voice on the device, Chrome's first, once per name: the same name in both engines is one
 * choice (the preference stores only a name), and Chrome's copy wins. Voices of the optional
 * fallback engine count only while that engine is available (it is not adopted, D-07).
 */
export function allVoices(report: VoicesReport): VoiceInfo[] {
  const seen = new Set<string>();
  const { chromeTts, offscreen } = report.engines;
  return [...chromeTts.voices, ...(offscreen.available ? offscreen.voices : [])].filter(
    (voice) => !seen.has(voice.name) && seen.add(voice.name) !== undefined,
  );
}

/**
 * Spoken sample for Test voice in the voice's own language where known, so a French voice does not
 * read English. Not UI text; other languages fall back to the English catalog sample.
 */
const SAMPLES: Record<string, string> = {
  es: 'Hola, así suena Clavis.',
  fr: 'Bonjour, voici comment parle Clavis.',
  de: 'Hallo, so klingt Clavis.',
  it: 'Ciao, ecco come suona Clavis.',
  pt: 'Olá, é assim que o Clavis soa.',
  nl: 'Hallo, zo klinkt Clavis.',
};

export function sampleFor(lang: string | undefined, fallback: string): string {
  return SAMPLES[primaryLanguage(lang)] ?? fallback;
}

/** "en-US" -> "en", "zh-Hans-CN" -> "zh". Empty for a voice with no language. */
export function primaryLanguage(tag: string | undefined): string {
  return (tag ?? '').split(/[-_]/)[0]?.toLowerCase() ?? '';
}

/** Languages the device's voices speak, sorted, for the filter. */
export function voiceLanguages(voices: readonly VoiceInfo[]): string[] {
  return [...new Set(voices.map((voice) => primaryLanguage(voice.lang)).filter(Boolean))].sort();
}

/**
 * Voices to offer for a language filter. A voice without a language is kept (it may speak
 * anything), and so is the voice that is currently saved, so the drop-down never lies about it.
 */
export function filterVoices(
  voices: readonly VoiceInfo[],
  language: string,
  keepName?: string,
): VoiceInfo[] {
  if (language === ALL_LANGUAGES) return [...voices];
  return voices.filter((voice) => {
    const own = primaryLanguage(voice.lang);
    return own === language || own === '' || voice.name === keepName;
  });
}

/** The language filter to start with: the user's voice language when a voice speaks it. */
export function initialFilter(voices: readonly VoiceInfo[], ttsLang: string | undefined): string {
  const wanted = primaryLanguage(ttsLang);
  return wanted !== '' && voiceLanguages(voices).includes(wanted) ? wanted : ALL_LANGUAGES;
}

/** Display name of a language in the UI language, falling back to the code. */
export function languageName(code: string): string {
  try {
    return (
      new Intl.DisplayNames([navigator.language || 'en'], { type: 'language' }).of(code) ?? code
    );
  } catch {
    return code;
  }
}

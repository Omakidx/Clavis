/**
 * Languages offered for explanations and voices. Tags are BCP-47; the explanation language is
 * also the language the model is asked to write in, so only widely supported ones are listed.
 * A saved value outside this list is still shown (see `languageOptions`).
 */
export const LANGUAGE_TAGS = [
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'nl',
  'sv',
  'pl',
  'tr',
  'ru',
  'uk',
  'ar',
  'he',
  'hi',
  'bn',
  'zh-Hans',
  'zh-Hant',
  'ja',
  'ko',
  'vi',
  'id',
  'th',
] as const;

export interface LanguageOption {
  tag: string;
  label: string;
}

/** Name of a language in itself (e.g. "Deutsch"), so a reader can find theirs without English. */
function nameOf(tag: string): string {
  try {
    const own = new Intl.DisplayNames([tag], { type: 'language' }).of(tag);
    const english = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
    if (own === undefined) return tag;
    return english !== undefined && english !== own ? `${own} (${english})` : own;
  } catch {
    return tag;
  }
}

/** Options for a language drop-down, adding the saved tag when it is not in the list. */
export function languageOptions(current: string | undefined): LanguageOption[] {
  const tags: string[] = [...LANGUAGE_TAGS];
  if (current !== undefined && !tags.includes(current)) tags.push(current);
  return tags.map((tag) => ({ tag, label: nameOf(tag) }));
}

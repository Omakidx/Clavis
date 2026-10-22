import type { SelectionKind } from '../contracts/selection';

/** Words above this count make a selection a passage regardless of punctuation. */
const MAX_SENTENCE_WORDS = 60;
/** Characters above this make a selection a passage (covers unspaced scripts). */
const MAX_SENTENCE_CHARS = 400;
/** Up to this many words without terminal punctuation is a phrase. */
const MAX_PHRASE_WORDS = 6;

const TERMINAL = /[.!?…。！？]["')\]”’»]*$/u;
const SENTENCE_BREAK = /(?<=[.!?…。！？]["')\]”’»]*)(?:\s+(?=\S)|(?<=[。！？])(?=\S))/u;
const ABBREVIATION = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e|Inc|Ltd|No|[A-Z])\.$/;
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;
const SINGLE_WORD = /^[\p{L}\p{M}\p{N}]+(?:[-'’_.][\p{L}\p{M}\p{N}]+)*$/u;
const EDGE_PUNCTUATION = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;

const segmenters = new Map<string, Intl.Segmenter>();

function segmenterFor(lang: string | undefined): Intl.Segmenter | undefined {
  if (typeof Intl.Segmenter !== 'function') return undefined;
  const key = lang ?? '';
  let segmenter = segmenters.get(key);
  if (segmenter === undefined) {
    try {
      segmenter = new Intl.Segmenter(lang, { granularity: 'word' });
    } catch {
      segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
    }
    segmenters.set(key, segmenter);
  }
  return segmenter;
}

/** Count word-like tokens, capped so a huge selection never costs a full scan. */
export function countWords(text: string, lang?: string): number {
  const cap = MAX_SENTENCE_WORDS + 1;
  if (UNSPACED_SCRIPT.test(text)) {
    const segmenter = segmenterFor(lang);
    if (segmenter !== undefined) {
      let count = 0;
      for (const part of segmenter.segment(text)) {
        if (part.isWordLike === true && ++count >= cap) break;
      }
      return count;
    }
  }
  let count = 0;
  for (const token of text.split(' ')) {
    if (HAS_WORD_CHAR.test(token) && ++count >= cap) break;
  }
  return count;
}

/** Number of sentences, treating common abbreviations as non-terminal. */
export function countSentences(text: string): number {
  const breaks = new RegExp(SENTENCE_BREAK.source, 'gu');
  let count = 1;
  let start = 0;
  for (let match = breaks.exec(text); match !== null; match = breaks.exec(text)) {
    if (match[0].length === 0) breaks.lastIndex += 1;
    if (match.index > start && !ABBREVIATION.test(text.slice(start, match.index))) count += 1;
    start = match.index + match[0].length;
  }
  return count;
}

/**
 * Classify NORMALIZED text (see `normalizeText`) as word, phrase, sentence or
 * passage. Heuristic by design (FR-011): it only steers which actions are
 * offered, never what is sent.
 */
export function classifySelection(text: string, lang?: string): SelectionKind {
  const trimmed = text.trim();
  if (!trimmed.includes(' ')) {
    const core = trimmed.replace(EDGE_PUNCTUATION, '');
    if (core !== '' && SINGLE_WORD.test(core) && !UNSPACED_SCRIPT.test(core)) return 'word';
  }
  const words = countWords(trimmed, lang);
  if (words <= 1) return 'word';
  if (words > MAX_SENTENCE_WORDS || trimmed.length > MAX_SENTENCE_CHARS) return 'passage';
  if (countSentences(trimmed) > 1) return 'passage';
  if (words <= MAX_PHRASE_WORDS && !TERMINAL.test(trimmed)) return 'phrase';
  return 'sentence';
}

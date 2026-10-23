import { FEATURES } from '../../lib/config/constants';
import type { ExplainMode, ExplainResult } from '../../lib/contracts/explain';
import type { SelectionKind } from '../../lib/contracts/selection';
import { t, type MessageKey } from '../../lib/i18n';
import { truncateText as cutAtCodePoint } from '../../lib/selection/text';

/**
 * Pure data and rules of the explanation card: which tabs a selection gets, what a result
 * shows, and the plain-text form of it. No UI library and no zod here: the card script is
 * budgeted separately (scripts/size-budgets.json) and the background has already validated the
 * reply against `explainResultSchema`; the guard below only protects the renderer from a shape
 * it does not know, it is not a security boundary.
 *
 * Everything model-written is plain text (D-10, FR-041): blocks carry strings, never markup.
 */

export interface FeatureFlags {
  grammarTab: boolean;
  translateTab: boolean;
}

/**
 * Tabs per selection kind (D-05, UJ-02, UJ-03, FR-033..035): Roots and Related words are for a
 * word or a short phrase (an idiom has an origin and near-synonyms); Simplify is for anything that
 * reads as text (a phrase, a sentence, a passage), never for a single word; a sentence or passage
 * gets no word-only tab.
 */
const TABS_BY_KIND: Record<SelectionKind, readonly ExplainMode[]> = {
  word: ['core', 'etymology', 'related_words'],
  phrase: ['core', 'etymology', 'related_words', 'simplify'],
  sentence: ['core', 'simplify'],
  passage: ['core', 'simplify'],
};

/** The tabs to show for a selection, in order. Grammar and Translate only when their flag is on. */
export function tabsFor(kind: SelectionKind, features: FeatureFlags = FEATURES): ExplainMode[] {
  const tabs = [...TABS_BY_KIND[kind]];
  if (features.grammarTab && kind !== 'word') tabs.push('grammar');
  if (features.translateTab) tabs.push('translate');
  return tabs;
}

/**
 * Cache key of one tab's result: per selection and mode, plus the target language where it
 * changes the answer (translation). A different selection never shares a key, so switching the
 * selection discards the cache by construction.
 */
export function cacheKey(selectionId: string, mode: ExplainMode, targetLanguage?: string): string {
  return `${selectionId}:${mode}${mode === 'translate' && targetLanguage ? `:${targetLanguage}` : ''}`;
}

const TAB_LABEL = {
  core: 'cardTabCore',
  etymology: 'cardTabRoots',
  related_words: 'cardTabRelated',
  simplify: 'cardTabSimplify',
  grammar: 'cardTabGrammar',
  translate: 'cardTabTranslate',
} as const satisfies Record<ExplainMode, MessageKey>;

export const tabLabel = (mode: ExplainMode): string => t(TAB_LABEL[mode]);

const KIND_LABEL = {
  word: 'cardKindWord',
  phrase: 'cardKindPhrase',
  sentence: 'cardKindSentence',
  passage: 'cardKindPassage',
} as const satisfies Record<SelectionKind, MessageKey>;

export const kindLabel = (kind: SelectionKind): string => t(KIND_LABEL[kind]);

/** The selected text for the header: one line, cut on a character boundary. */
export function truncateText(text: string, max = 80): string {
  const chars = Array.from(text.replace(/\s+/g, ' ').trim());
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

// ---------------------------------------------------------------------------
// Reading the reply
// ---------------------------------------------------------------------------

const MODES: readonly string[] = [
  'core',
  'etymology',
  'related_words',
  'simplify',
  'grammar',
  'translate',
];
/** Far above every schema bound (lib/contracts/explain.ts); only stops a runaway string. */
const MAX_FIELD_CHARS = 5000;
const MAX_LIST = 12;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? cutAtCodePoint(value, MAX_FIELD_CHARS) : undefined;

function words(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .map((item) => text(item))
    .filter((item): item is string => item !== undefined)
    .slice(0, MAX_LIST);
  return list;
}

/**
 * The reply `data` as an `ExplainResult`, or null when it is not one. Unknown keys are dropped,
 * so only the fields the card knows how to draw can reach the page.
 */
export function readExplainResult(value: unknown): ExplainResult | null {
  if (!isRecord(value)) return null;
  const requestId = text(value['requestId']);
  const mode = text(value['mode']);
  const title = text(value['title']);
  const summary = text(value['summary']);
  const model = text(value['model']);
  if (
    requestId === undefined ||
    mode === undefined ||
    !MODES.includes(mode) ||
    title === undefined ||
    summary === undefined ||
    model === undefined
  ) {
    return null;
  }
  const result: ExplainResult = {
    requestId,
    selectedText: text(value['selectedText']) ?? '',
    mode: mode as ExplainMode,
    title,
    summary,
    provider: 'groq',
    model,
  };
  const set = <K extends keyof ExplainResult>(key: K, next: ExplainResult[K] | undefined): void => {
    if (next !== undefined) result[key] = next;
  };
  set('contextualMeaning', text(value['contextualMeaning']));
  set('definition', text(value['definition']));
  set('caveat', text(value['caveat']));
  set('grammar', text(value['grammar']));
  set('simplifiedText', text(value['simplifiedText']));
  set('synonyms', words(value['synonyms']));
  set('antonyms', words(value['antonyms']));

  const examples = value['examples'];
  if (Array.isArray(examples)) {
    const list = examples.flatMap((item) => {
      const sentence = isRecord(item) ? text(item['sentence']) : undefined;
      if (sentence === undefined || !isRecord(item)) return [];
      const note = text(item['note']);
      return [note === undefined ? { sentence } : { sentence, note }];
    });
    if (list.length === 2) result.examples = list as NonNullable<ExplainResult['examples']>;
  }

  const etymology = value['etymology'];
  if (isRecord(etymology)) {
    const overview = text(etymology['overview']);
    if (overview !== undefined) {
      result.etymology = {
        overview,
        confidence: etymology['confidence'] === 'known' ? 'known' : 'uncertain',
      };
    }
  }

  const translation = value['translation'];
  if (isRecord(translation)) {
    const language = text(translation['language']);
    const body = text(translation['text']);
    if (language !== undefined && body !== undefined) {
      const literal = text(translation['literal']);
      result.translation =
        literal === undefined ? { language, text: body } : { language, text: body, literal };
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// What a result shows
// ---------------------------------------------------------------------------

/**
 * One piece of a result. The card draws blocks and the Copy button flattens the same blocks, so
 * what is copied is exactly what is shown.
 */
export type Block =
  | { kind: 'title'; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'field'; label: string; text: string }
  /** `generated`: model-written example sentences, labelled as such (FR-032). */
  | { kind: 'list'; label: string; items: string[]; ordered: boolean }
  | { kind: 'note'; label: string; text: string };

export function resultBlocks(result: ExplainResult): Block[] {
  const blocks: Block[] = [{ kind: 'title', text: result.title }];
  const field = (label: string, value: string | undefined): void => {
    if (value !== undefined) blocks.push({ kind: 'field', label, text: value });
  };
  switch (result.mode) {
    case 'core':
      blocks.push({ kind: 'paragraph', text: result.summary });
      field(t('cardMeaning'), result.contextualMeaning);
      field(t('cardDefinition'), result.definition);
      if (result.examples !== undefined) {
        blocks.push({
          kind: 'list',
          label: t('cardExamples'),
          items: result.examples.map((example) =>
            example.note === undefined ? example.sentence : `${example.sentence} (${example.note})`,
          ),
          ordered: true,
        });
      }
      break;
    case 'etymology':
      blocks.push({ kind: 'paragraph', text: result.summary });
      if (result.etymology !== undefined) {
        blocks.push({ kind: 'paragraph', text: result.etymology.overview });
        blocks.push({
          kind: 'note',
          label: t('cardNote'),
          text:
            result.etymology.confidence === 'known'
              ? t('cardEtymologyKnown')
              : t('cardEtymologyUncertain'),
        });
      }
      break;
    case 'related_words': {
      const none = t('cardNotApplicable');
      const related = (label: string, list: string[] | undefined): void => {
        if (list !== undefined && list.length > 0) {
          blocks.push({ kind: 'list', label, items: list, ordered: false });
        } else {
          blocks.push({ kind: 'field', label, text: none });
        }
      };
      related(t('cardSynonyms'), result.synonyms);
      related(t('cardAntonyms'), result.antonyms);
      break;
    }
    case 'simplify':
      field(t('cardSimplified'), result.simplifiedText ?? result.summary);
      break;
    case 'grammar':
      field(t('cardGrammar'), result.grammar ?? result.summary);
      break;
    case 'translate':
      if (result.translation !== undefined) {
        field(t('cardTranslation', result.translation.language), result.translation.text);
        field(t('cardLiteral'), result.translation.literal);
      } else {
        blocks.push({ kind: 'paragraph', text: result.summary });
      }
      break;
  }
  field(t('cardNote'), result.caveat);
  return blocks;
}

/** The blocks as plain text for the clipboard (FR-019): no markup, one blank line between parts. */
export function blocksToText(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.kind) {
        case 'title':
        case 'paragraph':
          return block.text;
        case 'field':
        case 'note':
          return `${block.label}: ${block.text}`;
        case 'list':
          return [
            `${block.label}:`,
            ...block.items.map((item, index) =>
              block.ordered ? `${index + 1}. ${item}` : `- ${item}`,
            ),
          ].join('\n');
      }
    })
    .join('\n\n');
}

export const resultText = (result: ExplainResult): string => blocksToText(resultBlocks(result));

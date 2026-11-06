import type { ExplainMode, ExplainResult } from '../../lib/contracts/explain';
import type { SidePanelHandoff } from '../../lib/contracts/sidepanel';
import type { SelectionKind } from '../../lib/contracts/selection';
import type { VoicesReport } from '../../lib/contracts/speech';
import type { KeyStatus, SettingsSnapshot } from '../../lib/contracts/setup';
import { DEFAULT_PREFERENCES } from '../../lib/contracts/setup';

/**
 * Canned data for the design preview. Everything here is made up and only has to satisfy the real
 * contract schemas (lib/contracts/**); it is never shipped (dev/ is outside every WXT entrypoint).
 */

export const MODEL = 'openai/gpt-oss-20b';

export const MODELS: KeyStatus['models'] = [
  { id: 'openai/gpt-oss-20b', supportsJsonSchema: true },
  { id: 'openai/gpt-oss-120b', supportsJsonSchema: true },
  { id: 'llama-3.3-70b-versatile', supportsJsonSchema: false },
  { id: 'llama-3.1-8b-instant', supportsJsonSchema: false },
];

export const SAMPLE_SENTENCE =
  'The ephemeral beauty of the cherry blossoms reminded her that nothing lasts forever.';
export const SAMPLE_WORD = 'ephemeral';
export const SAMPLE_PASSAGE =
  'Although the committee had initially been sceptical, the data proved so compelling that, by the end of the meeting, even its most vocal critics conceded the proposal merited a trial run. Whether that trial would scale, however, remained an open question.';

interface Entry {
  title: string;
  summary: string;
  meaning: string;
  definition: string;
  examples: [string, string];
  etymology: string;
  synonyms: string[];
  antonyms: string[];
}

const DICTIONARY: Record<string, Entry> = {
  ephemeral: {
    title: 'ephemeral',
    summary: 'Lasting for a very short time.',
    meaning:
      'Here it describes the blossoms: they are beautiful precisely because they last only a few days each spring.',
    definition: 'adjective: short-lived; existing or valid for only a brief period.',
    examples: [
      'Fame in the age of social media is often ephemeral.',
      'The ice sculpture was an ephemeral work of art that melted by noon.',
    ],
    etymology:
      'From Greek ephemeros, "lasting only a day" (epi "on" + hemera "day"). It first described a fever lasting a single day, then anything short-lived.',
    synonyms: ['fleeting', 'transient', 'short-lived', 'momentary'],
    antonyms: ['permanent', 'lasting', 'enduring'],
  },
};

const GENERIC: Entry = {
  title: '',
  summary: 'A short plain-language answer to what this text means in its context.',
  meaning:
    'In this sentence the selected text is used in its everyday sense; the surrounding words point to the meaning given here.',
  definition: 'The standard dictionary meaning, in simple words.',
  examples: [
    'A first example that shows the same meaning in a different sentence.',
    'A second example, with a slightly different setting.',
  ],
  etymology:
    'This is made-up preview text. In the real app it is a short note about where the word comes from.',
  synonyms: ['similar', 'comparable', 'alike'],
  antonyms: ['different', 'unlike'],
};

const LANGUAGE_NAMES = (tag: string): string => {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
};

/** Cut `text` to at most `max` characters, for titles that have to fit a schema bound. */
const cut = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;

export interface FakeExplainRequest {
  requestId: string;
  mode: ExplainMode;
  snapshot: { text: string; kind: SelectionKind };
  targetLanguage?: string | undefined;
}

/** A realistic, schema-valid result for any mode. */
export function fakeResult(request: FakeExplainRequest): ExplainResult {
  const { text, kind } = request.snapshot;
  const entry = DICTIONARY[text.trim().toLowerCase()] ?? {
    ...GENERIC,
    title: cut(text.trim(), 120),
  };
  const base = {
    requestId: request.requestId,
    selectedText: cut(text, 2000),
    mode: request.mode,
    title: entry.title,
    summary: entry.summary,
    provider: 'groq' as const,
    model: MODEL,
  };
  switch (request.mode) {
    case 'core':
      return {
        ...base,
        contextualMeaning: entry.meaning,
        definition: entry.definition,
        examples: [
          { sentence: entry.examples[0], note: 'Everyday use' },
          { sentence: entry.examples[1] },
        ],
      };
    case 'etymology':
      return {
        ...base,
        etymology: { overview: entry.etymology, confidence: 'known' },
        caveat: 'Word histories are reconstructed from old texts and can be uncertain.',
      };
    case 'related_words':
      return { ...base, synonyms: entry.synonyms, antonyms: entry.antonyms };
    case 'simplify':
      return {
        ...base,
        title: 'Simpler version',
        summary: 'The same idea in plainer words.',
        simplifiedText:
          kind === 'passage' || kind === 'sentence'
            ? 'At first the group did not believe it. The numbers were so strong that, by the end of the meeting, even the biggest doubters agreed to try the plan. Nobody knew yet if it would work on a larger scale.'
            : `${entry.definition} (${text})`,
      };
    case 'grammar':
      return {
        ...base,
        title: 'Grammar notes',
        summary: 'How the sentence is built.',
        grammar:
          'The main clause is "the beauty reminded her". "That nothing lasts forever" is a noun clause: it says what she was reminded of.',
      };
    case 'translate': {
      const language = LANGUAGE_NAMES(request.targetLanguage ?? 'es');
      return {
        ...base,
        title: language,
        summary: `Translated into ${language}.`,
        translation: {
          language,
          text: 'La belleza efímera de los cerezos en flor le recordó que nada dura para siempre.',
          literal:
            'The ephemeral beauty of the cherries in flower to-her reminded that nothing lasts for always.',
        },
      };
    }
  }
}

/** A made-up LONG answer, so the card shows its "more room in the side panel" note. */
export function fakeLongResult(requestId: string): ExplainResult {
  const paragraph =
    'The committee began from a position of doubt. Early in the meeting its members asked for the raw data, checked the sample sizes and questioned how the numbers had been gathered. ';
  return {
    requestId,
    selectedText: cut(SAMPLE_PASSAGE, 2000),
    mode: 'simplify',
    title: 'Simpler version',
    summary: 'The same passage in plainer words.',
    simplifiedText: paragraph.repeat(5).trim(),
    caveat: 'Some nuance in "merited a trial run" is lost in a simpler version.',
    provider: 'groq',
    model: MODEL,
  };
}

export const SAMPLE_IDS = {
  selection: '5b1b3a6e-7e9d-4a3c-9f6e-2d0c5f7a9b11',
  request: (n: number) => `0b9c1f3e-4d5a-4b6c-8d7e-${String(n).padStart(12, '0')}`,
} as const;

/** The side panel's sample hand-off: a sentence with five loaded tabs. */
export function sampleHandoff(): SidePanelHandoff {
  const modes: ExplainMode[] = ['core', 'etymology', 'related_words', 'simplify', 'translate'];
  const results = modes.map((mode, index) => {
    const { selectedText: _text, ...rest } = fakeResult({
      requestId: SAMPLE_IDS.request(index + 1),
      mode,
      snapshot: { text: SAMPLE_WORD, kind: 'word' },
      targetLanguage: 'es',
    });
    return rest;
  });
  return {
    snapshot: {
      selectionId: SAMPLE_IDS.selection,
      source: 'webpage',
      kind: 'word',
      text: SAMPLE_WORD,
      contextBefore: 'The ',
      contextAfter: ' beauty of the cherry blossoms reminded her that nothing lasts forever.',
      languageHint: 'en',
    },
    results,
    active: 'core',
    targetLanguage: 'es',
  };
}

export function defaultSnapshot(): SettingsSnapshot {
  return {
    preferences: { ...DEFAULT_PREFERENCES },
    onboarding: {
      completed: true,
      disclosureAcceptedAt: 1_760_000_000_000,
      siteAccessChoice: 'granted',
    },
  };
}

const voice = (
  name: string,
  lang: string,
  remote: boolean,
): VoicesReport['engines']['chromeTts']['voices'][number] => ({
  name,
  lang,
  engine: 'chrome-tts',
  remote,
});

export const LOCAL_VOICES = [
  voice('English (Great Britain)', 'en-GB', false),
  voice('English (America)', 'en-US', false),
  voice('Spanish (Spain)', 'es-ES', false),
  voice('French (France)', 'fr-FR', false),
  voice('German', 'de-DE', false),
];

export const ONLINE_VOICES = [
  voice('Google US English', 'en-US', true),
  voice('Google UK English Female', 'en-GB', true),
  voice('Google español', 'es-ES', true),
  voice('Google 日本語', 'ja-JP', true),
];

export function voicesReport(kind: 'normal' | 'none' | 'online-only'): VoicesReport {
  const voices =
    kind === 'none'
      ? []
      : kind === 'online-only'
        ? ONLINE_VOICES
        : [...LOCAL_VOICES, ...ONLINE_VOICES];
  return {
    platform: 'linux',
    defaultEngine: kind === 'none' ? 'none' : 'chrome-tts',
    engines: {
      chromeTts: { voices },
      offscreen: { available: false, voices: [] },
    },
  };
}

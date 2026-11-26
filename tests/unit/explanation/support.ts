import type {
  BackendReply,
  ExplainBackend,
  PdfRef,
  SaveOutcome,
  SettingsSection,
} from '../../../components/explanation/backend';
import type { SavedMeaningInput } from '../../../components/explanation/session';
import type { ExplainRequest, ExplainResult } from '../../../lib/contracts/explain';
import type { SelectionKind, SelectionSnapshot } from '../../../lib/contracts/selection';
import type { SidePanelHandoff } from '../../../lib/contracts/sidepanel';

export { installCatalog } from '../ui-client/support';

let counter = 0;
const uuid = (): string => {
  counter += 1;
  return `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`;
};

export function makeSnapshot(
  kind: SelectionKind = 'word',
  text = 'bank',
  overrides: Partial<SelectionSnapshot> = {},
): SelectionSnapshot {
  return {
    selectionId: uuid(),
    source: 'webpage',
    kind,
    text,
    contextBefore: 'They sat on the ',
    contextAfter: ' of the river.',
    languageHint: 'en',
    ...overrides,
  };
}

/** A valid result for `request`, as the background would return it. */
export function resultFor(
  request: ExplainRequest,
  overrides: Partial<ExplainResult> = {},
): ExplainResult {
  const base = {
    requestId: request.requestId,
    selectedText: request.snapshot.text,
    mode: request.mode,
    provider: 'groq' as const,
    model: 'openai/gpt-oss-20b',
  };
  switch (request.mode) {
    case 'core':
      return {
        ...base,
        title: 'bank (noun)',
        summary: 'The land beside a river.',
        contextualMeaning: 'Here it means the edge of the river, not a money bank.',
        definition: 'Sloping ground along the side of a river.',
        examples: [
          { sentence: 'We fished from the bank.', note: 'riverside' },
          { sentence: 'The grass on the bank was wet.' },
        ],
        caveat: 'Other senses exist.',
        ...overrides,
      };
    case 'etymology':
      return {
        ...base,
        title: 'Roots of bank',
        summary: 'From Old Norse.',
        etymology: { overview: 'From Old Norse "bakki".', confidence: 'known' },
        ...overrides,
      };
    case 'related_words':
      return {
        ...base,
        title: 'Related words',
        summary: 'Words near bank.',
        synonyms: ['shore', 'edge'],
        antonyms: [],
        ...overrides,
      };
    case 'simplify':
      return {
        ...base,
        title: 'Simpler',
        summary: 'A simple version.',
        simplifiedText: 'She finally got people talking.',
        ...overrides,
      };
    case 'grammar':
      return { ...base, title: 'Grammar', summary: 'x', grammar: 'An idiom.', ...overrides };
    case 'translate':
      return {
        ...base,
        title: 'Translation',
        summary: 'x',
        translation: { language: 'French', text: 'banque', literal: 'rive' },
        ...overrides,
      };
  }
}

export interface PendingCall {
  request: ExplainRequest;
  acknowledge: boolean;
  /** Answer the call. */
  reply(reply: BackendReply): void;
  /** Answer with the successful result for the call. */
  succeed(overrides?: Partial<ExplainResult>): void;
}

/** A backend whose explain calls stay pending until the test answers them. */
export function createFakeBackend() {
  const calls: PendingCall[] = [];
  const cancelled: string[] = [];
  const settings: Array<SettingsSection | undefined> = [];
  const handoffs: SidePanelHandoff[] = [];
  const state = { settingsOpens: true, panelOpens: true, language: 'en' as string | undefined };
  /** Saved words: what the Save button asked for, and what is "in the library". */
  const saves: Array<{ snapshot: SelectionSnapshot; meaning: SavedMeaningInput; pdf?: PdfRef }> =
    [];
  const removed: string[] = [];
  const library = new Map<string, string>();
  const saving = { outcome: { ok: true, wordKey: 'k'.repeat(64) } as SaveOutcome, removeOk: true };
  const backend: ExplainBackend = {
    words: {
      lookup: (text) =>
        Promise.resolve({ saved: library.has(text), wordKey: library.get(text) ?? 'k'.repeat(64) }),
      save(snapshot, meaning, pdf) {
        saves.push({ snapshot, meaning, ...(pdf === undefined ? {} : { pdf }) });
        if (saving.outcome.ok) library.set(snapshot.text, saving.outcome.wordKey);
        return Promise.resolve(saving.outcome);
      },
      remove(wordKey) {
        removed.push(wordKey);
        if (saving.removeOk)
          for (const [text, key] of library) if (key === wordKey) library.delete(text);
        return Promise.resolve(saving.removeOk);
      },
    },
    explain(request, acknowledge) {
      return new Promise<BackendReply>((resolve) => {
        calls.push({
          request,
          acknowledge,
          reply: resolve,
          succeed: (overrides) =>
            resolve({ kind: 'result', result: resultFor(request, overrides) }),
        });
      });
    },
    cancel: (requestId) => void cancelled.push(requestId),
    openSettings: (section) => {
      settings.push(section);
      return Promise.resolve(state.settingsOpens);
    },
    openSidePanel: (handoff) => {
      handoffs.push(handoff);
      return Promise.resolve(state.panelOpens);
    },
    translationLanguage: () => Promise.resolve(state.language),
  };
  return { backend, calls, cancelled, settings, handoffs, state, saves, removed, library, saving };
}

export const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

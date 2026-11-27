import type { WordData } from '../../../shared/api-contract/records';

export const KEY_A = 'a1'.repeat(32);
export const KEY_B = 'b2'.repeat(32);

/** A valid saved word (the shared WordData shape). */
export function sampleWord(over: Partial<WordData> = {}): WordData {
  return {
    text: 'bank',
    meaning: { title: 'bank', summary: 'A financial institution.', model: 'openai/gpt-oss-20b' },
    contextBefore: 'She went to the ',
    contextAfter: ' to deposit money.',
    source: { kind: 'webpage', url: 'https://example.com/story', title: 'A story' },
    createdAt: 1_700_000_000_000,
    ...over,
  };
}

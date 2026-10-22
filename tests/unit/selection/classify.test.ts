import { describe, expect, it } from 'vitest';
import { classifySelection, countSentences, countWords } from '../../../lib/selection/classify';

describe('classifySelection', () => {
  it.each([
    ['bank', 'word'],
    ['bank.', 'word'],
    ['"bank,"', 'word'],
    ["don't", 'word'],
    ['well-known', 'word'],
    ['café', 'word'],
    ['naïve', 'word'],
    ['Москва', 'word'],
    ['bank account', 'phrase'],
    ['break the ice', 'phrase'],
    ['a stitch in time saves nine', 'phrase'],
    ['The bank was closed.', 'sentence'],
    ['Why did the bank close early today?', 'sentence'],
    ['She said "stop!"', 'sentence'],
    ['This sentence has no final punctuation but is long enough to count', 'sentence'],
    ['I went home. Then I slept.', 'passage'],
    ['Dr. Smith went home today.', 'sentence'],
    ['It costs 3.14 dollars today, which is odd.', 'sentence'],
  ] as const)('classifies %j as %s', (text, kind) => {
    expect(classifySelection(text)).toBe(kind);
  });

  it('treats more than 60 words as a passage even without sentence breaks', () => {
    expect(classifySelection(Array.from({ length: 61 }, () => 'word').join(' '))).toBe('passage');
  });

  it('treats very long text with few words as a passage', () => {
    expect(classifySelection('x'.repeat(401) + ' y')).toBe('passage');
  });

  it('segments unspaced scripts into words', () => {
    expect(classifySelection('苹果', 'zh')).toBe('word');
    expect(classifySelection('我喜欢吃苹果和香蕉', 'zh')).not.toBe('word');
    expect(classifySelection('我喜欢吃苹果。今天天气很好。', 'zh')).toBe('passage');
  });

  it('classifies right-to-left text', () => {
    expect(classifySelection('كتاب')).toBe('word');
    expect(classifySelection('هذا كتاب جميل')).toBe('phrase');
  });
});

describe('countWords', () => {
  it('stops counting early on huge input', () => {
    expect(countWords(Array.from({ length: 5000 }, () => 'w').join(' '))).toBeLessThanOrEqual(61);
  });

  it('ignores punctuation-only tokens', () => {
    expect(countWords('a — b')).toBe(2);
  });
});

describe('countSentences', () => {
  it('does not split on common abbreviations or decimals', () => {
    expect(countSentences('Mr. Jones paid 3.50 for e.g. tea.')).toBe(1);
  });

  it('splits on terminal punctuation followed by space', () => {
    expect(countSentences('One. Two! Three?')).toBe(3);
  });
});

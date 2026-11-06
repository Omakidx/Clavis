import { beforeEach, describe, expect, it } from 'vitest';
import {
  blocksToText,
  cacheKey,
  readExplainResult,
  resultBlocks,
  resultText,
  tabsFor,
  truncateText,
} from '../../../components/explanation/model';
import { installCatalog, makeSnapshot, resultFor } from './support';

beforeEach(() => installCatalog());

const OFF = { grammarTab: false, translateTab: false };
const ON = { grammarTab: true, translateTab: true };

function request(mode: Parameters<typeof resultFor>[0]['mode']) {
  return {
    requestId: '11111111-1111-4111-8111-111111111111',
    snapshot: makeSnapshot(),
    mode,
    detailLevel: 'standard' as const,
  };
}

describe('tabs per selection kind (D-05)', () => {
  it('word: Core, Roots, Related words', () => {
    expect(tabsFor('word', OFF)).toEqual(['core', 'etymology', 'related_words']);
  });
  it('phrase: Core, Roots, Related words, Simplify (an idiom has an origin and near-synonyms)', () => {
    expect(tabsFor('phrase', OFF)).toEqual(['core', 'etymology', 'related_words', 'simplify']);
  });
  it('Roots and Related words only for words and phrases, Simplify never for a word', () => {
    for (const kind of ['sentence', 'passage'] as const) {
      expect(tabsFor(kind, ON)).not.toContain('etymology');
      expect(tabsFor(kind, ON)).not.toContain('related_words');
    }
    expect(tabsFor('word', ON)).not.toContain('simplify');
  });
  it('sentence and passage: Core, Simplify (no word-only tabs)', () => {
    expect(tabsFor('sentence', OFF)).toEqual(['core', 'simplify']);
    expect(tabsFor('passage', OFF)).toEqual(['core', 'simplify']);
  });
  it('ships Translate for every kind and hides Grammar: the production default (FR-037 on, FR-036 off)', () => {
    expect(tabsFor('word')).toEqual(['core', 'etymology', 'related_words', 'translate']);
    expect(tabsFor('phrase')).toEqual([
      'core',
      'etymology',
      'related_words',
      'simplify',
      'translate',
    ]);
    expect(tabsFor('sentence')).toEqual(['core', 'simplify', 'translate']);
    expect(tabsFor('passage')).toEqual(['core', 'simplify', 'translate']);
    for (const kind of ['word', 'phrase', 'sentence', 'passage'] as const) {
      expect(tabsFor(kind)).not.toContain('grammar');
    }
  });
  it('hides both tabs when both flags are off, and Translate alone when only Grammar is on', () => {
    for (const kind of ['word', 'phrase', 'sentence', 'passage'] as const) {
      expect(tabsFor(kind, OFF)).not.toContain('grammar');
      expect(tabsFor(kind, OFF)).not.toContain('translate');
    }
    expect(tabsFor('sentence', { grammarTab: true, translateTab: false })).toEqual([
      'core',
      'simplify',
      'grammar',
    ]);
  });
  it('adds Grammar (not for a single word) and Translate when the flags are on', () => {
    expect(tabsFor('sentence', ON)).toEqual(['core', 'simplify', 'grammar', 'translate']);
    expect(tabsFor('word', ON)).toEqual(['core', 'etymology', 'related_words', 'translate']);
  });
});

describe('cache key', () => {
  it('is per selection and mode', () => {
    expect(cacheKey('a', 'core')).not.toBe(cacheKey('b', 'core'));
    expect(cacheKey('a', 'core')).not.toBe(cacheKey('a', 'etymology'));
  });
  it('includes the target language for the translation only', () => {
    expect(cacheKey('a', 'translate', 'fr')).not.toBe(cacheKey('a', 'translate', 'de'));
    expect(cacheKey('a', 'simplify', 'fr')).toBe(cacheKey('a', 'simplify', 'de'));
  });
});

describe('truncateText', () => {
  it('collapses whitespace and cuts on a character boundary', () => {
    expect(truncateText('a   b\n c')).toBe('a b c');
    const long = '😀'.repeat(100);
    const cut = truncateText(long, 10);
    expect(Array.from(cut)).toHaveLength(10);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('readExplainResult', () => {
  const good = resultFor(request('core'));

  it('accepts a valid result', () => {
    expect(readExplainResult(good)).toEqual(good);
  });
  it.each([
    ['null', null],
    ['an array', []],
    ['a missing title', { ...good, title: undefined }],
    ['an unknown mode', { ...good, mode: 'hack' }],
    ['a non-string summary', { ...good, summary: { html: '<b>x</b>' } }],
  ])('rejects %s', (_name, value) => {
    expect(readExplainResult(value)).toBeNull();
  });
  it('drops unknown keys and a malformed examples list', () => {
    const read = readExplainResult({
      ...good,
      examples: [{ sentence: 'only one' }],
      onclick: 'alert(1)',
    }) as Record<string, unknown>;
    expect(read['examples']).toBeUndefined();
    expect(read).not.toHaveProperty('onclick');
  });
});

describe('result blocks and their plain text', () => {
  it('core: title, summary, meaning, definition, two AI examples, caveat', () => {
    const blocks = resultBlocks(resultFor(request('core')));
    expect(blocks.map((block) => block.kind)).toEqual([
      'title',
      'paragraph',
      'field',
      'field',
      'list',
      'field',
    ]);
    const text = resultText(resultFor(request('core')));
    expect(text).toContain(
      'Examples written by AI:\n1. We fished from the bank. (riverside)\n2. The grass',
    );
    expect(text).toContain('Meaning here: Here it means the edge of the river');
    expect(text).toContain('Note: Other senses exist.');
  });
  it('roots mark uncertainty', () => {
    const uncertain = resultFor(request('etymology'), {
      etymology: { overview: 'Maybe from X.', confidence: 'uncertain' },
    });
    expect(resultText(uncertain)).toContain('uncertain');
  });
  it('related words say "Not applicable" for an empty list', () => {
    const text = resultText(resultFor(request('related_words')));
    expect(text).toContain('Similar words:\n- shore\n- edge');
    expect(text).toContain('Opposite words: Not applicable');
  });
  it('excludes app-written confidence and empty placeholders from recursive selection', () => {
    const roots = resultBlocks(resultFor(request('etymology')));
    expect(roots.find((block) => block.kind === 'note')).toMatchObject({ lookup: false });
    const related = resultBlocks(resultFor(request('related_words')));
    expect(related.find((block) => block.kind === 'field')).toMatchObject({ lookup: false });
    const core = resultBlocks(resultFor(request('core')));
    expect(core.every((block) => !('lookup' in block) || block.lookup !== false)).toBe(true);
  });

  it('simplify shows the rewrite', () => {
    expect(resultText(resultFor(request('simplify')))).toContain(
      'Simpler version: She finally got people talking.',
    );
  });
  it('flattens HTML-looking and Markdown-looking text unchanged (plain text only)', () => {
    const hostile = '<img src=x onerror=alert(1)> **bold** [x](javascript:alert(1))';
    const text = resultText(resultFor(request('core'), { title: hostile, summary: hostile }));
    expect(text.startsWith(`${hostile}\n\n${hostile}`)).toBe(true);
  });
  it('blocksToText has no markup of its own', () => {
    expect(
      blocksToText([
        { kind: 'title', text: 'T' },
        { kind: 'note', label: 'Note', text: 'N' },
      ]),
    ).toBe('T\n\nNote: N');
  });
});

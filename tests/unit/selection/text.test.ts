import { describe, expect, it } from 'vitest';
import { normalizeText, trimToWordBoundary, truncateText } from '../../../lib/selection/text';

describe('normalizeText', () => {
  it('collapses spaces, tabs, newlines and non-breaking spaces to single spaces', () => {
    expect(normalizeText('  the \n\t quick   fox ')).toBe('the quick fox');
  });

  it('removes soft hyphens, zero-width spaces and BOMs', () => {
    expect(normalizeText('co­op​erate﻿')).toBe('cooperate');
  });

  it('keeps zero-width joiners, which change meaning in Persian, Indic scripts and emoji', () => {
    expect(normalizeText('می‌خواهم')).toBe('می‌خواهم');
    expect(normalizeText('👨‍👩‍👧')).toBe('👨‍👩‍👧');
  });

  it('keeps punctuation and inner text unchanged', () => {
    expect(normalizeText('“Don’t,” she said — twice.')).toBe('“Don’t,” she said — twice.');
  });

  it('returns an empty string for whitespace-only input', () => {
    expect(normalizeText(' \n \t ')).toBe('');
  });
});

describe('truncateText', () => {
  it('leaves short text alone', () => {
    expect(truncateText('abc', 3)).toBe('abc');
  });

  it('cuts to the limit and trims the end', () => {
    expect(truncateText('ab cd', 3)).toBe('ab');
  });

  it('never splits a surrogate pair', () => {
    const cut = truncateText('a😀b', 2);
    expect(cut).toBe('a');
    expect(cut.length).toBeLessThanOrEqual(2);
  });
});

describe('trimToWordBoundary', () => {
  const words = (count: number): string =>
    Array.from({ length: count }, (_, i) => `w${i}`).join(' ');

  it('leaves text within the limit alone', () => {
    expect(trimToWordBoundary('one two', 7)).toBe('one two');
  });

  it('cuts on the last word boundary at or before the limit', () => {
    expect(trimToWordBoundary('alpha beta gamma delta', 18)).toBe('alpha beta gamma');
    expect(trimToWordBoundary('alpha beta gamma delta', 16)).toBe('alpha beta gamma');
  });

  it('keeps a word that ends exactly at the limit', () => {
    expect(trimToWordBoundary('alpha beta gamma', 10)).toBe('alpha beta');
  });

  it('never exceeds the limit and never ends mid-word for ordinary text', () => {
    const text = words(900);
    const out = trimToWordBoundary(text, 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
    expect(text.startsWith(out)).toBe(true);
    expect(text.charAt(out.length)).toBe(' ');
  });

  it('hard-cuts text without a nearby boundary (one long token, unspaced scripts)', () => {
    expect(trimToWordBoundary('a'.repeat(50), 20)).toBe('a'.repeat(20));
    expect(trimToWordBoundary(`short ${'x'.repeat(60)}`, 30)).toBe(`short ${'x'.repeat(24)}`);
    // Unspaced script: cut at a WORD boundary found by the segmenter (no space to look for).
    const cjk = '日本語'.repeat(30);
    expect(trimToWordBoundary(cjk, 10)).toBe('日本語'.repeat(3));
  });

  it('does not split a surrogate pair', () => {
    const out = trimToWordBoundary('😀'.repeat(20), 11);
    expect(out).toBe('😀'.repeat(5));
    expect(out.length).toBe(10);
  });

  // Every case: no space to cut at, so the cut falls inside a long run of clusters.
  const clusters: Array<[string, string]> = [
    ['skin-tone modifier', '👍🏽'],
    ['flag (regional indicators)', '🇫🇷'],
    ['emoji with variation selector', '❤️'],
    ['joined family emoji', '👨\u200d👩\u200d👧'],
    ['base plus combining acute', 'e\u0301'],
    ['astral combining mark', 'a\u{1D165}'],
    ['Hangul jamo sequence', '\u1112\u1161\u11ab'],
  ];
  it.each(clusters)('never cuts inside a cluster: %s', (_name, cluster) => {
    const text = cluster.repeat(40);
    for (const max of [7, 8, 9, 10, 11, 12, 13]) {
      const out = trimToWordBoundary(text, max);
      expect(out.length, `max ${max}`).toBeLessThanOrEqual(max);
      expect(out, `max ${max}`).not.toBe('');
      // Whole copies of the cluster only (unless one cluster is longer than the limit).
      if (max >= cluster.length) {
        expect(out.length % cluster.length, `max ${max}`).toBe(0);
        expect(cluster.repeat(out.length / cluster.length)).toBe(out);
      }
    }
  });

  it('one cluster longer than the limit still returns something (never empty)', () => {
    const out = trimToWordBoundary(`a${'\u0301'.repeat(50)}tail`, 20);
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(20);
    // The fallback cut is between code points: no lone surrogate.
    expect(trimToWordBoundary('😀'.repeat(30), 1)).not.toMatch(/[\ud800-\udfff]/);
  });

  it('cuts Thai text between words, not inside one', () => {
    const thai = 'สวัสดีครับวันนี้อากาศดีมากเลย'.repeat(6);
    const out = trimToWordBoundary(thai, 40);
    const words = [...new Intl.Segmenter('th', { granularity: 'word' }).segment(thai)];
    const ends = new Set(words.map((w) => w.index + w.segment.length));
    expect(out.length).toBeLessThanOrEqual(40);
    expect(ends.has(out.length)).toBe(true);
  });

  it('trims trailing space and returns an empty string for a limit of zero', () => {
    expect(trimToWordBoundary('alpha  beta', 6)).toBe('alpha');
    expect(trimToWordBoundary('alpha', 0)).toBe('');
  });
});

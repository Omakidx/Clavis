import { describe, expect, it } from 'vitest';
import { normalizeText, truncateText } from '../../../lib/selection/text';

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

import { describe, expect, it } from 'vitest';
import {
  IDLE_FIND,
  findStateName,
  isNewSearch,
  summarizeFind,
  type FindStatus,
} from '../../../lib/pdf/find';

const status = (over: Partial<FindStatus>): FindStatus => ({ ...IDLE_FIND, ...over });

describe('findStateName', () => {
  it.each([
    [0, 'found'],
    [1, 'not-found'],
    [2, 'wrapped'],
    [3, 'pending'],
    [99, 'found'],
  ] as const)('maps PDF.js state %i to %s', (n, name) => {
    expect(findStateName(n)).toBe(name);
  });
});

describe('summarizeFind', () => {
  it('shows nothing for an empty or blank query, whatever the controller last said', () => {
    expect(summarizeFind(status({ state: 'not-found' }), '')).toEqual({ kind: 'none' });
    expect(summarizeFind(status({ state: 'found', current: 1, total: 3 }), '   ')).toEqual({
      kind: 'none',
    });
  });

  it('reports pending, not-found and counts', () => {
    expect(summarizeFind(status({ state: 'pending' }), 'a')).toEqual({ kind: 'pending' });
    expect(summarizeFind(status({ state: 'not-found' }), 'a')).toEqual({ kind: 'not-found' });
    expect(summarizeFind(status({ state: 'found', current: 2, total: 5 }), 'a')).toEqual({
      kind: 'count',
      current: 2,
      total: 5,
      wrapped: false,
    });
  });

  it('flags a search that wrapped past the end of the document', () => {
    expect(summarizeFind(status({ state: 'wrapped', current: 1, total: 5 }), 'a')).toMatchObject({
      kind: 'count',
      wrapped: true,
    });
  });

  it('shows nothing while found-but-uncounted (no total yet)', () => {
    expect(summarizeFind(status({ state: 'found' }), 'a')).toEqual({ kind: 'none' });
  });
});

describe('isNewSearch', () => {
  const base = { query: 'bank', caseSensitive: false };
  it('starts a search for the first non-blank query', () => {
    expect(isNewSearch(null, base)).toBe(true);
    expect(isNewSearch(null, { query: '  ', caseSensitive: false })).toBe(false);
  });

  it('re-runs only when the query or the case option changed', () => {
    expect(isNewSearch(base, { ...base })).toBe(false);
    expect(isNewSearch(base, { ...base, query: 'banks' })).toBe(true);
    expect(isNewSearch(base, { ...base, caseSensitive: true })).toBe(true);
  });
});

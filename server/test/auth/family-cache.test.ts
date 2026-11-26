import { describe, expect, it } from 'vitest';
import { FamilyCache } from '../../src/auth/family-cache';
import { makeClock } from './harness';

describe('FamilyCache', () => {
  it('does not let a DB read that raced an eviction overwrite it', () => {
    const clock = makeClock();
    const c = new FamilyCache(clock.now);
    const gen = c.begin(); // read starts, sees "active"...
    c.evict('fam'); // ...logout lands before the read returns...
    c.set('fam', true, gen); // ...the stale result must be dropped
    expect(c.get('fam')).toBe(false);
  });

  it('caches a read that no eviction interleaved with, for at most 30 s', () => {
    const clock = makeClock();
    const c = new FamilyCache(clock.now);
    c.set('fam', true, c.begin());
    expect(c.get('fam')).toBe(true);
    clock.advance(30_001);
    expect(c.get('fam')).toBeUndefined();
  });

  it('an eviction of another family only skips caching, never serves stale data', () => {
    const c = new FamilyCache(makeClock().now);
    const gen = c.begin();
    c.evict('other');
    c.set('fam', true, gen);
    expect(c.get('fam')).toBeUndefined();
  });
});

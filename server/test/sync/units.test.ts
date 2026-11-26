import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor } from '../../src/http/pagination';
import { sanitizeSourceUrl } from '../../src/sync/apply';
import { canonicalJson, hashBody, isItemDataError } from '../../src/sync/push';

describe('canonicalJson / hashBody', () => {
  it('is independent of key order but not of values or array order', () => {
    expect(canonicalJson({ b: 1, a: [1, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [1, { c: 2, d: 1 }], b: 1 }),
    );
    expect(hashBody({ a: 1 }).equals(hashBody({ a: 1 }))).toBe(true);
    expect(hashBody({ a: 1 }).equals(hashBody({ a: 2 }))).toBe(false);
    expect(hashBody([1, 2]).equals(hashBody([2, 1]))).toBe(false);
  });
});

describe('canonicalJson depth cap', () => {
  it('throws a RangeError instead of overflowing the stack', () => {
    const deep = JSON.parse('['.repeat(30) + ']'.repeat(30));
    expect(() => canonicalJson(deep)).not.toThrow();
    let v: unknown = [];
    for (let i = 0; i < 100_000; i++) v = [v];
    expect(() => canonicalJson(v)).toThrow(RangeError);
  });
});

describe('isItemDataError', () => {
  it('blames the item for data errors and unserialisable values, not for infrastructure failures', () => {
    expect(isItemDataError({ cause: { code: '22P02' } })).toBe(true);
    expect(isItemDataError({ cause: { code: '23514' } })).toBe(true);
    expect(isItemDataError(new RangeError('Invalid time value'))).toBe(true);
    expect(isItemDataError({ cause: new RangeError('Invalid time value') })).toBe(true);
    expect(isItemDataError({ cause: { code: '40001' } })).toBe(false);
    expect(isItemDataError({ cause: { code: '57P01' } })).toBe(false);
    expect(isItemDataError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isItemDataError(new Error('boom'))).toBe(false);
  });
});

describe('keyset cursors', () => {
  it('rejects a sort key beyond year 9999', () => {
    const id = 'a'.repeat(64);
    const tamper = (k: number) => Buffer.from(JSON.stringify([k, id])).toString('base64url');
    expect(decodeCursor(tamper(253_402_300_799_999)).sortKey).toBe(253_402_300_799_999);
    for (const k of [253_402_300_800_000, 9e15, Number.MAX_SAFE_INTEGER]) {
      expect(() => decodeCursor(tamper(k)), String(k)).toThrow();
    }
  });

  it('round-trips and rejects anything malformed', () => {
    const id = 'a'.repeat(64);
    expect(decodeCursor(encodeCursor(1_700_000_000_000, id))).toEqual({
      sortKey: 1_700_000_000_000,
      id,
    });
    for (const bad of [
      '',
      '%%%',
      Buffer.from('{}').toString('base64url'),
      Buffer.from('[1]').toString('base64url'),
      Buffer.from('[-1,"' + id + '"]').toString('base64url'),
      Buffer.from('[1,"zz"]').toString('base64url'),
    ]) {
      expect(() => decodeCursor(bad), bad).toThrow();
    }
  });
});

describe('sanitizeSourceUrl', () => {
  it('keeps origin + path of http(s) URLs only', () => {
    expect(sanitizeSourceUrl('https://example.test/a/b?x=1#y')).toBe('https://example.test/a/b');
    expect(sanitizeSourceUrl('http://example.test')).toBe('http://example.test/');
    expect(sanitizeSourceUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeSourceUrl('data:text/html,x')).toBeUndefined();
    expect(sanitizeSourceUrl('not a url')).toBeUndefined();
  });
});

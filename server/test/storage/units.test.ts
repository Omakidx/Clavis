import { describe, expect, it } from 'vitest';
import { attachmentName } from '../../src/documents/file-routes';
import { RateLimiter, perDay } from '../../src/http/rate-limit';

describe('attachmentName', () => {
  const fp = 'a'.repeat(64);
  it('falls back to the fingerprint and never carries path, quote or header-breaking characters', () => {
    expect(attachmentName(null, fp)).toBe(`${fp}.pdf`);
    expect(attachmentName('日本語', fp)).toBe(`${fp}.pdf`);
    expect(attachmentName('../../etc/passwd', fp)).toBe('_.._etc_passwd.pdf');
    for (const evil of ['a"b\r\nSet-Cookie: x=1', 'x/y\\z', 'a;b"c']) {
      const n = attachmentName(evil, fp);
      expect(n).toMatch(/^[A-Za-z0-9 ._-]+\.pdf$/);
    }
    expect(attachmentName('Report.PDF', fp)).toBe('Report.pdf');
    expect(attachmentName('x'.repeat(500), fp).length).toBeLessThanOrEqual(104);
  });
});

describe('RateLimiter byte costs', () => {
  it('spends tokens by cost, refuses an unaffordable cost and never admits cost above the limit', () => {
    let t = 0;
    const l = new RateLimiter(() => t);
    const rule = perDay(1000);
    expect(l.take('k', rule, 600)).toBe(0);
    expect(l.take('k', rule, 600)).toBeGreaterThan(0);
    expect(l.take('k', rule, 400)).toBe(0);
    expect(l.take('k', rule, 1)).toBeGreaterThan(0);
    t += 86_400_000;
    expect(l.take('k', rule, 1000)).toBe(0);
    expect(l.take('z', rule, 1001)).toBeGreaterThan(0);
  });
});

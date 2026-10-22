import { describe, expect, it } from 'vitest';
import { checkNewSite, normalizeHostname } from '../../../lib/ui-client/hostnames';

describe('normalizeHostname', () => {
  it.each([
    ['example.com', 'example.com'],
    ['  EXAMPLE.com ', 'example.com'],
    ['https://www.Example.com/path?q=1#x', 'www.example.com'],
    ['example.com:8080/a', 'example.com'],
    ['http://sub.example.co.uk.', 'sub.example.co.uk'],
    ['localhost', 'localhost'],
    ['münchen.de', 'xn--mnchen-3ya.de'],
    ['192.168.1.1', '192.168.1.1'],
    ['http://10.0.0.5:3000/app', '10.0.0.5'],
  ])('accepts %s as %s', (input, expected) => {
    expect(normalizeHostname(input)).toEqual({ ok: true, host: expected });
  });

  it.each([
    '',
    'exa mple.com',
    'example',
    'ftp://example.com',
    'user@example.com',
    'https://user:pw@example.com',
    '999.1.1',
    '[::1]',
    'exa_mple.com',
    '-bad.com',
    'a'.repeat(300) + '.com',
    '<script>alert(1)</script>',
  ])('rejects %j', (input) => {
    expect(normalizeHostname(input).ok).toBe(false);
  });
});

describe('checkNewSite', () => {
  it('reports empty, invalid, duplicate and full-list cases separately', () => {
    expect(checkNewSite('  ', [])).toEqual({ ok: false, reason: 'empty' });
    expect(checkNewSite('nope', [])).toEqual({ ok: false, reason: 'invalid' });
    expect(checkNewSite('HTTPS://Example.com/x', ['example.com'])).toEqual({
      ok: false,
      reason: 'duplicate',
    });
    const full = Array.from({ length: 500 }, (_, i) => `s${i}.example.com`);
    expect(checkNewSite('new.example.com', full)).toEqual({ ok: false, reason: 'limit' });
    expect(checkNewSite('new.example.com', ['a.com'])).toEqual({
      ok: true,
      host: 'new.example.com',
    });
  });
});

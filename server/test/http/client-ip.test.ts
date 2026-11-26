import type { Context } from 'hono';
import { describe, expect, it } from 'vitest';
import { clientIp, normalizeIp, type ClientIpSource } from '../../src/http/rate-limit';

function ctx(headers: Record<string, string>, peer = '10.0.0.9'): Context {
  return {
    req: { header: (n: string) => headers[n.toLowerCase()] },
    env: { incoming: { socket: { remoteAddress: peer } } },
  } as unknown as Context;
}
const xff = (hops = 1, trustProxy = true): ClientIpSource => ({
  trustProxy,
  clientIpHeader: 'xff-rightmost',
  trustedProxyHops: hops,
});
const real: ClientIpSource = { trustProxy: true, clientIpHeader: 'x-real-ip', trustedProxyHops: 1 };

describe('normalizeIp', () => {
  it('keeps IPv4 and unwraps IPv4-mapped IPv6', () => {
    expect(normalizeIp('203.0.113.7')).toBe('203.0.113.7');
    expect(normalizeIp('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });
  it('groups IPv6 by /64', () => {
    const a = normalizeIp('2001:db8:aaaa:bbbb:1:2:3:4');
    expect(a).toBe('2001:db8:aaaa:bbbb::/64');
    expect(normalizeIp('2001:0db8:aaaa:bbbb:ffff:ffff:ffff:ffff')).toBe(a);
    expect(normalizeIp('2001:db8:aaaa:bbbb::9')).toBe(a);
    expect(normalizeIp('[2001:db8:aaaa:bbbb::9]')).toBe(a);
    expect(normalizeIp('2001:db8:aaaa:cccc::9')).not.toBe(a);
    expect(normalizeIp('::1')).toBe('0:0:0:0::/64');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80:0:0:0::/64');
  });
  it('rejects garbage', () => {
    for (const bad of ['', 'unknown', '1.2.3', '999.1.1.1', 'a, b', '1.2.3.4:80']) {
      expect(normalizeIp(bad), bad).toBeUndefined();
    }
  });
});

describe('clientIp', () => {
  it('ignores forwarding headers without proxy trust', () => {
    expect(
      clientIp(ctx({ 'x-forwarded-for': '1.1.1.1', 'x-real-ip': '2.2.2.2' }), xff(1, false)),
    ).toBe('10.0.0.9');
  });

  it('xff-rightmost takes the entry our proxy appended, so a spoofed left side is ignored', () => {
    const c = ctx({ 'x-forwarded-for': '6.6.6.6, 7.7.7.7, 198.51.100.4' });
    expect(clientIp(c, xff(1))).toBe('198.51.100.4');
  });

  it('honours the hop count (two trusted proxies)', () => {
    const c = ctx({ 'x-forwarded-for': '6.6.6.6, 198.51.100.4, 100.64.0.2' });
    expect(clientIp(c, xff(2))).toBe('198.51.100.4');
  });

  it('falls back to the socket peer when the header is missing, short or invalid', () => {
    expect(clientIp(ctx({}), xff(1))).toBe('10.0.0.9');
    expect(clientIp(ctx({ 'x-forwarded-for': '198.51.100.4' }), xff(2))).toBe('10.0.0.9');
    expect(clientIp(ctx({ 'x-forwarded-for': 'garbage' }), xff(1))).toBe('10.0.0.9');
  });

  it('x-real-ip mode uses that header only', () => {
    const c = ctx({ 'x-real-ip': '198.51.100.8', 'x-forwarded-for': '1.1.1.1' });
    expect(clientIp(c, real)).toBe('198.51.100.8');
    expect(clientIp(ctx({ 'x-forwarded-for': '1.1.1.1' }), real)).toBe('10.0.0.9');
    expect(clientIp(ctx({ 'x-real-ip': 'nope' }), real)).toBe('10.0.0.9');
  });

  it('groups IPv6 clients by /64 in both modes', () => {
    const a = clientIp(ctx({ 'x-forwarded-for': '2001:db8:1:2:aaaa::1' }), xff(1));
    const b = clientIp(ctx({ 'x-forwarded-for': '2001:db8:1:2:bbbb::9' }), xff(1));
    expect(a).toBe(b);
    expect(clientIp(ctx({ 'x-real-ip': '2001:db8:1:2:cccc::5' }), real)).toBe(a);
    expect(clientIp(ctx({}, '2001:db8:1:2:1::1'), xff(1, false))).toBe(a);
  });
});

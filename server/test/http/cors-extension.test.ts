import { describe, expect, it } from 'vitest';
import { EXT_ORIGIN, OTHER_EXT_ID, createHarness } from '../auth/harness';

// The real extension (dev ID from ALLOWED_EXTENSION_IDS) calls these cross-origin with a Bearer token.
const ROUTES: Array<[string, string]> = [
  ['POST', '/v1/sync/push'],
  ['POST', '/v1/sync/pull'],
  ['GET', '/v1/words'],
  ['POST', '/v1/words'],
  ['DELETE', '/v1/words/abc'],
  ['GET', '/v1/documents'],
  ['DELETE', '/v1/documents/' + 'a'.repeat(64)],
  ['PUT', '/v1/documents/' + 'a'.repeat(64) + '/file'],
  ['GET', '/v1/account'],
  ['POST', '/v1/account/logout-all'],
  ['DELETE', '/v1/account'],
  ['GET', '/v1/meta'],
  ['POST', '/v1/auth/extension/google'],
  ['POST', '/v1/auth/extension/refresh'],
  ['POST', '/v1/auth/extension/logout'],
];

const tokens = (v: string | null) => (v ?? '').split(',').map((s) => s.trim().toLowerCase());

describe('CORS for the extension origin', () => {
  it.each(ROUTES)('preflight %s %s is allowed for the dev extension', async (method, path) => {
    const h = await createHarness();
    const res = await h.app.request(path, {
      method: 'OPTIONS',
      headers: {
        origin: EXT_ORIGIN,
        'access-control-request-method': method,
        'access-control-request-headers':
          'authorization,content-type,idempotency-key,x-clavis-title',
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(EXT_ORIGIN);
    expect(tokens(res.headers.get('access-control-allow-methods'))).toContain(method.toLowerCase());
    const headers = tokens(res.headers.get('access-control-allow-headers'));
    for (const hd of ['authorization', 'content-type', 'idempotency-key', 'x-clavis-title']) {
      expect(headers).toContain(hd);
    }
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('vary')).toMatch(/Origin/i);
  });

  it('refuses a preflight from another extension and from a web origin', async () => {
    const h = await createHarness();
    for (const origin of [`chrome-extension://${OTHER_EXT_ID}`, 'https://evil.test']) {
      const res = await h.app.request('/v1/sync/push', {
        method: 'OPTIONS',
        headers: { origin, 'access-control-request-method': 'POST' },
      });
      expect(res.status, origin).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('actual responses (including errors) carry the allow-origin header', async () => {
    const h = await createHarness();
    for (const path of ['/v1/meta', '/v1/sync/pull']) {
      const res = await h.app.request(path, {
        method: path.endsWith('pull') ? 'POST' : 'GET',
        headers: { origin: EXT_ORIGIN },
      });
      expect(res.headers.get('access-control-allow-origin'), path).toBe(EXT_ORIGIN);
    }
  });
});

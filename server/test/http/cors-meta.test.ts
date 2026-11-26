import { describe, expect, it } from 'vitest';
import { MetaResponse } from '../../../shared/api-contract';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createLogger } from '../../src/logger';
import {
  DEV_EXT_ID,
  EXT_ORIGIN,
  OTHER_EXT_ID,
  STORE_EXT_ID,
  createHarness,
  postJson,
} from '../auth/harness';

describe('GET /v1/meta', () => {
  it('returns the contract shape, no-store', async () => {
    const h = await createHarness();
    const res = await h.app.request('/v1/meta');
    expect(res.status).toBe(200);
    expect(MetaResponse.safeParse(await res.json()).success).toBe(true);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is rate limited to 60/min/IP with RATE_LIMITED and retryAfterMs', async () => {
    const h = await createHarness();
    for (let i = 0; i < 60; i++) expect((await h.app.request('/v1/meta')).status).toBe(200);
    const res = await h.app.request('/v1/meta');
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error: { code: string; retryAfterMs: number } };
    expect(body.error.code).toBe('RATE_LIMITED');
    expect(body.error.retryAfterMs).toBeGreaterThan(0);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    h.clock.advance(2000);
    expect((await h.app.request('/v1/meta')).status).toBe(200);
  });

  it('keys on the proxy-appended X-Forwarded-For entry only with TRUST_PROXY', async () => {
    const h = await createHarness({ env: { TRUST_PROXY: '1' } });
    const hit = (ip: string) =>
      h.app.request('/v1/meta', { headers: { 'x-forwarded-for': `6.6.6.6, ${ip}` } });
    for (let i = 0; i < 60; i++) await hit('1.1.1.1');
    expect((await hit('1.1.1.1')).status).toBe(429);
    expect((await hit('2.2.2.2')).status).toBe(200);
  });
});

describe('CORS on Bearer routes', () => {
  const preflight = (
    h: Awaited<ReturnType<typeof createHarness>>,
    origin: string,
    path = '/v1/account',
  ) =>
    h.app.request(path, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization',
      },
    });

  it('allows each configured extension id, exactly, with no credentials and no wildcard', async () => {
    const h = await createHarness();
    for (const id of [DEV_EXT_ID, STORE_EXT_ID]) {
      const res = await preflight(h, `chrome-extension://${id}`);
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(`chrome-extension://${id}`);
      expect(res.headers.get('access-control-allow-headers')).toBe(
        'Authorization, Content-Type, Idempotency-Key',
      );
      expect(res.headers.get('access-control-max-age')).toBe('600');
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
      expect(res.headers.get('vary')).toContain('Origin');
    }
  });

  it('rejects another extension id, web origins, null and a near-miss id', async () => {
    const h = await createHarness();
    for (const origin of [
      `chrome-extension://${OTHER_EXT_ID}`,
      `chrome-extension://${DEV_EXT_ID}x`,
      `chrome-extension://${DEV_EXT_ID}/`,
      'https://evil.test',
      'https://clavis-api-production.up.railway.app',
      'null',
      '*',
    ]) {
      const res = await preflight(h, origin);
      expect(res.status, origin).toBe(403);
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    }
  });

  it('adds headers to real responses only for allowed origins', async () => {
    const h = await createHarness();
    const ok = await h.app.request('/v1/meta', { headers: { origin: EXT_ORIGIN } });
    expect(ok.headers.get('access-control-allow-origin')).toBe(EXT_ORIGIN);
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
    const bad = await h.app.request('/v1/meta', {
      headers: { origin: `chrome-extension://${OTHER_EXT_ID}` },
    });
    expect(bad.headers.get('access-control-allow-origin')).toBeNull();
    const none = await h.app.request('/v1/meta');
    expect(none.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('keeps CORS headers on error responses', async () => {
    const h = await createHarness();
    const res = await postJson(
      h,
      '/v1/auth/extension/refresh',
      { nope: 1 },
      { origin: EXT_ORIGIN },
    );
    expect(res.status).toBe(503); // no database in this harness
    expect(res.headers.get('access-control-allow-origin')).toBe(EXT_ORIGIN);
  });

  it('never sends CORS headers on the cookie-only dashboard routes', async () => {
    const h = await createHarness();
    const res = await h.app.request('/v1/session', {
      headers: { origin: EXT_ORIGIN },
    });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    const pre = await preflight(h, EXT_ORIGIN, '/v1/session');
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('auth routes when not configured', () => {
  it('answer 503 UNAVAILABLE instead of 404', async () => {
    const app = createApp({ config: loadConfig({}), logger: createLogger('silent') });
    for (const p of [
      '/v1/session',
      '/v1/account',
      '/auth/google/start',
      '/v1/auth/extension/google',
    ]) {
      const res = await app.request(p);
      expect(res.status, p).toBe(503);
      expect(await res.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
    }
  });

  it('/v1/meta still works', async () => {
    const app = createApp({ config: loadConfig({}), logger: createLogger('silent') });
    expect((await app.request('/v1/meta')).status).toBe(200);
  });
});

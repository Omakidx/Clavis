import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createLogger } from '../src/logger';

const logger = createLogger('silent');
const config = loadConfig({});

describe('health routes', () => {
  it('/healthz is 200 without a database', async () => {
    const res = await createApp({ config, logger }).request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('/readyz is 503 with the error envelope when no database is configured', async () => {
    const res = await createApp({ config, logger }).request('/readyz');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: { code: 'UNAVAILABLE' } });
  });

  it('/readyz is 200 when the database answers and 503 when it does not', async () => {
    const ping = vi.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const app = createApp({ config, logger, db: { ping } });
    expect((await app.request('/readyz')).status).toBe(200);
    ping.mockResolvedValue(false);
    expect((await app.request('/readyz')).status).toBe(503);
  });

  it('unknown API paths get the JSON 404 envelope', async () => {
    const res = await createApp({ config, logger }).request('/v1/nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'NOT_FOUND' } });
  });
});

describe('dashboard static serving', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'clavis-dash-'));
  mkdirSync(path.join(dir, 'assets'));
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Clavis</title>');
  writeFileSync(path.join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
  mkdirSync(path.join(dir, 'privacy'));
  writeFileSync(
    path.join(dir, 'privacy', 'index.html'),
    '<!doctype html><title>Clavis privacy policy</title>',
  );
  const app = createApp({ config, logger, dashboardDir: dir });

  it('serves index.html at / with security headers', async () => {
    const res = await app.request('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Clavis</title>');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('serves hashed assets as immutable', async () => {
    const res = await app.request('/assets/app-abc.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  it('falls back to index.html for SPA routes', async () => {
    const res = await app.request('/words/abc');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>Clavis</title>');
  });

  it('serves the static privacy page at /privacy and /privacy/, not the SPA shell', async () => {
    for (const p of ['/privacy', '/privacy/']) {
      const res = await app.request(p);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(await res.text()).toContain('<title>Clavis privacy policy</title>');
      expect(res.headers.get('cache-control')).toBe('public, max-age=300');
      expect(res.headers.get('content-security-policy')).toContain("style-src 'self'");
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    }
    const head = await app.request('/privacy', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect((await app.request('/privacy', { method: 'POST' })).status).toBe(404);
  });

  it('keeps the SPA fallback for other unknown paths, including look-alikes of /privacy', async () => {
    for (const p of ['/privacy-policy', '/privacyx', '/privacy/other']) {
      const res = await app.request(p);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<title>Clavis</title>');
    }
  });

  it('404s /privacy (no SPA shell) when the page was not built', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'clavis-dash-'));
    writeFileSync(path.join(empty, 'index.html'), '<!doctype html><title>Clavis</title>');
    const res = await createApp({ config, logger, dashboardDir: empty }).request('/privacy');
    expect(res.status).toBe(404);
  });

  it('404s a missing file that has an extension', async () => {
    expect((await app.request('/assets/missing.js')).status).toBe(404);
  });

  it('never lets the SPA fallback shadow API paths', async () => {
    for (const p of ['/v1/anything', '/v1', '/auth/google/start', '/readyz', '/healthz/x']) {
      const res = await app.request(p);
      expect(res.headers.get('content-type')).toContain('application/json');
    }
    expect((await app.request('/v1/anything')).status).toBe(404);
  });

  it('does not allow path traversal or serve on non-GET', async () => {
    expect((await app.request('/..%2f..%2fetc/passwd')).headers.get('content-type')).not.toContain(
      'text/html',
    );
    // The URL parser resolves dot segments, so this is just an SPA route: it must serve index.html, not a file.
    const traversal = await app.request('/%2e%2e/%2e%2e/etc/passwd');
    expect(await traversal.text()).toContain('<title>Clavis</title>');
    expect((await app.request('/', { method: 'POST' })).status).toBe(404);
  });
});

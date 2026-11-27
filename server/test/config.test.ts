import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const secretOf = (l: string) => createHash('sha256').update(l).digest('base64');
const B64_32 = secretOf('s7');
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

const PROD_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db.internal:5432/clavis',
  GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'secret',
  ALLOWED_EXTENSION_IDS: EXT_ID,
  TOKEN_SIGNING_SECRET: secretOf('s1'),
  STATE_COOKIE_SECRET: secretOf('s2'),
  TRUST_PROXY: '1',
  PUBLIC_ORIGIN: 'https://clavis-api-production.up.railway.app',
};

describe('loadConfig', () => {
  it('requires TRUST_PROXY=1 in production', () => {
    const env: Record<string, string> = { ...PROD_ENV };
    delete env['TRUST_PROXY'];
    expect(() => loadConfig(env)).toThrow(/TRUST_PROXY: must be 1 in production/);
    expect(() => loadConfig({ ...env, TRUST_PROXY: '0' })).toThrow(/TRUST_PROXY/);
    expect(loadConfig(PROD_ENV).trustProxy).toBe(true);
    expect(() => loadConfig({})).not.toThrow(); // dev stays ergonomic
  });

  it('client IP source: safest default, validated override and hop count', () => {
    const d = loadConfig({});
    expect(d.clientIpHeader).toBe('xff-rightmost');
    expect(d.trustedProxyHops).toBe(1);
    expect(loadConfig({ CLIENT_IP_HEADER: 'x-real-ip', TRUSTED_PROXY_HOPS: '2' })).toMatchObject({
      clientIpHeader: 'x-real-ip',
      trustedProxyHops: 2,
    });
    expect(() => loadConfig({ CLIENT_IP_HEADER: 'x-evil' })).toThrow(/CLIENT_IP_HEADER/);
    expect(() => loadConfig({ TRUSTED_PROXY_HOPS: '0' })).toThrow(/TRUSTED_PROXY_HOPS/);
  });

  it('rejects low-entropy secrets (repeated byte) without echoing them', () => {
    const weak = Buffer.alloc(32, 65).toString('base64');
    for (const name of [
      'TOKEN_SIGNING_SECRET',
      'STATE_COOKIE_SECRET',
      'TOKEN_SIGNING_SECRET_PREVIOUS',
    ]) {
      let msg = '';
      try {
        loadConfig({ [name]: weak });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toMatch(new RegExp(`${name}: looks low-entropy`));
      expect(msg).not.toContain(weak);
    }
  });

  it('TOKEN_SIGNING_SECRET_PREVIOUS must differ from both other secrets', () => {
    const a = secretOf('a');
    const b = secretOf('b');
    expect(() => loadConfig({ TOKEN_SIGNING_SECRET: a, TOKEN_SIGNING_SECRET_PREVIOUS: a })).toThrow(
      /TOKEN_SIGNING_SECRET_PREVIOUS: must differ from TOKEN_SIGNING_SECRET/,
    );
    expect(() => loadConfig({ STATE_COOKIE_SECRET: b, TOKEN_SIGNING_SECRET_PREVIOUS: b })).toThrow(
      /TOKEN_SIGNING_SECRET_PREVIOUS: must differ from STATE_COOKIE_SECRET/,
    );
    expect(() =>
      loadConfig({
        TOKEN_SIGNING_SECRET: a,
        STATE_COOKIE_SECRET: b,
        TOKEN_SIGNING_SECRET_PREVIOUS: secretOf('c'),
      }),
    ).not.toThrow();
  });

  it('requires every auth variable in production, naming each missing one without values', () => {
    for (const name of [
      'DATABASE_URL',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'ALLOWED_EXTENSION_IDS',
      'TOKEN_SIGNING_SECRET',
      'STATE_COOKIE_SECRET',
    ]) {
      const env: Record<string, string> = { ...PROD_ENV };
      delete env[name];
      expect(() => loadConfig(env)).toThrow(new RegExp(`${name}: is required in production`));
    }
    expect(() => loadConfig(PROD_ENV)).not.toThrow();
  });

  it('rejects reusing one secret for tokens and the state cookie', () => {
    const s = secretOf('s9');
    expect(() => loadConfig({ TOKEN_SIGNING_SECRET: s, STATE_COOKIE_SECRET: s })).toThrow(
      /STATE_COOKIE_SECRET/,
    );
  });

  it('accepts an empty environment with defaults', () => {
    const c = loadConfig({});
    expect(c.nodeEnv).toBe('development');
    expect(c.port).toBe(8787);
    expect(c.databaseUrl).toBeUndefined();
    expect(c.jobsEnabled).toBe(true);
    expect(c.trustProxy).toBe(false);
    expect(c.s3).toBeUndefined();
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ DATABASE_URL: '', PORT: '', TOKEN_SIGNING_SECRET: '' }).port).toBe(8787);
  });

  it('derives extension origins and redirects from ALLOWED_EXTENSION_IDS', () => {
    const other = 'ponmlkjihgfedcbaponmlkjihgfedcba'.slice(0, 32);
    const c = loadConfig({ ALLOWED_EXTENSION_IDS: ` ${EXT_ID}, ${other},${EXT_ID}` });
    expect(c.allowedExtensionIds).toEqual([EXT_ID, other]);
    expect(c.allowedExtensionOrigins).toEqual([
      `chrome-extension://${EXT_ID}`,
      `chrome-extension://${other}`,
    ]);
    expect(c.allowedExtensionRedirects[0]).toBe(`https://${EXT_ID}.chromiumapp.org/`);
  });

  it('rejects malformed extension IDs', () => {
    expect(() => loadConfig({ ALLOWED_EXTENSION_IDS: 'short' })).toThrow(ConfigError);
  });

  it('requires an https PUBLIC_ORIGIN in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/PUBLIC_ORIGIN/);
    expect(() => loadConfig({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://x.example' })).toThrow(
      /https/,
    );
    const c = loadConfig({
      ...PROD_ENV,
      PUBLIC_ORIGIN: 'https://clavis-api-production.up.railway.app/',
    });
    expect(c.publicOrigin).toBe('https://clavis-api-production.up.railway.app');
  });

  it('rejects a PUBLIC_ORIGIN with a path', () => {
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'http://localhost:8787/app' })).toThrow(/bare origin/);
  });

  it('rejects short signing secrets and non-postgres database URLs', () => {
    expect(() => loadConfig({ TOKEN_SIGNING_SECRET: 'tooshort' })).toThrow(/TOKEN_SIGNING_SECRET/);
    expect(() => loadConfig({ DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
    expect(loadConfig({ TOKEN_SIGNING_SECRET: B64_32 }).tokenSigningSecret).toBe(B64_32);
  });

  it('requires the S3 variables together', () => {
    expect(() => loadConfig({ S3_BUCKET: 'b' })).toThrow(/set together/);
    const c = loadConfig({
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'b',
      S3_ACCESS_KEY_ID: 'k',
      S3_SECRET_ACCESS_KEY: 's',
      S3_FORCE_PATH_STYLE: '1',
    });
    expect(c.s3).toMatchObject({ bucket: 'b', forcePathStyle: true, region: 'auto' });
  });

  it('never echoes secret values in errors', () => {
    const secret = 'super-secret-value-that-is-not-base64!!';
    let message = '';
    try {
      loadConfig({
        TOKEN_SIGNING_SECRET: secret,
        STATE_COOKIE_SECRET: secret,
        DATABASE_URL: `bad://${secret}`,
      });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain('TOKEN_SIGNING_SECRET');
    expect(message).not.toContain(secret);
  });

  it('rejects invalid flags and ports', () => {
    expect(() => loadConfig({ TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
    expect(() => loadConfig({ PORT: '70000' })).toThrow(/PORT/);
  });
});

describe('Google endpoint overrides (dev/e2e only)', () => {
  const OVERRIDES = {
    GOOGLE_AUTH_URL: 'http://127.0.0.1:8788/authorize',
    GOOGLE_TOKEN_URL: 'http://127.0.0.1:8788/token',
    GOOGLE_JWKS_URL: 'http://127.0.0.1:8788/jwks',
    GOOGLE_ISSUER: 'http://127.0.0.1:8788',
  };

  it('defaults to undefined (real Google) and parses overrides outside production', () => {
    expect(loadConfig({}).googleEndpoints).toBeUndefined();
    expect(loadConfig({ NODE_ENV: 'development', ...OVERRIDES }).googleEndpoints).toEqual({
      authUrl: OVERRIDES.GOOGLE_AUTH_URL,
      tokenUrl: OVERRIDES.GOOGLE_TOKEN_URL,
      jwksUrl: OVERRIDES.GOOGLE_JWKS_URL,
      issuer: OVERRIDES.GOOGLE_ISSUER,
    });
    expect(loadConfig({ GOOGLE_TOKEN_URL: OVERRIDES.GOOGLE_TOKEN_URL }).googleEndpoints).toEqual({
      tokenUrl: OVERRIDES.GOOGLE_TOKEN_URL,
    });
  });

  it('refuses every override in production, naming the variable', () => {
    expect(() => loadConfig(PROD_ENV)).not.toThrow();
    for (const [name, value] of Object.entries(OVERRIDES)) {
      expect(() => loadConfig({ ...PROD_ENV, [name]: value }), name).toThrow(
        new RegExp(`${name}: .*refused in production`),
      );
    }
  });

  it('refuses overrides for a non-local https PUBLIC_ORIGIN whatever NODE_ENV is', () => {
    const origin = 'https://clavis-api-production.up.railway.app';
    for (const nodeEnv of [undefined, 'development']) {
      const env: Record<string, string> = { PUBLIC_ORIGIN: origin, ...OVERRIDES };
      if (nodeEnv) env['NODE_ENV'] = nodeEnv;
      expect(() => loadConfig(env), String(nodeEnv)).toThrow(/GOOGLE_AUTH_URL: .*refused/);
    }
    expect(() => loadConfig({ PUBLIC_ORIGIN: origin })).not.toThrow();
  });

  it('accepts overrides with a localhost origin (e2e stack)', () => {
    for (const PUBLIC_ORIGIN of [
      'http://localhost:8787',
      'https://localhost:8787',
      'http://127.0.0.1:8787',
    ]) {
      expect(loadConfig({ PUBLIC_ORIGIN, ...OVERRIDES }).googleEndpoints?.tokenUrl).toBe(
        OVERRIDES.GOOGLE_TOKEN_URL,
      );
    }
  });

  it('rejects a malformed override URL', () => {
    expect(() => loadConfig({ GOOGLE_TOKEN_URL: 'not a url' })).toThrow(/GOOGLE_TOKEN_URL/);
  });
});

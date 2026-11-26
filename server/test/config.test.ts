import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const B64_32 = Buffer.alloc(32, 7).toString('base64');
const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';

const PROD_ENV = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db.internal:5432/clavis',
  GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
  GOOGLE_CLIENT_SECRET: 'secret',
  ALLOWED_EXTENSION_IDS: EXT_ID,
  TOKEN_SIGNING_SECRET: Buffer.alloc(32, 1).toString('base64'),
  STATE_COOKIE_SECRET: Buffer.alloc(32, 2).toString('base64'),
  PUBLIC_ORIGIN: 'https://clavis-api-production.up.railway.app',
};

describe('loadConfig', () => {
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
    const s = Buffer.alloc(32, 9).toString('base64');
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

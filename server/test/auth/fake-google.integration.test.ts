import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenPair } from '../../../shared/api-contract';
import { startFakeGoogle, type FakeGoogle } from '../../scripts/fake-google.mjs';
import { createApp } from '../../src/app';
import { loadConfig } from '../../src/config';
import { createLogger } from '../../src/logger';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import { DEV_EXT_ID, EXT_ORIGIN, EXT_REDIRECT, cookiesOf, testEnv, verifier } from './harness';

// Real GoogleClient (no mocks) talking over HTTP to scripts/fake-google.mjs: the e2e wiring.
describe.skipIf(!adminUrl)('fake Google round-trip (real Postgres, real HTTP to the fake)', () => {
  let tdb: TestDb;
  let fake: FakeGoogle;
  let app: ReturnType<typeof createApp>;
  const API = 'http://localhost:8787';

  beforeAll(async () => {
    tdb = await createTestDb(5);
    fake = await startFakeGoogle({ port: 0 });
    const config = loadConfig(
      testEnv({
        NODE_ENV: 'development',
        PUBLIC_ORIGIN: API,
        ALLOWED_EXTENSION_IDS: DEV_EXT_ID,
        GOOGLE_AUTH_URL: `${fake.url}/authorize`,
        GOOGLE_TOKEN_URL: `${fake.url}/token`,
        GOOGLE_JWKS_URL: `${fake.url}/jwks`,
        GOOGLE_ISSUER: fake.issuer,
      }),
    );
    app = createApp({ config, logger: createLogger('silent'), db: tdb.handle });
  });
  afterAll(async () => {
    await fake?.close();
    await tdb?.drop();
  });

  const authorize = async (params: Record<string, string>) => {
    const res = await fetch(`${fake.url}/authorize?${new URLSearchParams(params)}`, {
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    return new URL(res.headers.get('location') as string);
  };

  async function extensionSignIn(email: string, n: number) {
    const v = verifier(n);
    const nonce = `nonce-${n}`;
    const back = await authorize({
      client_id: 'test-client.apps.googleusercontent.com',
      redirect_uri: EXT_REDIRECT,
      state: 's',
      nonce,
      code_challenge: createHash('sha256').update(v).digest('base64url'),
      code_challenge_method: 'S256',
      login_hint: email,
    });
    expect(back.origin + back.pathname).toBe(EXT_REDIRECT);
    expect(back.searchParams.get('state')).toBe('s');
    return app.request('/v1/auth/extension/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXT_ORIGIN },
      body: JSON.stringify({
        code: back.searchParams.get('code'),
        codeVerifier: v,
        redirectUri: EXT_REDIRECT,
        nonce,
      }),
    });
  }

  it('extension flow: two login_hints become two different users; PKCE and nonce are enforced', async () => {
    const a = TokenPair.parse(await (await extensionSignIn('alice@example.test', 1)).json());
    const b = TokenPair.parse(await (await extensionSignIn('bob@example.test', 2)).json());
    const a2 = TokenPair.parse(await (await extensionSignIn('alice@example.test', 3)).json());
    expect(a.user.email).toBe('alice@example.test');
    expect(b.user.email).toBe('bob@example.test');
    expect(a.user.id).not.toBe(b.user.id);
    expect(a2.user.id).toBe(a.user.id);
    const me = await app.request('/v1/account', {
      headers: { authorization: `Bearer ${a.accessToken}` },
    });
    expect(me.status).toBe(200);

    // Wrong verifier: the fake refuses the exchange, the API answers 400.
    const back = await authorize({
      client_id: 'c',
      redirect_uri: EXT_REDIRECT,
      state: 's',
      nonce: 'n',
      code_challenge: createHash('sha256').update(verifier(9)).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const bad = await app.request('/v1/auth/extension/google', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: EXT_ORIGIN },
      body: JSON.stringify({
        code: back.searchParams.get('code'),
        codeVerifier: verifier(8),
        redirectUri: EXT_REDIRECT,
        nonce: 'n',
      }),
    });
    expect(bad.status).toBe(400);
  });

  it('dashboard flow: /auth/google/start -> fake /authorize -> /auth/google/callback creates a session', async () => {
    const start = await app.request('/auth/google/start');
    expect(start.status).toBe(302);
    const loc = new URL(start.headers.get('location') as string);
    expect(loc.origin).toBe(fake.url);
    // Google's `login_hint` is a plain pass-through parameter; add it as a browser would.
    loc.searchParams.set('login_hint', 'carol@example.test');
    const back = await authorize(Object.fromEntries(loc.searchParams));
    expect(back.origin + back.pathname).toBe(`${API}/auth/google/callback`);
    const oauth = cookiesOf(start)['clavis_oauth']?.value as string;
    const cb = await app.request(`/auth/google/callback${back.search}`, {
      headers: { cookie: `clavis_oauth=${oauth}` },
    });
    expect(cb.status).toBe(302);
    const session = cookiesOf(cb)['clavis_session']?.value;
    expect(session).toBeTruthy();
    const s = await app.request('/v1/session', {
      headers: { cookie: `clavis_session=${session}` },
    });
    expect(s.status).toBe(200);
    expect(((await s.json()) as { user: { email: string } }).user.email).toBe('carol@example.test');
  });

  it('the fake serves a JWKS and a code is single use', async () => {
    const jwks = (await (await fetch(`${fake.url}/jwks`)).json()) as {
      keys: Array<{ alg: string }>;
    };
    expect(jwks.keys[0]?.alg).toBe('RS256');
    const v = verifier(5);
    const back = await authorize({
      client_id: 'c',
      redirect_uri: EXT_REDIRECT,
      state: 's',
      code_challenge: createHash('sha256').update(v).digest('base64url'),
      code_challenge_method: 'S256',
    });
    const form = new URLSearchParams({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code') as string,
      code_verifier: v,
      redirect_uri: EXT_REDIRECT,
      client_id: 'c',
    });
    const post = () => fetch(`${fake.url}/token`, { method: 'POST', body: form });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(400);
  });
});

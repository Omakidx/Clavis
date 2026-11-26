import { beforeAll, describe, expect, it } from 'vitest';
import { GoogleAuthError, GoogleUnavailableError } from '../../src/auth/google';
import {
  CLIENT_ID,
  EXT_REDIRECT,
  challengeOf,
  createMockGoogle,
  makeClock,
  verifier,
  type MockGoogle,
} from './harness';

describe('GoogleClient', () => {
  const clock = makeClock();
  let g: MockGoogle;
  beforeAll(async () => {
    g = await createMockGoogle(clock.now);
  });

  const base = () => ({
    nonce: 'n-1',
    codeChallenge: challengeOf(verifier()),
    redirectUri: EXT_REDIRECT,
  });
  async function run(spec: Partial<Parameters<MockGoogle['issueCode']>[0]> = {}, nonce = 'n-1') {
    const code = g.issueCode({ ...base(), ...spec });
    const idToken = await g.client.exchangeCode(code, verifier(), EXT_REDIRECT);
    return g.client.verifyIdToken(idToken, nonce);
  }

  it('builds the authorization URL with PKCE S256, state, nonce and no offline access', () => {
    const u = new URL(
      g.client.authUrl({
        redirectUri: EXT_REDIRECT,
        state: 'st',
        nonce: 'no',
        codeVerifier: verifier(),
      }),
    );
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = u.searchParams;
    expect(q.get('client_id')).toBe(CLIENT_ID);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('scope')).toBe('openid email profile');
    expect(q.get('code_challenge')).toBe(challengeOf(verifier()));
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBe('st');
    expect(q.get('nonce')).toBe('no');
    expect(q.has('access_type')).toBe(false);
    expect(q.get('prompt')).toBe('select_account');
    expect(q.has('max_age')).toBe(false);
  });

  it('forces a login on reauth', () => {
    const q = new URL(
      g.client.authUrl({
        redirectUri: 'x://y',
        state: 's',
        nonce: 'n',
        codeVerifier: verifier(),
        reauth: true,
      }),
    ).searchParams;
    expect(q.get('prompt')).toBe('login');
    expect(q.get('max_age')).toBe('0');
  });

  it('exchanges the code with secret, verifier and redirect_uri, then verifies the token', async () => {
    const id = await run({ sub: 's-9', email: 'a@b.test', name: '  Grace  ' });
    expect(id).toEqual({ sub: 's-9', email: 'a@b.test', displayName: 'Grace' });
    const sent = g.tokenRequests.at(-1);
    expect(sent?.get('client_secret')).toBeTruthy();
    expect(sent?.get('code_verifier')).toBe(verifier());
    expect(sent?.get('redirect_uri')).toBe(EXT_REDIRECT);
  });

  it('accepts the bare accounts.google.com issuer and a string email_verified', async () => {
    expect((await run({ iss: 'accounts.google.com', email_verified: 'true' })).sub).toBeTruthy();
  });

  const rejects: Array<
    [string, Parameters<MockGoogle['issueCode']>[0] extends infer T ? Partial<T> : never]
  > = [
    ['wrong audience', { aud: 'someone-else' }],
    ['wrong issuer', { iss: 'https://evil.test' }],
    ['expired', { expOffsetS: -400 }],
    ['iat too far in the future', { iatOffsetS: 600, expOffsetS: 4000 }],
    ['bad signature', { wrongKey: true }],
    ['missing email', { omitEmail: true }],
  ];
  it.each(rejects)('rejects an ID token with %s as oauth_failed', async (_n, spec) => {
    await expect(run(spec)).rejects.toMatchObject({ kind: 'oauth_failed' });
  });

  it('rejects a nonce mismatch', async () => {
    await expect(run({}, 'other-nonce')).rejects.toMatchObject({ kind: 'oauth_failed' });
    await expect(run({}, '')).rejects.toMatchObject({ kind: 'oauth_failed' });
  });

  it('tolerates up to 5 minutes of iat skew', async () => {
    expect((await run({ iatOffsetS: 240, expOffsetS: 4000 })).sub).toBeTruthy();
  });

  it.each([false, 'false', undefined])('email_verified=%s is email_not_verified', async (v) => {
    await expect(run({ email_verified: v })).rejects.toBeInstanceOf(GoogleAuthError);
    await expect(run({ email_verified: v })).rejects.toMatchObject({ kind: 'email_not_verified' });
  });

  it('a wrong verifier or redirect_uri is rejected by the token endpoint', async () => {
    const code = g.issueCode(base());
    await expect(g.client.exchangeCode(code, verifier(2), EXT_REDIRECT)).rejects.toMatchObject({
      kind: 'oauth_failed',
    });
    const code2 = g.issueCode(base());
    await expect(
      g.client.exchangeCode(code2, verifier(), 'https://evil.test/'),
    ).rejects.toMatchObject({ kind: 'oauth_failed' });
  });

  it('a code is single-use', async () => {
    const code = g.issueCode(base());
    await g.client.exchangeCode(code, verifier(), EXT_REDIRECT);
    await expect(g.client.exchangeCode(code, verifier(), EXT_REDIRECT)).rejects.toBeInstanceOf(
      GoogleAuthError,
    );
  });

  it('maps Google 5xx and network failures to unavailable, 4xx to oauth_failed', async () => {
    const c5 = g.issueCode({ ...base(), tokenStatus: 503 });
    await expect(g.client.exchangeCode(c5, verifier(), EXT_REDIRECT)).rejects.toBeInstanceOf(
      GoogleUnavailableError,
    );
    const c4 = g.issueCode({ ...base(), tokenStatus: 401 });
    await expect(g.client.exchangeCode(c4, verifier(), EXT_REDIRECT)).rejects.toBeInstanceOf(
      GoogleAuthError,
    );
  });

  it('maps a JWKS outage to unavailable (not a bad token)', async () => {
    const g2 = await createMockGoogle(clock.now);
    const code = g2.issueCode(base());
    const t = await g2.client.exchangeCode(code, verifier(), EXT_REDIRECT);
    g2.breakJwks();
    await expect(g2.client.verifyIdToken(t, 'n-1')).rejects.toBeInstanceOf(GoogleUnavailableError);
    g2.failFetch();
    await expect(
      g2.client.exchangeCode(g2.issueCode(base()), verifier(), EXT_REDIRECT),
    ).rejects.toBeInstanceOf(GoogleUnavailableError);
  });
});

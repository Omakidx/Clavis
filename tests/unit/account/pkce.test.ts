import { describe, expect, it } from 'vitest';
import { withLoginHint } from '../../../lib/account/dev-config';
import {
  buildAuthorizeUrl,
  challengeOf,
  createPkceSecrets,
  parseCallback,
} from '../../../lib/account/pkce';

const REDIRECT = 'https://extid.chromiumapp.org/';

describe('PKCE, state and nonce', () => {
  it('the S256 challenge of the RFC 7636 example verifier', async () => {
    expect(await challengeOf('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('generates a 43 character verifier, distinct state and nonce, and a matching challenge', async () => {
    const a = await createPkceSecrets();
    const b = await createPkceSecrets();
    expect(a.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(a.codeChallenge).toBe(await challengeOf(a.codeVerifier));
    expect(new Set([a.codeVerifier, b.codeVerifier, a.state, a.nonce, b.state]).size).toBe(5);
  });

  it('builds the authorize URL: openid email profile, S256, no offline access', async () => {
    const secrets = await createPkceSecrets();
    const url = new URL(
      buildAuthorizeUrl({
        authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
        clientId: 'cid',
        redirectUri: REDIRECT,
        secrets,
      }),
    );
    const p = url.searchParams;
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(p.get('scope')).toBe('openid email profile');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('redirect_uri')).toBe(REDIRECT);
    expect(p.get('state')).toBe(secrets.state);
    expect(p.get('nonce')).toBe(secrets.nonce);
    expect(p.get('prompt')).toBe('select_account');
    expect(p.has('access_type')).toBe(false);
    expect(p.has('login_hint')).toBe(false);
    // The dev-only hint is added by dev-config, never by the store code path.
    expect(
      new URL(withLoginHint(url.toString(), 'u@example.test')).searchParams.get('login_hint'),
    ).toBe('u@example.test');
    expect(withLoginHint(url.toString(), undefined)).toBe(url.toString());
  });

  describe('parseCallback', () => {
    it('returns the code when state matches', () => {
      expect(parseCallback(`${REDIRECT}?code=abc&state=S`, REDIRECT, 'S')).toEqual({
        ok: true,
        code: 'abc',
      });
    });
    it('state mismatch, missing or repeated state or code, or another URL fails', () => {
      for (const returned of [
        `${REDIRECT}?code=abc&state=OTHER`,
        `${REDIRECT}?code=abc`,
        `${REDIRECT}?code=abc&state=S&state=S`,
        `${REDIRECT}?state=S`,
        `${REDIRECT}?code=a&code=b&state=S`,
        `https://evil.example/?code=abc&state=S`,
        'not a url',
      ]) {
        expect(parseCallback(returned, REDIRECT, 'S'), returned).toEqual({
          ok: false,
          reason: 'failed',
        });
      }
    });
    it('access_denied and an empty answer are the user cancelling; other errors fail', () => {
      expect(parseCallback(`${REDIRECT}?error=access_denied&state=S`, REDIRECT, 'S')).toEqual({
        ok: false,
        reason: 'cancelled',
      });
      expect(parseCallback(undefined, REDIRECT, 'S')).toEqual({ ok: false, reason: 'cancelled' });
      expect(parseCallback(`${REDIRECT}?error=server_error&state=S`, REDIRECT, 'S')).toEqual({
        ok: false,
        reason: 'failed',
      });
      // An error answer with the wrong state is not ours.
      expect(parseCallback(`${REDIRECT}?error=access_denied&state=X`, REDIRECT, 'S')).toEqual({
        ok: false,
        reason: 'failed',
      });
    });
  });
});

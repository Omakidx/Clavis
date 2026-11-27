import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { pkceChallenge, safeEqual, seal, unseal } from '../../src/auth/crypto';
import {
  ACCESS_AUDIENCE,
  AccessTokens,
  hashRefreshToken,
  newRefreshToken,
} from '../../src/auth/tokens';
import { RefreshTokenString } from '../../../shared/api-contract';
import { SIGNING_SECRET, SIGNING_SECRET_2, STATE_SECRET, ORIGIN, makeClock } from './harness';

describe('crypto helpers', () => {
  it('pkceChallenge matches the RFC 7636 S256 example', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
  });

  it('safeEqual compares exactly', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('', 'x')).toBe(false);
  });

  it('seal/unseal round-trips and rejects tampering, truncation and a wrong key', () => {
    const sealed = seal(STATE_SECRET, { s: 'state', n: 1 });
    expect(unseal(STATE_SECRET, sealed)).toEqual({ s: 'state', n: 1 });
    expect(unseal(SIGNING_SECRET, sealed)).toBeUndefined();
    const raw = Buffer.from(sealed, 'base64url');
    raw[20] = (raw[20] ?? 0) ^ 1;
    expect(unseal(STATE_SECRET, raw.toString('base64url'))).toBeUndefined();
    expect(unseal(STATE_SECRET, sealed.slice(0, 10))).toBeUndefined();
    expect(unseal(STATE_SECRET, '')).toBeUndefined();
    expect(unseal(STATE_SECRET, 'not base64 !!')).toBeUndefined();
  });

  it('seal uses a fresh IV each time', () => {
    expect(seal(STATE_SECRET, 'x')).not.toBe(seal(STATE_SECRET, 'x'));
  });
});

describe('refresh tokens', () => {
  it('match the shared contract format and hash deterministically', () => {
    const t = newRefreshToken();
    expect(RefreshTokenString.safeParse(t).success).toBe(true);
    expect(newRefreshToken()).not.toBe(t);
    expect(hashRefreshToken(t)).toHaveLength(32);
    expect(hashRefreshToken(t).equals(hashRefreshToken(t))).toBe(true);
  });
});

describe('access tokens (HS256)', () => {
  const clock = makeClock();
  const mk = (secret = SIGNING_SECRET, previousSecret?: string) =>
    new AccessTokens({ issuer: ORIGIN, secret, previousSecret, now: clock.now });
  const claims = { userId: '11111111-1111-4111-8111-111111111111', familyId: 'fam-1' };

  it('issues a 15 minute token with the documented claims', async () => {
    const { token, expiresAt } = await mk().issue(claims);
    expect(expiresAt - clock.now()).toBe(15 * 60 * 1000);
    const payload = JSON.parse(Buffer.from(token.split('.')[1] as string, 'base64url').toString());
    expect(payload).toMatchObject({
      iss: ORIGIN,
      aud: ACCESS_AUDIENCE,
      sub: claims.userId,
      fam: 'fam-1',
    });
    expect(await mk().verify(token)).toEqual({ ok: true, claims });
  });

  it('reports expiry distinctly from invalid', async () => {
    const { token } = await mk().issue(claims);
    clock.advance(15 * 60 * 1000 + 1000);
    expect(await mk().verify(token)).toEqual({ ok: false, reason: 'expired' });
    clock.advance(-(15 * 60 * 1000 + 1000));
  });

  it('rejects wrong key, wrong audience, wrong issuer, alg none and garbage', async () => {
    const { token } = await mk().issue(claims);
    expect(await mk(SIGNING_SECRET_2).verify(token)).toEqual({ ok: false, reason: 'invalid' });
    const key = Buffer.from(SIGNING_SECRET, 'base64');
    const iat = Math.floor(clock.now() / 1000);
    const forge = (aud: string, iss: string) =>
      new SignJWT({ fam: 'f' })
        .setProtectedHeader({ alg: 'HS256' })
        .setIssuer(iss)
        .setAudience(aud)
        .setSubject('u')
        .setIssuedAt(iat)
        .setExpirationTime(iat + 60)
        .sign(key);
    expect((await mk().verify(await forge('other', ORIGIN))).ok).toBe(false);
    expect((await mk().verify(await forge(ACCESS_AUDIENCE, 'https://evil.test'))).ok).toBe(false);
    const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(
      JSON.stringify({ iss: ORIGIN, aud: ACCESS_AUDIENCE, sub: 'u', fam: 'f', exp: iat + 600 }),
    ).toString('base64url')}.`;
    expect(await mk().verify(none)).toEqual({ ok: false, reason: 'invalid' });
    expect(await mk().verify('garbage')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects a token with no fam claim', async () => {
    const key = Buffer.from(SIGNING_SECRET, 'base64');
    const iat = Math.floor(clock.now() / 1000);
    const t = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer(ORIGIN)
      .setAudience(ACCESS_AUDIENCE)
      .setSubject('u')
      .setIssuedAt(iat)
      .setExpirationTime(iat + 60)
      .sign(key);
    expect(await mk().verify(t)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('accepts the previous key during rotation and stops once it is removed', async () => {
    const old = await mk(SIGNING_SECRET).issue(claims);
    expect((await mk(SIGNING_SECRET_2, SIGNING_SECRET).verify(old.token)).ok).toBe(true);
    expect((await mk(SIGNING_SECRET_2).verify(old.token)).ok).toBe(false);
    // New tokens are signed with the current key only.
    const fresh = await mk(SIGNING_SECRET_2, SIGNING_SECRET).issue(claims);
    expect((await mk(SIGNING_SECRET).verify(fresh.token)).ok).toBe(false);
  });
});

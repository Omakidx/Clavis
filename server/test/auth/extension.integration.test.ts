import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenPair } from '../../../shared/api-contract';
import { hashRefreshToken } from '../../src/auth/tokens';
import { refreshTokens, users } from '../../src/db/schema';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import {
  EXT_ORIGIN,
  EXT_REDIRECT,
  OTHER_EXT_ID,
  SIGNING_SECRET,
  SIGNING_SECRET_2,
  bearer,
  createHarness,
  extSignIn,
  extSignInRaw,
  postJson,
  type Harness,
  type Pair,
} from './harness';

const DAY = 24 * 3600 * 1000;
type Err = { error: { code: string; retryAfterMs?: number } };

describe.skipIf(!adminUrl)('extension auth (real Postgres, mocked Google)', () => {
  let tdb: TestDb;
  let sub = 0;
  const who = () => ({ sub: `sub-${++sub}-${Math.random()}`, email: `u${sub}@example.test` });
  const mk = (env?: Record<string, string>) => createHarness({ db: tdb.handle, env });
  const refresh = (h: Harness, t: string) =>
    postJson(h, '/v1/auth/extension/refresh', { refreshToken: t }, { origin: EXT_ORIGIN });
  const account = (h: Harness, t: Pair | string) =>
    h.app.request('/v1/account', { headers: bearer(t) });
  const errOf = async (r: Response) => ((await r.json()) as Err).error;

  beforeAll(async () => {
    tdb = await createTestDb(10);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  describe('sign-in', () => {
    it('exchanges a code, verifies the token, creates the user and a token pair', async () => {
      const h = await mk();
      const res = await extSignInRaw(h, { sub: 'g-new', email: 'new@example.test' });
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('no-store');
      const pair = TokenPair.parse(await res.json());
      expect(pair.user).toMatchObject({ email: 'new@example.test', displayName: 'Ada Lovelace' });
      expect(pair.refreshToken).toMatch(/^crt_/);
      expect(pair.accessTokenExpiresAt - h.clock.now()).toBe(15 * 60_000);
      expect(pair.refreshTokenExpiresAt - h.clock.now()).toBe(30 * DAY);
      // The server sent the secret and verifier to Google, never to the client.
      expect(h.google.tokenRequests[0]?.get('client_secret')).toBeTruthy();
      expect(JSON.stringify(pair)).not.toContain('test-client-secret');
      // Only the hash of the refresh token is stored.
      const rows = await tdb.handle.db
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hashRefreshToken(pair.refreshToken)));
      expect(rows).toHaveLength(1);
      const raw = await tdb.handle.pool.query(
        "SELECT count(*)::int AS n FROM refresh_tokens WHERE token_hash = convert_to($1, 'UTF8')",
        [pair.refreshToken],
      );
      expect(raw.rows[0].n).toBe(0);
      expect((await account(h, pair)).status).toBe(200);
    });

    it('upserts by google_sub and refreshes email and display name', async () => {
      const h = await mk();
      const a = await extSignIn(h, { sub: 'g-same', email: 'old@example.test' });
      const b = await extSignIn(h, { sub: 'g-same', email: 'renamed@example.test' }, 2);
      expect(b.user.id).toBe(a.user.id);
      expect(b.user.email).toBe('renamed@example.test');
      const [row] = await tdb.handle.db.select().from(users).where(eq(users.id, a.user.id));
      expect(row?.email).toBe('renamed@example.test');
      const c = await extSignIn(h, who(), 3);
      expect(c.user.id).not.toBe(a.user.id);
      // Each sign-in is its own family.
      const fams = await tdb.handle.pool.query(
        'SELECT count(DISTINCT family_id)::int AS n FROM refresh_tokens WHERE user_id = $1',
        [a.user.id],
      );
      expect(fams.rows[0].n).toBe(2);
    });

    it('403 EMAIL_NOT_VERIFIED when email_verified is false, and creates no user', async () => {
      const h = await mk();
      const res = await extSignInRaw(h, { sub: 'g-unverified', email_verified: false });
      expect(res.status).toBe(403);
      expect((await errOf(res)).code).toBe('EMAIL_NOT_VERIFIED');
      const n = await tdb.handle.pool.query(
        `SELECT count(*)::int AS n FROM users WHERE google_sub='g-unverified'`,
      );
      expect(n.rows[0].n).toBe(0);
    });

    it('400 OAUTH_FAILED on nonce mismatch', async () => {
      const h = await mk();
      const res = await extSignInRaw(h, who(), 1, { nonce: 'a-different-nonce' });
      expect(res.status).toBe(400);
      expect((await errOf(res)).code).toBe('OAUTH_FAILED');
    });

    it('400 OAUTH_FAILED when Google rejects the code (unknown or reused)', async () => {
      const h = await mk();
      const res = await postJson(
        h,
        '/v1/auth/extension/google',
        { code: 'forged', codeVerifier: 'v'.repeat(43), redirectUri: EXT_REDIRECT, nonce: 'n' },
        { origin: EXT_ORIGIN },
      );
      expect(res.status).toBe(400);
    });

    it('redirectUri must match an allowed extension id (design 2.2)', async () => {
      const h = await mk();
      for (const redirectUri of [
        `https://${OTHER_EXT_ID}.chromiumapp.org/`,
        'https://evil.test/',
        'https://ebfpdncfkebjagolnbmfdhikaipiflbl.chromiumapp.org', // no trailing slash
        'http://ebfpdncfkebjagolnbmfdhikaipiflbl.chromiumapp.org/',
      ]) {
        const res = await extSignInRaw(h, who(), 1, { redirectUri });
        expect(res.status, redirectUri).toBe(400);
        expect((await errOf(res)).code).toBe('OAUTH_FAILED');
      }
      expect(h.google.tokenRequests).toHaveLength(0); // never reached Google
    });

    it('requires an allowed extension Origin (missing, other extension, web page)', async () => {
      const h = await mk();
      for (const origin of [undefined, `chrome-extension://${OTHER_EXT_ID}`, 'https://evil.test']) {
        const res = await extSignInRaw(h, who(), 1, { origin: origin ?? '' });
        const r = origin
          ? res
          : await postJson(h, '/v1/auth/extension/google', {
              code: 'c',
              codeVerifier: 'v'.repeat(43),
              redirectUri: 'https://x.test/',
              nonce: 'n',
            });
        expect(r.status, String(origin)).toBe(403);
        expect((await errOf(r)).code).toBe('FORBIDDEN');
      }
      expect(h.google.tokenRequests).toHaveLength(0);
    });

    it('validates the body (400) and content type (415)', async () => {
      const h = await mk();
      const call = (body: unknown, ct = 'application/json') =>
        h.app.request('/v1/auth/extension/google', {
          method: 'POST',
          headers: { 'content-type': ct, origin: EXT_ORIGIN },
          body: typeof body === 'string' ? body : JSON.stringify(body),
        });
      const ok = {
        code: 'c',
        codeVerifier: 'v'.repeat(43),
        redirectUri: 'https://x.test/',
        nonce: 'n',
      };
      for (const bad of [
        {},
        { ...ok, codeVerifier: 'short' },
        { ...ok, codeVerifier: 'v'.repeat(43) + '!' },
        { ...ok, extra: 1 },
        { ...ok, code: 'x'.repeat(2049) },
        { ...ok, nonce: 'n'.repeat(65) },
        { ...ok, redirectUri: 'not a url' },
      ]) {
        const res = await call(bad);
        expect(res.status).toBe(400);
        expect((await errOf(res)).code).toBe('VALIDATION_FAILED');
      }
      expect((await call('{not json')).status).toBe(400);
      expect((await call(ok, 'text/plain')).status).toBe(415);
    });

    it('413 for an oversized body', async () => {
      const h = await mk();
      const res = await h.app.request('/v1/auth/extension/google', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXT_ORIGIN },
        body: JSON.stringify({ code: 'x'.repeat(600_000) }),
      });
      expect(res.status).toBe(413);
      expect((await errOf(res)).code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('503 UNAVAILABLE with retryAfterMs when Google is down', async () => {
      const h = await mk();
      h.google.failFetch();
      const res = await extSignInRaw(h, who());
      expect(res.status).toBe(503);
      const e = await errOf(res);
      expect(e.code).toBe('UNAVAILABLE');
      expect(e.retryAfterMs).toBeGreaterThan(0);
    });

    it('is limited to 10/min/IP', async () => {
      const h = await mk();
      for (let i = 0; i < 10; i++) await extSignInRaw(h, who(), i + 1);
      const res = await extSignInRaw(h, who(), 11);
      expect(res.status).toBe(429);
      expect((await errOf(res)).code).toBe('RATE_LIMITED');
      expect((await errOf(await extSignInRaw(h, who(), 12))).retryAfterMs).toBeGreaterThan(0);
    });
  });

  describe('refresh rotation and reuse detection', () => {
    it('rotates: old token marked used, successor works, user unchanged', async () => {
      const h = await mk();
      const p1 = await extSignIn(h, who());
      h.clock.advance(5_000);
      const res = await refresh(h, p1.refreshToken);
      expect(res.status).toBe(200);
      const p2 = TokenPair.parse(await res.json());
      expect(p2.refreshToken).not.toBe(p1.refreshToken);
      expect(p2.user.id).toBe(p1.user.id);
      const rows = (
        await tdb.handle.pool.query(
          'SELECT used_at, family_id FROM refresh_tokens WHERE user_id = $1 ORDER BY created_at',
          [p1.user.id],
        )
      ).rows;
      expect(rows).toHaveLength(2);
      expect(rows[0].used_at).not.toBeNull();
      expect(rows[1].used_at).toBeNull();
      expect(rows[0].family_id).toBe(rows[1].family_id);
      expect((await account(h, p2)).status).toBe(200);
      expect((await refresh(h, p2.refreshToken)).status).toBe(200);
    });

    it('a retry within 60 s gets TOKEN_REUSED without revoking the family', async () => {
      const h = await mk();
      const p1 = await extSignIn(h, who());
      const p2 = TokenPair.parse(await (await refresh(h, p1.refreshToken)).json());
      h.clock.advance(30_000);
      const retry = await refresh(h, p1.refreshToken);
      expect(retry.status).toBe(401);
      expect((await errOf(retry)).code).toBe('TOKEN_REUSED');
      // The newer token is still good.
      expect((await refresh(h, p2.refreshToken)).status).toBe(200);
    });

    it('reuse after 60 s revokes the whole family: SESSION_REVOKED for every token', async () => {
      const h = await mk();
      const p1 = await extSignIn(h, who());
      const p2 = TokenPair.parse(await (await refresh(h, p1.refreshToken)).json());
      h.clock.advance(61_000);
      const stolen = await refresh(h, p1.refreshToken);
      expect(stolen.status).toBe(401);
      expect((await errOf(stolen)).code).toBe('SESSION_REVOKED');
      const legit = await refresh(h, p2.refreshToken);
      expect(legit.status).toBe(401);
      expect((await errOf(legit)).code).toBe('SESSION_REVOKED');
      const acc = await account(h, p2); // access token of the revoked family dies immediately
      expect(acc.status).toBe(401);
      expect((await errOf(acc)).code).toBe('SESSION_REVOKED');
      const reasons = await tdb.handle.pool.query(
        'SELECT DISTINCT revoked_reason FROM refresh_tokens WHERE user_id = $1',
        [p1.user.id],
      );
      expect(reasons.rows).toEqual([{ revoked_reason: 'reuse' }]);
    });

    it('revoking one family leaves the same user’s other families alone', async () => {
      const h = await mk();
      const w = who();
      const a = await extSignIn(h, w, 1);
      const b = await extSignIn(h, w, 2);
      await postJson(h, '/v1/auth/extension/logout', { refreshToken: a.refreshToken });
      expect((await account(h, a)).status).toBe(401);
      expect((await account(h, b)).status).toBe(200);
      expect((await refresh(h, b.refreshToken)).status).toBe(200);
    });

    it('serialises concurrent presentations of one token: one wins, one is TOKEN_REUSED', async () => {
      const h = await mk();
      const p1 = await extSignIn(h, who());
      const rs = await Promise.all([1, 2, 3].map(() => refresh(h, p1.refreshToken)));
      const codes = await Promise.all(
        rs.map(async (r) => (r.status === 200 ? 'ok' : (await errOf(r)).code)),
      );
      expect(codes.filter((c) => c === 'ok')).toHaveLength(1);
      expect(codes.filter((c) => c === 'TOKEN_REUSED')).toHaveLength(2);
    });

    it('unknown, malformed and expired refresh tokens are rejected', async () => {
      const h = await mk();
      const unknown = await refresh(h, `crt_${'A'.repeat(43)}`);
      expect(unknown.status).toBe(401);
      expect((await errOf(unknown)).code).toBe('UNAUTHENTICATED');
      for (const t of ['', 'crt_short', 'x'.repeat(47), `bad_${'A'.repeat(43)}`]) {
        const res = await refresh(h, t);
        expect(res.status).toBe(400);
        expect((await errOf(res)).code).toBe('VALIDATION_FAILED');
      }
      const p = await extSignIn(h, who());
      h.clock.advance(30 * DAY + 1000);
      const exp = await refresh(h, p.refreshToken);
      expect(exp.status).toBe(401);
      expect((await errOf(exp)).code).toBe('UNAUTHENTICATED');
    });

    it('slides 30 days per rotation but never beyond the 180 day family limit', async () => {
      const h = await mk();
      let p = await extSignIn(h, who());
      const start = h.clock.now();
      for (let i = 0; i < 5; i++) {
        h.clock.advance(29 * DAY);
        const r = await refresh(h, p.refreshToken);
        expect(r.status).toBe(200);
        p = TokenPair.parse(await r.json());
        expect(p.refreshTokenExpiresAt - h.clock.now()).toBe(30 * DAY);
      }
      h.clock.advance(29 * DAY); // day 174
      p = TokenPair.parse(await (await refresh(h, p.refreshToken)).json());
      expect(p.refreshTokenExpiresAt).toBe(start + 180 * DAY); // capped
      h.clock.advance(7 * DAY); // day 181
      expect((await refresh(h, p.refreshToken)).status).toBe(401);
    });

    it('limits refresh to 10/min per family', async () => {
      const h = await mk();
      let p = await extSignIn(h, who());
      for (let i = 0; i < 10; i++) {
        const r = await refresh(h, p.refreshToken);
        expect(r.status).toBe(200);
        p = TokenPair.parse(await r.json());
      }
      const r = await refresh(h, p.refreshToken);
      expect(r.status).toBe(429);
      expect((await errOf(r)).code).toBe('RATE_LIMITED');
    });

    it('limits refresh to 30/min per IP', async () => {
      const h = await mk();
      for (let i = 0; i < 30; i++) await refresh(h, `crt_${'A'.repeat(43)}`);
      const r = await refresh(h, `crt_${'A'.repeat(43)}`);
      expect(r.status).toBe(429);
    });
  });

  describe('sign-out', () => {
    it('logout revokes the family immediately and is idempotent', async () => {
      const h = await mk();
      const p = await extSignIn(h, who());
      expect((await account(h, p)).status).toBe(200); // warms the family cache
      const out = await postJson(h, '/v1/auth/extension/logout', { refreshToken: p.refreshToken });
      expect(out.status).toBe(204);
      expect(await out.text()).toBe('');
      const acc = await account(h, p);
      expect(acc.status).toBe(401);
      expect((await errOf(acc)).code).toBe('SESSION_REVOKED');
      const r = await refresh(h, p.refreshToken);
      expect((await errOf(r)).code).toBe('SESSION_REVOKED');
      expect(
        (await postJson(h, '/v1/auth/extension/logout', { refreshToken: p.refreshToken })).status,
      ).toBe(204);
    });

    it('logout with an unknown token is 204 and changes nothing', async () => {
      const h = await mk();
      const p = await extSignIn(h, who());
      const res = await postJson(h, '/v1/auth/extension/logout', {
        refreshToken: `crt_${'B'.repeat(43)}`,
      });
      expect(res.status).toBe(204);
      expect((await account(h, p)).status).toBe(200);
    });

    it('logout with an already-rotated token still revokes the family', async () => {
      const h = await mk();
      const p1 = await extSignIn(h, who());
      const p2 = TokenPair.parse(await (await refresh(h, p1.refreshToken)).json());
      await postJson(h, '/v1/auth/extension/logout', { refreshToken: p1.refreshToken });
      expect((await account(h, p2)).status).toBe(401);
    });

    it('logout-all revokes every family of the caller only', async () => {
      const h = await mk();
      const w = who();
      const a1 = await extSignIn(h, w, 1);
      const a2 = await extSignIn(h, w, 2);
      const other = await extSignIn(h, who(), 3);
      const res = await h.app.request('/v1/account/logout-all', {
        method: 'POST',
        headers: bearer(a1),
      });
      expect(res.status).toBe(204);
      for (const p of [a1, a2]) {
        const r = await account(h, p);
        expect((await errOf(r)).code).toBe('SESSION_REVOKED');
        expect((await refresh(h, p.refreshToken)).status).toBe(401);
      }
      expect((await account(h, other)).status).toBe(200);
    });

    it('logout-all is limited to 5/hour/user', async () => {
      const h = await mk();
      const w = who();
      const results: number[] = [];
      for (let i = 0; i < 6; i++) {
        const p = await extSignIn(h, w, i + 1);
        h.clock.advance(7_000); // stay clear of the sign-in IP limit
        const r = await h.app.request('/v1/account/logout-all', {
          method: 'POST',
          headers: bearer(p),
        });
        results.push(r.status);
      }
      expect(results).toEqual([204, 204, 204, 204, 204, 429]);
    });
  });

  describe('access tokens', () => {
    it('401 UNAUTHENTICATED without, malformed or forged credentials', async () => {
      const h = await mk();
      const p = await extSignIn(h, who());
      for (const headers of [
        {},
        { authorization: 'Bearer' },
        { authorization: 'Bearer garbage' },
        { authorization: `Basic ${p.accessToken}` },
        { authorization: `Bearer ${p.accessToken.slice(0, -2)}xx` },
        { authorization: `Bearer ${p.refreshToken}` },
      ]) {
        const r = await h.app.request('/v1/account', { headers });
        expect(r.status, JSON.stringify(headers)).toBe(401);
        expect((await errOf(r)).code).toBe('UNAUTHENTICATED');
      }
    });

    it('401 TOKEN_EXPIRED after 15 minutes, and a refresh recovers', async () => {
      const h = await mk();
      const p = await extSignIn(h, who());
      h.clock.advance(15 * 60_000 + 1000);
      const r = await account(h, p);
      expect(r.status).toBe(401);
      expect((await errOf(r)).code).toBe('TOKEN_EXPIRED');
      const p2 = TokenPair.parse(await (await refresh(h, p.refreshToken)).json());
      expect((await account(h, p2)).status).toBe(200);
    });

    it('honours TOKEN_SIGNING_SECRET_PREVIOUS during rotation only', async () => {
      const h1 = await mk();
      const p = await extSignIn(h1, who());
      const rotated = await mk({
        TOKEN_SIGNING_SECRET: SIGNING_SECRET_2,
        TOKEN_SIGNING_SECRET_PREVIOUS: SIGNING_SECRET,
      });
      expect((await account(rotated, p)).status).toBe(200);
      const after = await mk({ TOKEN_SIGNING_SECRET: SIGNING_SECRET_2 });
      expect((await account(after, p)).status).toBe(401);
    });

    it('caches the family check for at most 30 s', async () => {
      const h = await mk();
      const p = await extSignIn(h, who());
      expect((await account(h, p)).status).toBe(200);
      // Revoke behind the server's back (as another process would).
      await tdb.handle.pool.query(
        `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout' WHERE user_id = $1`,
        [p.user.id],
      );
      h.clock.advance(20_000);
      expect((await account(h, p)).status).toBe(200);
      h.clock.advance(11_000);
      expect((await errOf(await account(h, p))).code).toBe('SESSION_REVOKED');
    });

    it('rejects the token once the account no longer exists', async () => {
      const h = await mk();
      const p = await extSignIn(h, who());
      await tdb.handle.pool.query('DELETE FROM users WHERE id = $1', [p.user.id]);
      h.clock.advance(31_000);
      // A deleted account is signed out (UNAUTHENTICATED), not a revoked session.
      expect((await errOf(await account(h, p))).code).toBe('UNAUTHENTICATED');
    });
  });

  describe('GET /v1/account', () => {
    it('returns the user and usage, scoped to the caller', async () => {
      const h = await mk();
      const a = await extSignIn(h, { sub: `acct-${Math.random()}`, email: 'acct@example.test' });
      const res = await account(h, a);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        user: { id: string; email: string };
        usage: Record<string, number>;
      };
      expect(body.user.id).toBe(a.user.id);
      expect(body.usage).toEqual({
        storageUsedBytes: 0,
        storageQuotaBytes: 104857600,
        words: 0,
        documents: 0,
      });
      expect(JSON.stringify(body)).not.toMatch(/google|sub-|token/i);
    });

    it('is limited to 120/min/user', async () => {
      const h = await mk();
      const p = await extSignIn(h, who());
      for (let i = 0; i < 120; i++) await account(h, p);
      expect((await account(h, p)).status).toBe(429);
    });
  });

  it('never logs emails, tokens, codes or secrets', async () => {
    const h = await mk();
    const email = 'private.person@example.test';
    const p = await extSignIn(h, { sub: 'log-sub', email });
    const p2 = TokenPair.parse(await (await refresh(h, p.refreshToken)).json());
    await account(h, p2);
    await extSignInRaw(h, { sub: 'log-sub', email_verified: false }, 2);
    await refresh(h, p.refreshToken);
    await postJson(h, '/v1/auth/extension/logout', { refreshToken: p2.refreshToken });
    const all = h.logs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const secret of [
      email,
      'Ada Lovelace',
      p.accessToken,
      p.refreshToken,
      p2.refreshToken,
      'code-',
      'test-client-secret',
      'nonce-',
      EXT_ORIGIN,
    ]) {
      expect(all, secret).not.toContain(secret);
    }
    const entries = h.logs.map((l) => JSON.parse(l) as Record<string, unknown>);
    const routes = entries.map((e) => e['route']);
    expect(routes).toContain('/v1/auth/extension/refresh');
    expect(routes).toContain('/v1/account');
    expect(entries.some((e) => e['errorCode'] === 'EMAIL_NOT_VERIFIED')).toBe(true);
  });
});

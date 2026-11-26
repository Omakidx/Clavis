import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionResponse } from '../../../shared/api-contract';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import {
  ORIGIN,
  bearer,
  cookiesOf,
  createHarness,
  extSignIn,
  webLogin,
  webPost,
  type Harness,
} from './harness';

const DAY = 24 * 3600 * 1000;
type Err = { error: { code: string } };

describe.skipIf(!adminUrl)('dashboard auth (real Postgres, mocked Google)', () => {
  let tdb: TestDb;
  let n = 0;
  const who = () => ({ sub: `web-${++n}-${Math.random()}`, email: `w${n}@example.test` });
  const mk = (env?: Record<string, string>) => createHarness({ db: tdb.handle, env });
  const code = async (r: Response) => ((await r.json()) as Err).error.code;

  beforeAll(async () => {
    tdb = await createTestDb(10);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  describe('GET /auth/google/start', () => {
    it('302s to Google with PKCE/state/nonce and sets a sealed, hardened state cookie', async () => {
      const h = await mk();
      const res = await h.app.request('/auth/google/start');
      expect(res.status).toBe(302);
      const loc = new URL(res.headers.get('location') as string);
      expect(loc.origin + loc.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
      const q = loc.searchParams;
      expect(q.get('redirect_uri')).toBe(`${ORIGIN}/auth/google/callback`);
      expect(q.get('code_challenge_method')).toBe('S256');
      expect(q.get('state')?.length).toBeGreaterThanOrEqual(22);
      expect(q.get('nonce')?.length).toBeGreaterThanOrEqual(22);
      expect(q.get('prompt')).toBe('select_account');
      expect(q.has('max_age')).toBe(false);
      const c = cookiesOf(res)['__Host-clavis_oauth'];
      expect(c).toBeDefined();
      for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', 'Max-Age=600']) {
        expect(c?.attrs).toContain(a);
      }
      expect(c?.attrs).not.toMatch(/Domain=/i);
      // Sealed: the state and nonce are not readable in the cookie.
      expect(c?.value).not.toContain(q.get('state') as string);
      expect(Buffer.from(c?.value ?? '', 'base64url').toString('latin1')).not.toContain(
        q.get('nonce') as string,
      );
      expect(res.headers.get('cache-control')).toBe('no-store');
    });

    it('reauth=1 forces a Google login; other values are rejected', async () => {
      const h = await mk();
      const q = new URL(
        (await h.app.request('/auth/google/start?reauth=1')).headers.get('location') as string,
      ).searchParams;
      expect(q.get('prompt')).toBe('login');
      expect(q.get('max_age')).toBe('0');
      for (const bad of ['?reauth=2', '?reauth=', '?returnTo=https://evil.test']) {
        const r = await h.app.request(`/auth/google/start${bad}`);
        expect(r.status, bad).toBe(400);
      }
    });

    it('is limited to 20/min/IP', async () => {
      const h = await mk();
      for (let i = 0; i < 20; i++) await h.app.request('/auth/google/start');
      expect((await h.app.request('/auth/google/start')).status).toBe(429);
    });

    it('uses unprefixed, non-Secure cookies on a plain-http dev origin', async () => {
      const h = await mk({ PUBLIC_ORIGIN: 'http://localhost:8787' });
      const res = await h.app.request('/auth/google/start');
      const c = cookiesOf(res)['clavis_oauth'];
      expect(c).toBeDefined();
      expect(c?.attrs).toContain('HttpOnly');
      expect(c?.attrs).not.toContain('Secure');
    });
  });

  describe('GET /auth/google/callback', () => {
    it('creates a session, clears the state cookie and redirects to the fixed path /', async () => {
      const h = await mk();
      const w = await webLogin(h, who());
      expect(w.res.status).toBe(302);
      expect(w.res.headers.get('location')).toBe('/');
      const cookies = cookiesOf(w.res);
      const s = cookies['__Host-clavis_session'];
      for (const a of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/', `Max-Age=${30 * 86400}`]) {
        expect(s?.attrs).toContain(a);
      }
      expect(s?.value.length).toBeGreaterThanOrEqual(43);
      expect(cookies['__Host-clavis_oauth']?.attrs).toMatch(/Max-Age=0/);
      // Only the SHA-256 of the cookie is stored.
      const rows = await tdb.handle.pool.query(
        `SELECT count(*)::int AS n FROM web_sessions WHERE session_hash = convert_to($1, 'UTF8')`,
        [w.session],
      );
      expect(rows.rows[0].n).toBe(0);
      const sess = await h.app.request('/v1/session', { headers: { cookie: w.cookie } });
      expect(sess.status).toBe(200);
      const body = SessionResponse.parse(await sess.json());
      expect(body.csrfToken).toBe(w.csrf);
      expect(body.authenticatedAt).toBe(h.clock.now());
      expect(body.user.email).toMatch(/@example\.test$/);
      expect(sess.headers.get('cache-control')).toBe('no-store');
    });

    it('ignores any returnTo/redirect parameter: there is no open redirect', async () => {
      const h = await mk();
      const start = await h.app.request('/auth/google/start');
      const loc = new URL(start.headers.get('location') as string);
      const c = h.google.issueCode({
        nonce: loc.searchParams.get('nonce') as string,
        codeChallenge: loc.searchParams.get('code_challenge') as string,
        redirectUri: `${ORIGIN}/auth/google/callback`,
      });
      const res = await h.app.request(
        `/auth/google/callback?code=${c}&state=${loc.searchParams.get('state')}&returnTo=https://evil.test&redirect_uri=https://evil.test&next=//evil.test`,
        {
          headers: {
            cookie: `__Host-clavis_oauth=${cookiesOf(start)['__Host-clavis_oauth']?.value}`,
          },
        },
      );
      expect(res.headers.get('location')).toBe('/');
    });

    async function attempt(
      h: Harness,
      mutate: (p: { state: string; cookie: string; code: string }) => {
        state?: string;
        cookie?: string | null;
        code?: string;
      },
      issue: Parameters<Harness['google']['issueCode']>[0] extends infer T
        ? Partial<T>
        : never = {},
      before?: () => void,
    ) {
      const start = await h.app.request('/auth/google/start');
      const loc = new URL(start.headers.get('location') as string);
      const code = h.google.issueCode({
        nonce: loc.searchParams.get('nonce') as string,
        codeChallenge: loc.searchParams.get('code_challenge') as string,
        redirectUri: `${ORIGIN}/auth/google/callback`,
        ...issue,
      });
      const base = {
        state: loc.searchParams.get('state') as string,
        cookie: cookiesOf(start)['__Host-clavis_oauth']?.value as string,
        code,
      };
      const m = { ...base, ...mutate(base) };
      before?.();
      const res = await h.app.request(
        `/auth/google/callback?code=${encodeURIComponent(m.code)}&state=${encodeURIComponent(m.state)}`,
        { headers: m.cookie === null ? {} : { cookie: `__Host-clavis_oauth=${m.cookie}` } },
      );
      return res;
    }
    const expectFailed = (res: Response) => {
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/?signin=failed');
      expect(cookiesOf(res)['__Host-clavis_session']).toBeUndefined();
    };

    it('fails closed on state mismatch, missing/tampered/foreign/expired cookie', async () => {
      const h = await mk();
      expectFailed(await attempt(h, () => ({ state: 'attacker-state' })));
      expectFailed(await attempt(h, () => ({ cookie: null })));
      expectFailed(await attempt(h, (p) => ({ cookie: p.cookie.slice(0, -4) + 'AAAA' })));
      expectFailed(await attempt(h, () => ({ cookie: 'garbage' })));
      // A cookie sealed with another key (e.g. a different deployment) is useless.
      const other = await createHarness({
        db: tdb.handle,
        env: { STATE_COOKIE_SECRET: Buffer.alloc(32, 9).toString('base64') },
      });
      const foreign = cookiesOf(await other.app.request('/auth/google/start'))[
        '__Host-clavis_oauth'
      ]?.value;
      expectFailed(await attempt(h, () => ({ cookie: foreign as string })));
      expectFailed(
        await attempt(
          h,
          () => ({}),
          {},
          () => h.clock.advance(601_000),
        ),
      );
    });

    it('fails on error=access_denied, missing code or state', async () => {
      const h = await mk();
      for (const q of ['?error=access_denied', '', '?code=x', '?state=y']) {
        const res = await h.app.request(`/auth/google/callback${q}`);
        expectFailed(res);
      }
    });

    it('fails when the nonce, audience or verification do not hold; unverified email creates no user', async () => {
      const h = await mk();
      expectFailed(await attempt(h, () => ({}), { nonce: 'not-the-cookie-nonce' }));
      expectFailed(await attempt(h, () => ({}), { aud: 'other' }));
      expectFailed(await attempt(h, () => ({}), { wrongKey: true }));
      expectFailed(await attempt(h, () => ({}), { sub: 'web-unverified', email_verified: false }));
      expectFailed(await attempt(h, () => ({ code: 'forged-code' })));
      const r = await tdb.handle.pool.query(
        `SELECT count(*)::int AS n FROM users WHERE google_sub = 'web-unverified'`,
      );
      expect(r.rows[0].n).toBe(0);
    });

    it('fails (without 5xx) when Google is unreachable', async () => {
      const h = await mk();
      h.google.failFetch();
      expectFailed(await attempt(h, () => ({})));
    });

    it('a state cookie is not replayable for a second login with the same code', async () => {
      const h = await mk();
      const start = await h.app.request('/auth/google/start');
      const loc = new URL(start.headers.get('location') as string);
      const code = h.google.issueCode({
        nonce: loc.searchParams.get('nonce') as string,
        codeChallenge: loc.searchParams.get('code_challenge') as string,
        redirectUri: `${ORIGIN}/auth/google/callback`,
      });
      const url = `/auth/google/callback?code=${code}&state=${loc.searchParams.get('state')}`;
      const headers = {
        cookie: `__Host-clavis_oauth=${cookiesOf(start)['__Host-clavis_oauth']?.value}`,
      };
      expect((await h.app.request(url, { headers })).headers.get('location')).toBe('/');
      expectFailed(await h.app.request(url, { headers })); // Google refuses the used code
    });

    it('is limited to 20/min/IP', async () => {
      const h = await mk();
      for (let i = 0; i < 20; i++) await h.app.request('/auth/google/callback?error=x');
      expect((await h.app.request('/auth/google/callback?error=x')).status).toBe(429);
    });

    it('a new login revokes the session cookie it replaces', async () => {
      const h = await mk();
      const w = who();
      const first = await webLogin(h, w);
      h.clock.advance(5000);
      const second = await webLogin(h, w, { cookie: first.cookie });
      expect(second.session).not.toBe(first.session);
      expect(
        (await h.app.request('/v1/session', { headers: { cookie: first.cookie } })).status,
      ).toBe(401);
      expect(
        (await h.app.request('/v1/session', { headers: { cookie: second.cookie } })).status,
      ).toBe(200);
    });

    it('reauth records a fresh authenticated_at', async () => {
      const h = await mk();
      const w = who();
      const a = await webLogin(h, w);
      h.clock.advance(20 * 60_000);
      const b = await webLogin(h, w, { reauth: true, cookie: a.cookie });
      const s = SessionResponse.parse(
        await (await h.app.request('/v1/session', { headers: { cookie: b.cookie } })).json(),
      );
      expect(s.authenticatedAt).toBe(h.clock.now());
    });
  });

  describe('sessions', () => {
    it('401 without a cookie or with a bogus one', async () => {
      const h = await mk();
      expect((await h.app.request('/v1/session')).status).toBe(401);
      const r = await h.app.request('/v1/session', {
        headers: { cookie: '__Host-clavis_session=bogus' },
      });
      expect(r.status).toBe(401);
      expect(await code(r)).toBe('UNAUTHENTICATED');
    });

    it('slides on activity (7 days idle) and ends at 30 days absolute', async () => {
      const h = await mk();
      const w = await webLogin(h, who());
      const ok = async () =>
        (await h.app.request('/v1/session', { headers: { cookie: w.cookie } })).status;
      for (let i = 0; i < 4; i++) {
        h.clock.advance(6 * DAY);
        expect(await ok(), `day ${(i + 1) * 6}`).toBe(200);
      }
      h.clock.advance(6 * DAY); // day 30 total: absolute limit reached
      expect(await ok()).toBe(401);
    });

    it('expires after 7 idle days', async () => {
      const h = await mk();
      const w = await webLogin(h, who());
      h.clock.advance(7 * DAY + 1000);
      expect((await h.app.request('/v1/session', { headers: { cookie: w.cookie } })).status).toBe(
        401,
      );
    });

    it('is limited to 120/min/user', async () => {
      const h = await mk();
      const w = await webLogin(h, who());
      for (let i = 0; i < 120; i++)
        await h.app.request('/v1/session', { headers: { cookie: w.cookie } });
      expect((await h.app.request('/v1/session', { headers: { cookie: w.cookie } })).status).toBe(
        429,
      );
    });

    it('GET /v1/account works with the cookie alone (no CSRF on GET)', async () => {
      const h = await mk();
      const w = await webLogin(h, who());
      const r = await h.app.request('/v1/account', { headers: { cookie: w.cookie } });
      expect(r.status).toBe(200);
    });
  });

  describe('CSRF on cookie-authenticated mutations (design 2.5)', () => {
    it('POST /auth/logout succeeds with Origin + token, clears the cookie, and kills the session', async () => {
      const h = await mk();
      const w = await webLogin(h, who());
      const res = await webPost(h, '/auth/logout', w);
      expect(res.status).toBe(204);
      expect(cookiesOf(res)['__Host-clavis_session']?.attrs).toMatch(/Max-Age=0/);
      expect((await h.app.request('/v1/session', { headers: { cookie: w.cookie } })).status).toBe(
        401,
      );
    });

    it('403 CSRF_FAILED without Origin, with a foreign/null Origin, or a lookalike', async () => {
      const h = await mk();
      const w = await webLogin(h, who());
      const post = (origin?: string) =>
        h.app.request('/auth/logout', {
          method: 'POST',
          headers: { cookie: w.cookie, 'x-csrf-token': w.csrf, ...(origin ? { origin } : {}) },
        });
      for (const o of [
        undefined,
        'https://evil.test',
        'null',
        `${ORIGIN}.evil.test`,
        `${ORIGIN}/`,
        'http://clavis-api-production.up.railway.app',
      ]) {
        const r = await post(o);
        expect(r.status, String(o)).toBe(403);
        expect(await code(r)).toBe('CSRF_FAILED');
      }
      // Still signed in after the failed attempts.
      expect((await h.app.request('/v1/session', { headers: { cookie: w.cookie } })).status).toBe(
        200,
      );
    });

    it('403 CSRF_FAILED with a missing, wrong, or other-session token', async () => {
      const h = await mk();
      const w = await webLogin(h, who());
      const other = await webLogin(h, who());
      for (const t of [undefined, '', 'wrong', other.csrf, w.csrf + 'x', w.csrf.slice(1)]) {
        const r = await h.app.request('/auth/logout', {
          method: 'POST',
          headers: {
            cookie: w.cookie,
            origin: ORIGIN,
            ...(t === undefined ? {} : { 'x-csrf-token': t }),
          },
        });
        expect(r.status, String(t)).toBe(403);
        expect(await code(r)).toBe('CSRF_FAILED');
      }
    });

    it('403 CSRF_FAILED when a body is not application/json', async () => {
      const h = await mk();
      const w = await webLogin(h, who());
      const r = await h.app.request('/v1/account/logout-all', {
        method: 'POST',
        headers: {
          cookie: w.cookie,
          origin: ORIGIN,
          'x-csrf-token': w.csrf,
          'content-type': 'text/plain',
        },
        body: 'x=1',
      });
      expect(r.status).toBe(403);
      expect(await code(r)).toBe('CSRF_FAILED');
    });

    it('POST /auth/logout without a session is 401', async () => {
      const h = await mk();
      const r = await h.app.request('/auth/logout', {
        method: 'POST',
        headers: { origin: ORIGIN },
      });
      expect(r.status).toBe(401);
    });

    it('logout-all via cookie needs CSRF, revokes sessions and bearer families, and clears the cookie', async () => {
      const h = await mk();
      const w = who();
      const web = await webLogin(h, w);
      const web2 = await webLogin(h, w);
      const ext = await extSignIn(h, w);
      const noCsrf = await h.app.request('/v1/account/logout-all', {
        method: 'POST',
        headers: { cookie: web.cookie, origin: ORIGIN },
      });
      expect(noCsrf.status).toBe(403);
      const res = await webPost(h, '/v1/account/logout-all', web);
      expect(res.status).toBe(204);
      expect(cookiesOf(res)['__Host-clavis_session']?.attrs).toMatch(/Max-Age=0/);
      for (const c of [web.cookie, web2.cookie]) {
        expect((await h.app.request('/v1/session', { headers: { cookie: c } })).status).toBe(401);
      }
      expect((await h.app.request('/v1/account', { headers: bearer(ext) })).status).toBe(401);
    });

    it('a Bearer header takes precedence and needs no CSRF; it is not satisfied by a bare cookie', async () => {
      const h = await mk();
      const ext = await extSignIn(h, who());
      const web = await webLogin(h, who());
      // Bearer of user A with the cookie of user B: acts as A, B untouched.
      const r = await h.app.request('/v1/account/logout-all', {
        method: 'POST',
        headers: { ...bearer(ext), cookie: web.cookie },
      });
      expect(r.status).toBe(204);
      expect((await h.app.request('/v1/session', { headers: { cookie: web.cookie } })).status).toBe(
        200,
      );
      // A bad Bearer never falls back to the cookie.
      const bad = await h.app.request('/v1/account', {
        headers: { authorization: 'Bearer nope', cookie: web.cookie },
      });
      expect(bad.status).toBe(401);
    });
  });

  it('never logs emails, tokens, cookies, codes or state', async () => {
    const h = await mk();
    const email = 'dashboard.person@example.test';
    const w = await webLogin(h, { sub: 'log-web', email });
    await webPost(h, '/auth/logout', w);
    await h.app.request('/auth/google/callback?code=SECRETCODE&state=SECRETSTATE');
    const all = h.logs.join('\n');
    expect(all.length).toBeGreaterThan(0);
    for (const s of [
      email,
      'Ada Lovelace',
      w.session,
      w.csrf,
      'SECRETCODE',
      'SECRETSTATE',
      'test-client-secret',
      'clavis_oauth',
    ]) {
      expect(all, s).not.toContain(s);
    }
    const routes = h.logs.map((l) => (JSON.parse(l) as { route?: string }).route);
    expect(routes).toEqual(
      expect.arrayContaining([
        '/auth/google/start',
        '/auth/google/callback',
        '/v1/session',
        '/auth/logout',
      ]),
    );
    expect(all).not.toMatch(/\?code=|127\.0\.0\.1|::1/);
  });
});

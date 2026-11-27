import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import {
  DEV_EXT_ID,
  EXT_ORIGIN,
  STORE_EXT_ID,
  cookiesOf,
  createHarness,
  extSignInRaw,
  webLogin,
} from './harness';

describe.skipIf(!adminUrl)('auth hardening (real Postgres, mocked Google)', () => {
  let tdb: TestDb;
  let n = 0;
  const who = () => ({ sub: `hd-${++n}-${Math.random()}`, email: `hd${n}@example.test` });
  const mk = () => createHarness({ db: tdb.handle });
  const authAt = async (cookie: string, h: Awaited<ReturnType<typeof mk>>) =>
    (
      (await (await h.app.request('/v1/session', { headers: { cookie } })).json()) as {
        authenticatedAt: number;
      }
    ).authenticatedAt;

  beforeAll(async () => {
    tdb = await createTestDb(10);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  describe('re-auth is bound to Google auth_time (L2)', () => {
    it('a fresh auth_time moves authenticated_at to auth_time', async () => {
      const h = await mk();
      const w = who();
      const first = await webLogin(h, w);
      h.clock.advance(30 * 60_000);
      const re = await webLogin(h, w, {
        reauth: true,
        cookie: first.cookie,
        authTimeOffsetS: -300,
      });
      expect(re.res.headers.get('location')).toBe('/?reauth=done');
      expect(await authAt(re.cookie, h)).toBe(h.clock.now() - 300_000);
    });

    it('a stale auth_time on the reauth flow fails and does not move authenticated_at forward', async () => {
      const h = await mk();
      const w = who();
      const first = await webLogin(h, w);
      const before = await authAt(first.cookie, h);
      h.clock.advance(30 * 60_000);
      const re = await webLogin(h, w, {
        reauth: true,
        cookie: first.cookie,
        authTimeOffsetS: -3600,
      });
      expect(re.res.headers.get('location')).toBe('/?signin=failed');
      expect(cookiesOf(re.res)['__Host-clavis_session']).toBeUndefined();
      expect(await authAt(first.cookie, h)).toBe(before); // old session intact and unchanged
    });

    it('a reauth token without auth_time, or one from the future, is rejected', async () => {
      const h = await mk();
      const w = who();
      const first = await webLogin(h, w);
      const none = await webLogin(h, w, {
        reauth: true,
        cookie: first.cookie,
        authTimeOffsetS: null,
      });
      expect(none.res.headers.get('location')).toBe('/?signin=failed');
      const future = await webLogin(h, w, {
        reauth: true,
        cookie: first.cookie,
        authTimeOffsetS: 600,
      });
      expect(future.res.headers.get('location')).toBe('/?signin=failed');
    });

    it('auth_time is just inside the 10 minute window at 10m, outside at 12m', async () => {
      const h = await mk();
      const w = who();
      const first = await webLogin(h, w);
      const stale = await webLogin(h, w, {
        reauth: true,
        cookie: first.cookie,
        authTimeOffsetS: -720,
      });
      expect(stale.res.headers.get('location')).toBe('/?signin=failed');
      const ok = await webLogin(h, w, {
        reauth: true,
        cookie: first.cookie,
        authTimeOffsetS: -600,
      });
      expect(ok.res.headers.get('location')).toBe('/?reauth=done');
    });

    it('a normal (non-reauth) login does not require auth_time', async () => {
      const h = await mk();
      const w = await webLogin(h, who());
      expect(w.res.headers.get('location')).toBe('/');
      expect(await authAt(w.cookie, h)).toBe(0); // not a re-auth
    });

    it('the reauth flag lives in the sealed cookie: a reauth cookie cannot be downgraded by the client', async () => {
      const h = await mk();
      const first = await webLogin(h, who());
      const start = await h.app.request('/auth/google/start?reauth=1', {
        headers: { cookie: first.cookie },
      });
      const loc = new URL(start.headers.get('location') as string);
      const code = h.google.issueCode({
        nonce: loc.searchParams.get('nonce') as string,
        codeChallenge: loc.searchParams.get('code_challenge') as string,
        redirectUri: `${h.config.publicOrigin}/auth/google/callback`,
        // Attacker-controlled Google session: no auth_time in the token.
      });
      const res = await h.app.request(
        `/auth/google/callback?code=${code}&state=${loc.searchParams.get('state')}&reauth=0`,
        {
          headers: {
            cookie: `__Host-clavis_oauth=${cookiesOf(start)['__Host-clavis_oauth']?.value}; ${first.cookie}`,
          },
        },
      );
      expect(res.headers.get('location')).toBe('/?signin=failed');
    });
  });

  it('(d) an internal error in the callback redirects to /?signin=failed and clears the state cookie', async () => {
    const h = await mk();
    vi.spyOn(h.google.client, 'verifyIdToken').mockRejectedValue(
      new Error('boom: db password=hunter2'),
    );
    const w = await webLogin(h, who());
    expect(w.res.status).toBe(302);
    expect(w.res.headers.get('location')).toBe('/?signin=failed');
    const c = cookiesOf(w.res);
    expect(c['__Host-clavis_oauth']?.attrs).toMatch(/Max-Age=0/);
    expect(c['__Host-clavis_session']).toBeUndefined();
    expect(h.logs.join('\n')).not.toContain('hunter2');
    expect(h.logs.some((l) => l.includes('SIGNIN_INTERNAL'))).toBe(true);
  });

  it('(a) the redirectUri must belong to the calling extension, not merely any allowed one', async () => {
    const h = await mk();
    expect(h.config.allowedExtensionIds).toEqual([DEV_EXT_ID, STORE_EXT_ID]);
    const res = await extSignInRaw(h, who(), 1, {
      origin: EXT_ORIGIN, // dev extension calling...
      redirectUri: `https://${STORE_EXT_ID}.chromiumapp.org/`, // ...with the store extension's (allowed) redirect
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('OAUTH_FAILED');
    expect(h.google.tokenRequests).toHaveLength(0);
  });
});

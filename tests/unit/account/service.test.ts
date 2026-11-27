import { describe, expect, it } from 'vitest';
import { createAccountService } from '../../../lib/account/service';
import { STORAGE_KEYS } from '../../../lib/storage/keys';
import { FakeServer } from '../sync/fake-server';
import { FP, createClient, createClock } from '../sync/client';

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fresh = () => {
  const clock = createClock();
  const server = new FakeServer({ now: clock.now });
  return { clock, server };
};

describe('sign-in', () => {
  it('builds the authorize URL, exchanges the code and stores the session', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    expect((await client.signIn()).ok).toBe(true);
    const url = new URL(client.launched[0]!);
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://extid.chromiumapp.org/');
    const exchange = server.requests.find((r) => r.path === '/v1/auth/extension/google')!;
    const body = JSON.parse(exchange.body!) as Record<string, string>;
    expect(Object.keys(body).sort()).toEqual(['code', 'codeVerifier', 'nonce', 'redirectUri']);
    expect(body['nonce']).toBe(url.searchParams.get('nonce'));
    expect(body['redirectUri']).toBe('https://extid.chromiumapp.org/');
    const status = await client.service.getStatus();
    expect(status).toMatchObject({ enabled: true, signedIn: true, email: 'a@example.test' });
    expect(client.alarms.active.has('clavis-sync')).toBe(true);
  });

  it('reports not configured without a client id, and when accounts are off', async () => {
    const { server } = fresh();
    const noId = createClient(server, { googleClientId: '' });
    expect(await noId.service.signIn()).toEqual({ ok: false, code: 'NOT_CONFIGURED' });
    const off = createClient(server, { enabled: false });
    expect(await off.service.signIn()).toEqual({ ok: false, code: 'NOT_CONFIGURED' });
    expect(await off.service.getStatus()).toMatchObject({ enabled: false, signedIn: false });
    expect(server.requests).toHaveLength(0);
    expect(noId.launched).toHaveLength(0);
  });

  it('cancelled by the user, a state mismatch, a refused code, a network error and an unverified email', async () => {
    const { server } = fresh();
    const cases: {
      name: string;
      launch: (url: string) => Promise<string | undefined>;
      expected: string;
    }[] = [
      {
        name: 'window closed',
        launch: () => Promise.reject(new Error('The user did not approve access.')),
        expected: 'CANCELLED',
      },
      {
        name: 'access_denied',
        launch: (u) =>
          Promise.resolve(
            `https://extid.chromiumapp.org/?error=access_denied&state=${new URL(u).searchParams.get('state')}`,
          ),
        expected: 'CANCELLED',
      },
      {
        name: 'wrong state',
        launch: () => Promise.resolve('https://extid.chromiumapp.org/?code=x&state=nope'),
        expected: 'OAUTH_FAILED',
      },
      {
        name: 'load failure',
        launch: () => Promise.reject(new Error('Authorization page could not be loaded.')),
        expected: 'OAUTH_FAILED',
      },
    ];
    for (const c of cases) {
      const client = createClientWith(server, c.launch);
      expect(await client.service.signIn(), c.name).toEqual({ ok: false, code: c.expected });
      expect(await client.service.getStatus()).toMatchObject({ signedIn: false });
    }
    const refused = createClient(server);
    server.failNext(
      '/v1/auth/extension/google',
      () =>
        new Response(JSON.stringify({ error: { code: 'OAUTH_FAILED', message: 'x' } }), {
          status: 400,
        }),
    );
    expect(await refused.service.signIn()).toEqual({ ok: false, code: 'OAUTH_FAILED' });
    server.failNext(
      '/v1/auth/extension/google',
      () =>
        new Response(JSON.stringify({ error: { code: 'EMAIL_NOT_VERIFIED', message: 'x' } }), {
          status: 403,
        }),
    );
    expect(await refused.service.signIn()).toEqual({ ok: false, code: 'EMAIL_NOT_VERIFIED' });
    server.failNext('/v1/auth/extension/google', () => {
      throw new TypeError('offline');
    });
    expect(await refused.service.signIn()).toEqual({ ok: false, code: 'NETWORK_ERROR' });
    expect(refused.local.data.has(STORAGE_KEYS.accountSession)).toBe(false);
  });
});

function createClientWith(
  server: FakeServer,
  launch: (url: string) => Promise<string | undefined>,
) {
  const client = createClient(server);
  // A service whose Google window answers as scripted; everything else is the real client's.
  const service = createAccountService({
    config: {
      apiOrigin: 'https://api.test',
      googleClientId: 'cid',
      googleAuthUrl: 'https://accounts.example/a',
      googleLoginHint: undefined,
    },
    api: client.api,
    tokens: client.tokens,
    store: client.store,
    state: client.state,
    engine: client.engine,
    local: client.local,
    identity: {
      getRedirectURL: () => 'https://extid.chromiumapp.org/',
      launchWebAuthFlow: ({ url }) => launch(url),
    },
    enabled: true,
    notify: () => undefined,
  });
  return { ...client, service };
}

describe('first sign-in merge (design 4.7)', () => {
  it('marks every local record dirty, pushes them all, then pulls', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    client.bind();
    // Data made while signed out: no dirty flags (writers use signedIn=false).
    const { putWord } = await import('../../../lib/data/words');
    const { saveProgress } = await import('../../../lib/data/documents');
    const { wordKey } = await import('../sync/fake-server');
    const { sampleWord } = await import('../data/fixtures');
    const key = await wordKey('bank');
    await putWord(key, sampleWord({ createdAt: clock.now() }), {
      now: clock.now,
      signedIn: () => Promise.resolve(false),
    });
    await saveProgress(
      FP,
      { title: 'T', pageCount: 3, fileBytes: 9, lastPage: 2, pageOffset: 0 },
      { now: clock.now, signedIn: () => Promise.resolve(false) },
    );
    expect((await client.dump()).words[0]).toMatchObject({ dirty: 0, seq: null });

    await client.service.signIn();
    // Everything is dirty right after the merge, before the first sync finished.
    await client.engine.syncNow();
    const user = [...server.users.values()][0]!;
    expect(user.words.has(key)).toBe(true);
    expect(user.documents.has(FP)).toBe(true);
    const paths = server.requests.map((r) => r.path).filter((p) => p.startsWith('/v1/sync'));
    expect(paths.indexOf('/v1/sync/push')).toBeLessThan(paths.indexOf('/v1/sync/pull'));
    expect((await client.dump()).words[0]).toMatchObject({ dirty: 0 });
    expect((await client.state.read())?.accountId).toBe(user.id);
  });

  it('after keeping a copy, the next account receives it (consent is the sign-in)', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    await client.signIn();
    const key = await client.saveWord('bank');
    await client.sync();
    await client.service.signOut(true);
    client.setEmail('b@example.test');
    await client.signIn();
    const b = server.user('b@example.test');
    expect(b.words.has(key)).toBe(true);
    expect(server.user('a@example.test').id).not.toBe(b.id);
  });
});

describe('sign-out (design 4.7)', () => {
  async function setup() {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    await client.signIn();
    const key = await client.saveWord('bank');
    await client.chat(key, UUID(1));
    await client.progress(FP, 3);
    await client.highlight(FP, UUID(2));
    return { client, server, key };
  }

  it('default: final push, logout, tokens and sync-state gone, local data wiped, cloud copy kept', async () => {
    const { client, server, key } = await setup();
    const result = await client.service.signOut(false);
    expect(result).toEqual({ ok: true, unsyncedDropped: 0 });
    const user = [...server.users.values()][0]!;
    expect(user.words.has(key)).toBe(true); // the final push got it there
    expect(server.requests.some((r) => r.path === '/v1/auth/extension/logout')).toBe(true);
    expect(client.local.keys()).not.toContain(STORAGE_KEYS.accountSession);
    expect(client.local.keys()).not.toContain(STORAGE_KEYS.syncState);
    expect(client.session.keys()).toEqual([]);
    expect(await client.dump()).toEqual({ words: [], chat: [], documents: [], highlights: [] });
    expect(client.alarms.active.size).toBe(0);
    expect(await client.service.getStatus()).toMatchObject({ signedIn: false });
  });

  it('keep a copy: local data stays, unbound (no dirty, no seq, no tombstones)', async () => {
    const { client, key } = await setup();
    await client.removeWord(key); // a tombstone waiting for a push
    const server = client.server;
    server.failNext('/v1/sync/push', () => new Response('', { status: 500 }), 5);
    const result = await client.service.signOut(true);
    expect(result).toEqual({ ok: true, unsyncedDropped: 0 });
    const dump = await client.dump();
    expect(dump.words).toEqual([]); // the tombstone went
    expect(dump.documents[0]).toMatchObject({ dirty: 0, seq: null, deleted: 0 });
    expect(dump.highlights[0]).toMatchObject({ dirty: 0, seq: null });
  });

  it('reports unsynced changes dropped when the final push could not finish', async () => {
    const { client, server } = await setup();
    server.failNext('/v1/sync/push', () => new Response('', { status: 503 }), 5);
    const status = await client.service.getStatus();
    expect(status.sync.pending).toBeGreaterThan(0); // the UI shows "N changes are not synced yet" from this
    const result = await client.service.signOut(false);
    expect(result.ok && result.unsyncedDropped).toBeGreaterThan(0);
    expect(await client.dump()).toEqual({ words: [], chat: [], documents: [], highlights: [] });
  });

  it('works when the logout call fails (best effort)', async () => {
    const { client, server } = await setup();
    server.failNext('/v1/auth/extension/logout', () => {
      throw new TypeError('offline');
    });
    expect((await client.service.signOut(false)).ok).toBe(true);
    expect(await client.service.getStatus()).toMatchObject({ signedIn: false });
  });

  it('sign out everywhere revokes the account, then signs out here keeping the data', async () => {
    const { client, server } = await setup();
    expect(await client.service.signOutEverywhere()).toEqual({ ok: true });
    expect(server.requests.some((r) => r.path === '/v1/account/logout-all')).toBe(true);
    expect(await client.service.getStatus()).toMatchObject({ signedIn: false });
    expect((await client.dump()).words).toHaveLength(1);
  });

  it('sign out everywhere that cannot reach the server leaves the device signed in', async () => {
    const { client, server } = await setup();
    server.failNext('/v1/account/logout-all', () => {
      throw new TypeError('offline');
    });
    expect(await client.service.signOutEverywhere()).toEqual({ ok: false, code: 'NETWORK_ERROR' });
    expect(await client.service.getStatus()).toMatchObject({ signedIn: true });
  });

  it('account switching: the default sign-out then a sign-in starts the new account clean', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    await client.signIn();
    const key = await client.saveWord('bank');
    await client.sync();
    await client.service.signOut(false);
    client.setEmail('b@example.test');
    await client.signIn();
    expect(server.user('b@example.test').words.has(key)).toBe(false);
    expect((await client.dump()).words).toHaveLength(0);
  });
});

describe('ACCOUNT_GET_STATUS', () => {
  it('never contains a token, whatever state the device is in', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    await client.signIn();
    await client.saveWord('bank');
    const session = JSON.stringify(client.local.data.get(STORAGE_KEYS.accountSession));
    const refresh = (JSON.parse(session) as { data: { refreshToken: string } }).data.refreshToken;
    const access = (
      client.session.data.get(STORAGE_KEYS.accountAccess) as { data: { accessToken: string } }
    ).data.accessToken;
    const status = JSON.stringify(await client.service.getStatus());
    expect(status).not.toContain(refresh);
    expect(status).not.toContain(access);
    expect(status).not.toMatch(/crt_|acc-|[Tt]oken/);
    expect(Object.keys(JSON.parse(status) as object).sort()).toEqual([
      'email',
      'enabled',
      'signedIn',
      'sync',
      'usage', // the server's stored-PDF usage: numbers only
    ]);
  });
});

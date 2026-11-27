import { describe, expect, it } from 'vitest';
import { STORAGE_KEYS } from '../../../lib/storage/keys';
import { SessionLostError, StorageLockedError } from '../../../lib/account/tokens';
import { FakeServer } from '../sync/fake-server';
import { createClient, createClock } from '../sync/client';

async function signedIn(clock = createClock()) {
  const server = new FakeServer({ now: clock.now, accessTtlMs: 15 * 60_000 });
  const client = createClient(server, { clock });
  client.bind();
  expect((await client.service.signIn()).ok).toBe(true);
  return { client, server };
}

describe('token storage', () => {
  it('the refresh token is in storage.local and the access token in storage.session, nowhere else', async () => {
    const { client } = await signedIn();
    expect([...client.local.data.keys()]).toContain(STORAGE_KEYS.accountSession);
    expect([...client.local.data.keys()]).not.toContain(STORAGE_KEYS.accountAccess);
    expect([...client.session.data.keys()]).toEqual([STORAGE_KEYS.accountAccess]);
    const record = client.local.data.get(STORAGE_KEYS.accountSession) as {
      data: { refreshToken: string };
    };
    expect(record.data.refreshToken).toMatch(/^crt_/);
  });

  it('refuses to read tokens until the storage lockdown succeeded (R3), but always allows deleting them', async () => {
    const server = new FakeServer();
    const unlocked = createClient(server, { lockedDown: () => Promise.resolve(false) });
    await expect(unlocked.store.readSession()).rejects.toBeInstanceOf(StorageLockedError);
    await expect(unlocked.store.readAccess()).rejects.toBeInstanceOf(StorageLockedError);
    await expect(unlocked.store.clear()).resolves.toBeUndefined();
  });
});

describe('refresh', () => {
  it('uses the stored access token while it is valid', async () => {
    const { client, server } = await signedIn();
    server.requests.length = 0;
    await client.tokens.accessToken();
    expect(server.requests).toHaveLength(0);
  });

  it('refreshes when the access token is about to expire, and concurrent callers share one refresh', async () => {
    const { client, server } = await signedIn();
    client.clock.advance(15 * 60_000 - 30_000);
    server.requests.length = 0;
    const tokens = await Promise.all([
      client.tokens.accessToken(),
      client.tokens.accessToken(),
      client.tokens.accessToken(),
    ]);
    expect(new Set(tokens).size).toBe(1);
    expect(server.requests.filter((r) => r.path === '/v1/auth/extension/refresh')).toHaveLength(1);
  });

  it('rotation: the new refresh token replaces the old one', async () => {
    const { client } = await signedIn();
    const before = (
      client.local.data.get(STORAGE_KEYS.accountSession) as { data: { refreshToken: string } }
    ).data.refreshToken;
    client.clock.advance(14 * 60_000 + 30_000);
    await client.tokens.accessToken();
    const after = (
      client.local.data.get(STORAGE_KEYS.accountSession) as { data: { refreshToken: string } }
    ).data.refreshToken;
    expect(after).not.toBe(before);
  });

  it('a 401 on a call refreshes once and repeats the call', async () => {
    const { client, server } = await signedIn();
    server.requests.length = 0;
    // The server forgets the access token (restart): the first call is a 401.
    (server as unknown as { access: Map<string, unknown> }).access.clear();
    await client.tokens
      .request({ method: 'POST', path: '/v1/account/logout-all' })
      .catch(() => undefined);
    expect(server.requests.map((r) => r.path)).toEqual([
      '/v1/account/logout-all',
      '/v1/auth/extension/refresh',
      '/v1/account/logout-all',
    ]);
  });

  it('TOKEN_REUSED signs out locally keeping a copy, with a notice', async () => {
    const { client, server } = await signedIn();
    await client.saveWord('bank');
    // The server saw this refresh token used already.
    const session = (
      client.local.data.get(STORAGE_KEYS.accountSession) as { data: { refreshToken: string } }
    ).data.refreshToken;
    (server as unknown as { refresh: Map<string, { used: boolean }> }).refresh.get(session)!.used =
      true;
    client.clock.advance(15 * 60_000);
    await expect(client.tokens.accessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect(client.local.data.has(STORAGE_KEYS.accountSession)).toBe(false);
    expect(client.session.data.has(STORAGE_KEYS.accountAccess)).toBe(false);
    expect(client.local.data.has(STORAGE_KEYS.syncState)).toBe(false);
    const status = await client.service.getStatus();
    expect(status).toMatchObject({ signedIn: false, notice: 'session-ended' });
    // The data is kept, unbound.
    const dump = await client.dump();
    expect(dump.words).toHaveLength(1);
    expect(dump.words[0]).toMatchObject({ dirty: 0, seq: null });
  });

  it('TOKEN_REUSED while a newer token is already stored (a raced refresh) is not a sign-out', async () => {
    const { client, server } = await signedIn();
    const record = client.local.data.get(STORAGE_KEYS.accountSession) as {
      v: 1;
      data: { refreshToken: string };
    };
    const stale = record.data.refreshToken;
    // Make the server see the stored token as used, and put a fresh valid one in storage mid-flight.
    (server as unknown as { refresh: Map<string, { used: boolean }> }).refresh.get(stale)!.used =
      true;
    const fresh = (await server
      .fetch('https://api.test/v1/auth/extension/google', {
        method: 'POST',
        body: JSON.stringify({ code: 'code-a@example.test' }),
      })
      .then((r) => r.json())) as {
      refreshToken: string;
      accessToken: string;
      accessTokenExpiresAt: number;
    };
    const original = server.after;
    let swapped = false;
    server.after = async (request) => {
      if (swapped || !request.path.endsWith('/refresh')) return original?.(request);
      swapped = true;
      client.local.data.set(STORAGE_KEYS.accountSession, {
        v: 1,
        data: { ...record.data, refreshToken: fresh.refreshToken },
      });
    };
    client.clock.advance(15 * 60_000);
    await expect(client.tokens.accessToken()).resolves.toMatch(/^acc-/);
    expect(client.local.data.has(STORAGE_KEYS.accountSession)).toBe(true);
  });

  it('SESSION_REVOKED and a failed refresh (UNAUTHENTICATED) both end the session locally', async () => {
    for (const revoke of [
      (s: FakeServer) => s.revokeAll(),
      (s: FakeServer) => (s as unknown as { refresh: Map<string, unknown> }).refresh.clear(),
    ]) {
      const { client, server } = await signedIn();
      revoke(server);
      client.clock.advance(15 * 60_000);
      await expect(client.tokens.accessToken()).rejects.toBeInstanceOf(SessionLostError);
      expect((await client.service.getStatus()).notice).toBe('session-ended');
    }
  });

  it('a network failure during refresh is transient: the session stays', async () => {
    const { client, server } = await signedIn();
    client.clock.advance(15 * 60_000);
    server.failNext('/refresh', () => new Response('', { status: 503 }));
    await expect(client.tokens.accessToken()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(client.local.data.has(STORAGE_KEYS.accountSession)).toBe(true);
  });
});

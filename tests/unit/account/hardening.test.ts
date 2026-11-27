import { describe, expect, it } from 'vitest';
import { createApiClient } from '../../../lib/account/api';
import { SYNC } from '../../../lib/config/constants';
import { STORAGE_KEYS } from '../../../lib/storage/keys';
import { SessionLostError } from '../../../lib/account/tokens';
import { FakeServer } from '../sync/fake-server';
import { FP, createClient, createClock } from '../sync/client';
import { createHarness, pageSender } from '../router/harness';

// Security review of P2 (M1, M2, L1, L3, L4): nothing waits on the network forever, sign-out
// everywhere only reports what happened, backoff cannot be switched off by the server, and a late
// token refresh or sign-in cannot undo a sign-out.

const hangingBody = (): Response =>
  new Response(new ReadableStream({ start() {} }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
const json = (body: unknown, headers: Record<string, string> = {}, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const fresh = () => {
  const clock = createClock();
  return { clock, server: new FakeServer({ now: clock.now }) };
};

describe('M1: nothing waits on the network forever', () => {
  it('the timeout covers the body: a server that sends headers and then stalls fails the request', async () => {
    const api = createApiClient({
      origin: 'https://api.test',
      timeoutMs: 50,
      // Ignores `signal` on purpose: the client must still give up.
      fetch: () => Promise.resolve(hangingBody()),
    });
    const { z } = await import('zod');
    await expect(
      api.request({ method: 'GET', path: '/v1/meta', response: z.object({}) }),
    ).rejects.toMatchObject({ code: 'NETWORK' });
    await expect(api.request({ method: 'POST', path: '/x' })).resolves.toBeUndefined();
  });

  it('a stalled error body does not hold the caller either', async () => {
    const api = createApiClient({
      origin: 'https://api.test',
      timeoutMs: 50,
      fetch: () =>
        Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 503 })),
    });
    await expect(api.request({ method: 'GET', path: '/x' })).rejects.toMatchObject({ status: 503 });
  });

  it('CLEAR_ALL_DATA completes when the sign-out hangs on a stalled response body', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock, apiTimeoutMs: 200 });
    await client.signIn();
    await client.saveWord('bank');
    server.failNext('/v1/sync/push', hangingBody, 10);
    server.failNext('/v1/auth/extension/logout', hangingBody, 10);
    const h = createHarness({
      signOutFirst: async () => {
        await client.service.signOut(false);
      },
      signOutTimeoutMs: 5_000,
    });
    const started = Date.now();
    const reply = await h.call({ v: 1, type: 'CLEAR_ALL_DATA' }, pageSender('/options.html'));
    expect(reply).toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  it('CLEAR_ALL_DATA stops waiting for a sign-out that never ends, then clears (tokens and sync state with it)', async () => {
    let invalidated = false;
    const h = createHarness({
      signOutFirst: () => new Promise<void>(() => undefined),
      signOutTimeoutMs: 50,
      invalidateAccount: () => {
        invalidated = true;
      },
    });
    await h.local.set({
      [STORAGE_KEYS.accountSession]: { v: 1, data: {} },
      [STORAGE_KEYS.syncState]: { accountId: 'a' },
    });
    await h.session.set({ [STORAGE_KEYS.accountAccess]: { v: 1, data: {} } });
    const reply = await h.call({ v: 1, type: 'CLEAR_ALL_DATA' }, pageSender('/options.html'));
    expect(reply).toMatchObject({ ok: true });
    expect(invalidated).toBe(true);
    expect(h.local.keys()).toEqual([]);
    expect(h.session.keys()).toEqual([]);
  });

  it('a server that always says hasMore with an advancing cursor ends the run with an error and a retry', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock, maxPullPages: 5 });
    await client.signIn();
    let n = 0;
    server.requests.length = 0;
    server.failNext(
      '/v1/sync/pull',
      () => json({ changes: [], nextCursor: String((n += 1)), hasMore: true }),
      1000,
    );
    const result = await client.sync();
    expect(result).toMatchObject({ status: 'error' });
    expect(server.requests.filter((r) => r.path === '/v1/sync/pull')).toHaveLength(5);
    expect(client.alarms.created.some((a) => a.name === SYNC.retryAlarmName)).toBe(true);
  });

  it('a stalled logout does not hold the sign-out past its budget', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock, apiTimeoutMs: 100 });
    await client.signIn();
    server.failNext('/v1/auth/extension/logout', hangingBody, 1);
    const result = await client.service.signOut(false);
    expect(result.ok).toBe(true);
    expect(await client.service.getStatus()).toMatchObject({ signedIn: false });
  }, 10_000);
});

describe('M2: sign out everywhere only says ok when something happened', () => {
  it('locked storage is STORAGE_UNAVAILABLE and the device stays signed in', async () => {
    const { clock, server } = fresh();
    let locked = true;
    const client = createClient(server, { clock, lockedDown: () => Promise.resolve(locked) });
    await client.signIn();
    locked = false;
    expect(await client.service.signOutEverywhere()).toEqual({
      ok: false,
      code: 'STORAGE_UNAVAILABLE',
    });
    locked = true;
    expect(await client.service.getStatus()).toMatchObject({ signedIn: true });
  });

  it('missing tokens on a bound device: NOT_SIGNED_IN, and the device is detached locally', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    await client.signIn();
    client.local.data.delete(STORAGE_KEYS.accountSession);
    client.session.data.delete(STORAGE_KEYS.accountAccess);
    expect(await client.service.signOutEverywhere()).toEqual({ ok: false, code: 'NOT_SIGNED_IN' });
    expect(await client.service.getStatus()).toMatchObject({ signedIn: false });
  });

  it('a session that ended on its own counts as done; an unexpected error is INTERNAL_ERROR', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    await client.signIn();
    server.revokeAll();
    expect(await client.service.signOutEverywhere()).toEqual({ ok: true });
    const other = createClient(server, { clock, email: 'x@example.test' });
    await other.signIn();
    const original = other.tokens.request;
    (other.tokens as { request: unknown }).request = () => Promise.reject(new TypeError('boom'));
    expect(await other.service.signOutEverywhere()).toEqual({ ok: false, code: 'INTERNAL_ERROR' });
    (other.tokens as { request: unknown }).request = original;
  });
});

describe('L1: Retry-After cannot switch backoff off', () => {
  it('repeated 503 with Retry-After 0 still backs off 1, 2, 4 minutes', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    await client.signIn();
    await client.saveWord('bank');
    server.failNext(
      '/v1/sync/push',
      () => json({ error: { code: 'UNAVAILABLE', message: 'x' } }, { 'Retry-After': '0' }, 503),
      3,
    );
    const retryAt: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      await client.sync();
      retryAt.push(((await client.state.read())?.retryAt ?? 0) - clock.now());
    }
    expect(retryAt).toEqual([60_000, 120_000, 240_000]);
  });

  it('a longer server hint still wins', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    await client.signIn();
    await client.saveWord('bank');
    server.failNext('/v1/sync/push', () =>
      json({ error: { code: 'RATE_LIMITED', message: 'x' } }, { 'Retry-After': '600' }, 429),
    );
    await client.sync();
    expect(((await client.state.read())?.retryAt ?? 0) - clock.now()).toBe(600_000);
  });
});

describe('L3: tokens cannot be resurrected after sign-out or clear', () => {
  it('a refresh that finishes after a sign-out writes nothing back', async () => {
    const clock = createClock();
    const server = new FakeServer({ now: clock.now, accessTtlMs: 15 * 60_000 });
    const client = createClient(server, { clock });
    await client.signIn();
    clock.advance(15 * 60_000);
    // The server answers the refresh; before the client sees it, the user signs out.
    let signedOut: Promise<unknown> | undefined;
    server.after = (request) => {
      if (!request.path.endsWith('/refresh') || signedOut !== undefined) return Promise.resolve();
      signedOut = client.service.signOut(true);
      return signedOut.then(() => undefined);
    };
    await expect(client.tokens.accessToken()).rejects.toBeInstanceOf(SessionLostError);
    await signedOut;
    expect(client.local.data.has(STORAGE_KEYS.accountSession)).toBe(false);
    expect(client.session.data.has(STORAGE_KEYS.accountAccess)).toBe(false);
    expect(await client.service.getStatus()).toMatchObject({ signedIn: false });
    // Not reported as an ended session: the user chose it.
    expect((await client.service.getStatus()).notice).toBeUndefined();
  });

  it('a refresh refused after a sign-out is not reported as a lost session either', async () => {
    const clock = createClock();
    const server = new FakeServer({ now: clock.now, accessTtlMs: 15 * 60_000 });
    const client = createClient(server, { clock });
    await client.signIn();
    clock.advance(15 * 60_000);
    server.revokeAll(); // the refresh will be answered SESSION_REVOKED
    let once = false;
    server.after = async () => {
      if (once) return;
      once = true;
      await client.service.signOut(false);
    };
    await expect(client.tokens.accessToken()).rejects.toBeInstanceOf(SessionLostError);
    expect((await client.service.getStatus()).notice).toBeUndefined();
  });

  it('a sign-in that finishes after CLEAR_ALL_DATA does not bind the device again', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    client.bind();
    // Google's window is open; CLEAR_ALL_DATA runs meanwhile (it invalidates, then clears).
    const original = client.launched;
    void original;
    server.after = async (request) => {
      if (request.path === '/v1/auth/extension/google') client.service.invalidate();
    };
    const result = await client.service.signIn();
    expect(result).toEqual({ ok: false, code: 'CANCELLED' });
    expect(client.local.data.has(STORAGE_KEYS.accountSession)).toBe(false);
    expect(client.local.data.has(STORAGE_KEYS.syncState)).toBe(false);
    expect(client.session.keys()).toEqual([]);
  });

  it('a sign-out while the Google window is open cancels that sign-in', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    client.bind();
    server.after = async (request) => {
      if (request.path === '/v1/auth/extension/google') await client.service.signOut(true);
    };
    expect(await client.service.signIn()).toEqual({ ok: false, code: 'CANCELLED' });
    expect(await client.service.getStatus()).toMatchObject({ signedIn: false });
  });
});

describe('L4: a bound device whose tokens are gone recovers', () => {
  it('signs out locally keeping the data, and shows the notice', async () => {
    const { clock, server } = fresh();
    const client = createClient(server, { clock });
    await client.signIn();
    await client.saveWord('bank');
    await client.progress(FP, 3);
    client.local.data.delete(STORAGE_KEYS.accountSession);
    client.session.data.delete(STORAGE_KEYS.accountAccess);
    expect(await client.sync()).toEqual({ status: 'signed-out' });
    const status = await client.service.getStatus();
    expect(status).toMatchObject({ signedIn: false, notice: 'session-ended' });
    expect(client.local.data.has(STORAGE_KEYS.syncState)).toBe(false);
    const dump = await client.dump();
    expect(dump.words).toHaveLength(1);
    expect(dump.words[0]).toMatchObject({ dirty: 0, seq: null });
    expect(dump.documents).toHaveLength(1);
  });
});

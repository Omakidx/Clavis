import { describe, expect, it } from 'vitest';
import { SYNC } from '../../../lib/config/constants';
import { ApiRequestError } from '../../../lib/account/api';
import { createSyncEngine } from '../../../lib/sync/engine';
import { countPending } from '../../../lib/sync/store';
import { FakeServer } from './fake-server';
import { FP, createClient, createClock } from './client';

/** Local edits need a later timestamp than the record they replace (the clock is frozen in tests). */
const clientTick = (c: { clock: { advance(ms: number): void } }): void => c.clock.advance(1_000);

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

async function signedIn(
  options: Parameters<typeof createClient>[1] = {},
  server = new FakeServer(),
) {
  const clock = options.clock ?? createClock();
  const server2 = server;
  const client = createClient(server2, { ...options, clock });
  expect((await client.signIn()).ok).toBe(true);
  return { client, server: server2, clock };
}

describe('scheduling', () => {
  it('debounces the push 5 s after SYNC_KICK and coalesces kicks', async () => {
    const { client, server } = await signedIn();
    await client.saveWord('bank');
    server.requests.length = 0;
    await client.engine.kick();
    await client.engine.kick();
    await client.engine.kick();
    const live = client.timers.filter((t) => !t.cancelled);
    expect(live).toHaveLength(1);
    expect(live[0]!.ms).toBe(SYNC.pushDebounceMs);
    expect(server.requests).toHaveLength(0);
    live[0]!.fn();
    await client.engine.syncNow(); // waits behind the debounced run
    expect(server.requests.filter((r) => r.path === '/v1/sync/push')).toHaveLength(1);
  });

  it('a kick with pull:true runs at once, but not within the minimum gap of the last pull', async () => {
    const { client, server, clock } = await signedIn();
    server.requests.length = 0;
    await client.engine.kick(true); // last pull was just now: debounced instead
    expect(server.requests).toHaveLength(0);
    clock.advance(SYNC.pullKickMinGapMs + 1);
    await client.engine.kick(true);
    await client.engine.syncNow();
    expect(server.requests.some((r) => r.path === '/v1/sync/pull')).toBe(true);
  });

  it('pulls after a push, and the 30 minute alarm exists while signed in', async () => {
    const { client, server } = await signedIn();
    expect(client.alarms.created.find((a) => a.name === SYNC.alarmName)?.info).toMatchObject({
      periodInMinutes: 30,
    });
    await client.saveWord('bank');
    server.requests.length = 0;
    await client.sync();
    expect(server.requests.map((r) => r.path)).toEqual(['/v1/sync/push', '/v1/sync/pull']);
  });

  it('the alarm and onStartup start a run; other alarms are ignored', async () => {
    const { client, server } = await signedIn();
    server.requests.length = 0;
    await client.engine.onAlarm('something-else');
    expect(server.requests).toHaveLength(0);
    await client.engine.onAlarm(SYNC.alarmName);
    expect(server.requests.some((r) => r.path === '/v1/sync/pull')).toBe(true);
    server.requests.length = 0;
    await client.engine.onStartup();
    expect(server.requests.some((r) => r.path === '/v1/sync/pull')).toBe(true);
  });

  it('does nothing when accounts are off or signed out', async () => {
    const server = new FakeServer();
    const off = createClient(server, { enabled: false });
    await off.engine.kick(true);
    expect(await off.engine.syncNow()).toEqual({ status: 'disabled' });
    const out = createClient(server);
    out.bind();
    expect(await out.engine.syncNow()).toEqual({ status: 'signed-out' });
    expect(server.requests).toHaveLength(0);
  });

  it('one run at a time: runs go through the sync lock', async () => {
    const order: string[] = [];
    const locks = {
      async request<T>(name: string, cb: () => Promise<T>): Promise<T> {
        order.push(`lock:${name}`);
        return cb();
      },
    };
    const { client } = await signedIn({ locks });
    order.length = 0;
    await client.sync();
    expect(order).toEqual([`lock:${SYNC.lockName}`]);
  });

  it('a kick while a run is in flight gets its own run afterwards', async () => {
    const { client, server } = await signedIn();
    await client.saveWord('bank');
    server.requests.length = 0;
    const first = client.sync();
    await client.saveWord('river');
    const second = client.sync();
    await Promise.all([first, second]);
    expect(await countPending()).toBe(0);
  });
});

describe('backoff', () => {
  it('backs off 1, 2, 4 ... minutes with a one-shot alarm, and clears it on success', async () => {
    const { client, server, clock } = await signedIn();
    await client.saveWord('bank');
    server.failNext('/v1/sync/push', () => new Response('', { status: 500 }), 3);
    const delays: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const result = await client.sync();
      expect(result).toMatchObject({ status: 'error' });
      const alarm = client.alarms.created.filter((a) => a.name === SYNC.retryAlarmName).at(-1)!;
      delays.push((alarm.info['when'] as number) - clock.now());
    }
    expect(delays).toEqual([60_000, 120_000, 240_000]);
    expect(await client.sync()).toEqual({ status: 'ok' });
    expect(client.alarms.cleared).toContain(SYNC.retryAlarmName);
  });

  it('caps at 60 minutes', async () => {
    const { client, server, clock } = await signedIn();
    await client.saveWord('bank');
    server.failNext('/v1/sync/push', () => new Response('', { status: 503 }), 10);
    let last = 0;
    for (let i = 0; i < 9; i += 1) {
      await client.sync();
      last =
        (client.alarms.created.filter((a) => a.name === SYNC.retryAlarmName).at(-1)!.info[
          'when'
        ] as number) - clock.now();
    }
    expect(last).toBe(3_600_000);
  });

  it('honours Retry-After on 429 and 503, and kicks wait for the retry alarm', async () => {
    const { client, server, clock } = await signedIn();
    await client.saveWord('bank');
    server.failNext(
      '/v1/sync/push',
      () =>
        new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'x' } }), {
          status: 429,
          headers: { 'Retry-After': '120' },
        }),
    );
    const result = await client.sync();
    expect(result).toEqual({ status: 'error', code: 'RATE_LIMITED' });
    const alarm = client.alarms.created.filter((a) => a.name === SYNC.retryAlarmName).at(-1)!;
    expect((alarm.info['when'] as number) - clock.now()).toBe(120_000);
    const before = client.timers.length;
    await client.engine.kick();
    expect(client.timers.length).toBe(before); // in backoff: no debounced push
    const status = await client.engine.status();
    expect(status.state).toBe('error');
  });

  it('a network failure reads as offline', async () => {
    const { client, server } = await signedIn();
    await client.saveWord('bank');
    server.failNext('/v1/sync/push', () => {
      throw new TypeError('failed to fetch');
    });
    expect(await client.sync()).toEqual({ status: 'error', code: 'NETWORK' });
    expect((await client.engine.status()).state).toBe('offline');
  });
});

describe('backoff survives a service worker restart', () => {
  it('the failure count and retry time are persisted, so a restarted worker continues the sequence', async () => {
    const { client, server, clock } = await signedIn();
    await client.saveWord('bank');
    server.failNext('/v1/sync/push', () => new Response('', { status: 500 }), 5);
    await client.sync();
    await client.sync();
    expect(await client.state.read()).toMatchObject({ failures: 2 });
    // A new worker: a fresh engine over the same storage.
    const restarted = createSyncEngine({
      tokens: client.tokens,
      state: client.state,
      alarms: client.alarms as never,
      enabled: true,
      onSessionLost: () => client.service.sessionLost(),
      now: clock.now,
      setTimer: () => ({}),
      clearTimer: () => undefined,
      notify: () => undefined,
    });
    // Kicks during backoff do not start a push.
    const before = server.requests.length;
    await restarted.kick();
    await restarted.kick(true);
    expect(server.requests.length).toBe(before);
    expect(await restarted.syncNow()).toMatchObject({ status: 'error' });
    const alarm = client.alarms.created.filter((a) => a.name === SYNC.retryAlarmName).at(-1)!;
    expect((alarm.info['when'] as number) - clock.now()).toBe(240_000);
    // Success resets it.
    expect(await restarted.syncNow()).toBeDefined();
    server.failures.length = 0;
    expect(await restarted.syncNow()).toEqual({ status: 'ok' });
    expect((await client.state.read())?.failures).toBeUndefined();
    expect((await client.state.read())?.retryAt).toBeUndefined();
  });
});

describe('push', () => {
  it('orders a batch documents, highlights, words, chat, in batches of at most 200', async () => {
    const { client, server } = await signedIn();
    const key = await client.saveWord('bank');
    await client.chat(key, UUID(1));
    await client.progress(FP, 3);
    await client.highlight(FP, UUID(2));
    server.requests.length = 0;
    await client.sync();
    const push = server.requests.find((r) => r.path === '/v1/sync/push')!;
    const kinds = (JSON.parse(push.body!) as { changes: { kind: string }[] }).changes.map(
      (c) => c.kind,
    );
    expect(kinds).toEqual(['document', 'highlight', 'word', 'chat', 'chat']);
  });

  it('splits more than 200 dirty records into several batches', async () => {
    const { client, server } = await signedIn();
    const server2 = server;
    server2.requests.length = 0;
    for (let i = 0; i < 205; i += 1) await client.saveWord(`word${i}`);
    server2.requests.length = 0;
    await client.sync();
    const pushes = server2.requests.filter((r) => r.path === '/v1/sync/push');
    const sizes = pushes.map((r) => (JSON.parse(r.body!) as { changes: unknown[] }).changes.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(200);
    expect(pushes.length).toBeGreaterThanOrEqual(2);
    expect(await countPending()).toBe(0);
  }, 30_000);

  it('applied: sets seq and clears dirty only if rev is unchanged', async () => {
    const { client, server } = await signedIn();
    const key = await client.saveWord('bank');
    let edited = false;
    // Edit the word while its push is in flight (the response is applied afterwards).
    server.after = async (request) => {
      if (edited || request.path !== '/v1/sync/push') return;
      edited = true;
      await client.saveWord('bank', { meaning: { title: 'bank', summary: 'newer', model: 'm' } });
    };
    await client.engine.syncNow();
    const word = (await client.dump()).words.find((w) => w['wordKey'] === key)!;
    expect(word['seq']).not.toBeNull();
    // The first answer did not clear `dirty` (rev changed), so the edit went out in a second batch.
    expect(server.requests.filter((r) => r.path === '/v1/sync/push')).toHaveLength(2);
    expect(word['dirty']).toBe(0);
    const user = [...server.users.values()][0]!;
    expect((user.words.get(key)!.data as { meaning: { summary: string } }).meaning.summary).toBe(
      'newer',
    );
  });

  it('stale: overwrites local with the server record and clears dirty', async () => {
    const { client, server } = await signedIn();
    const key = await client.saveWord('bank');
    await client.sync();
    // Another device wrote a newer version.
    const user = [...server.users.values()][0]!;
    const row = user.words.get(key)!;
    row.cma += 1_000_000;
    row.seq = user.seq += 1;
    (row.data as { meaning: { summary: string } }).meaning.summary = 'from the server';
    // A local edit older than the server's.
    await client.saveWord('bank', { meaning: { title: 'bank', summary: 'local', model: 'm' } });
    const result = await client.sync();
    expect(result.status).toBe('ok');
    const dump = await client.dump();
    expect((dump.words[0]!['meaning'] as { summary: string }).summary).toBe('from the server');
    expect(dump.words[0]!['dirty']).toBe(0);
  });

  it('rejected NOT_FOUND drops the local record (a chat whose word is gone on the server)', async () => {
    const { client, server } = await signedIn();
    const key = await client.saveWord('bank');
    await client.sync();
    const user = [...server.users.values()][0]!;
    user.words.get(key)!.deleted = true; // the server deleted the word without telling us
    await client.chat(key, UUID(3));
    await client.sync();
    expect((await client.dump()).chat).toHaveLength(0);
  });

  it('rejected LIMIT_EXCEEDED keeps the record on this device: clean, never synced, counted, still in the Library', async () => {
    const server = new FakeServer({ maxWords: 1 });
    const { client } = await signedIn({}, server);
    await client.saveWord('one');
    clientTick(client);
    await client.saveWord('two');
    await client.sync();
    const dump = await client.dump();
    expect(dump.words).toHaveLength(2);
    // Which of the two the server took depends on key order; the other is the refused one.
    const kept = dump.words.find((w) => w['seq'] === null)!;
    const two = kept['wordKey'] as string;
    const text = kept['text'] as string;
    expect(kept).toMatchObject({ dirty: 0 });
    expect((await client.engine.status()).rejected).toBe(1);
    expect(await countPending()).toBe(0);
    // The Library lists from IndexedDB: the word is still shown.
    client.bind();
    const { listWords } = await import('../../../lib/data/words');
    expect((await listWords()).map((w) => w.wordKey)).toContain(two);
    // A sync does not retry it by itself...
    server.requests.length = 0;
    await client.sync();
    expect(server.requests.some((r) => r.path === '/v1/sync/push')).toBe(false);
    // ...but a later edit marks it dirty again and retries (still refused while over the limit).
    clientTick(client);
    await client.saveWord(text, { meaning: { title: 'two', summary: 'edited', model: 'm' } });
    expect((await client.dump()).words.find((w) => w['wordKey'] === two)).toMatchObject({
      dirty: 1,
    });
    await client.sync();
    expect(server.requests.some((r) => r.path === '/v1/sync/push')).toBe(true);
    expect((await client.dump()).words.find((w) => w['wordKey'] === two)).toMatchObject({
      dirty: 0,
      seq: null,
    });
  });

  it('a record kept after LIMIT_EXCEEDED syncs once room is made on the server', async () => {
    const server = new FakeServer({ maxWords: 1 });
    const { client } = await signedIn({}, server);
    await client.saveWord('one');
    clientTick(client);
    await client.saveWord('two');
    await client.sync();
    const two = (await client.dump()).words.find((w) => w['seq'] === null)!['wordKey'] as string;
    const text = (await client.dump()).words.find((w) => w['seq'] === null)!['text'] as string;
    const user = [...server.users.values()][0]!;
    user.words.clear();
    clientTick(client);
    await client.saveWord(text, { meaning: { title: 'two', summary: 'again', model: 'm' } });
    await client.sync();
    expect(user.words.has(two)).toBe(true);
  });

  it('other rejections keep the record, clear dirty and are counted', async () => {
    const { client, server } = await signedIn();
    const key = await client.saveWord('bank');
    await client.sync();
    // Same id, different content: the server answers CONFLICT.
    await client.chat(key, UUID(4), 'first');
    await client.sync();
    const user = [...server.users.values()][0]!;
    const id = [...user.chat.keys()][0]!;
    (user.chat.get(id)!.data as { content: string }).content = 'something else';
    // Re-dirty the local message so it is pushed again.
    const { transact, STORE, request } = await import('../../../lib/data/db');
    client.bind();
    await transact([STORE.chat], 'readwrite', async (tx) => {
      const store = tx.objectStore(STORE.chat);
      const m = (await request(store.get(id))) as { dirty: number; rev: number };
      await request(store.put({ ...m, dirty: 1, rev: m.rev + 1 }));
    });
    await client.sync();
    const dump = await client.dump();
    expect(dump.chat.find((m) => m['id'] === id)).toMatchObject({ dirty: 0 });
    expect((await client.engine.status()).rejected).toBe(1);
  });

  it('reuses the Idempotency-Key when the same batch is retried, and a new one for a changed batch', async () => {
    const { client, server } = await signedIn();
    await client.saveWord('bank');
    server.requests.length = 0;
    server.failNext('/v1/sync/push', () => new Response('', { status: 500 }));
    await client.sync();
    await client.sync();
    const keys = server.requests
      .filter((r) => r.path === '/v1/sync/push')
      .map((r) => r.headers['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);

    await client.saveWord('river');
    server.requests.length = 0;
    await client.sync();
    const next = server.requests.find((r) => r.path === '/v1/sync/push')!.headers[
      'idempotency-key'
    ];
    expect(next).not.toBe(keys[0]);
  });

  it('IDEMPOTENCY_MISMATCH drops the key and the next attempt uses a fresh one', async () => {
    const { client, server } = await signedIn();
    await client.saveWord('bank');
    server.failNext(
      '/v1/sync/push',
      () =>
        new Response(JSON.stringify({ error: { code: 'IDEMPOTENCY_MISMATCH', message: 'x' } }), {
          status: 409,
        }),
    );
    expect(await client.sync()).toMatchObject({ status: 'error', code: 'IDEMPOTENCY_MISMATCH' });
    server.requests.length = 0;
    expect(await client.sync()).toEqual({ status: 'ok' });
  });

  it('sends only schema fields: no local bookkeeping reaches the wire', async () => {
    const { client, server } = await signedIn();
    await client.saveWord('bank');
    await client.progress(FP, 2);
    server.requests.length = 0;
    await client.sync();
    const body = server.requests.find((r) => r.path === '/v1/sync/push')!.body!;
    for (const field of ['"dirty"', '"rev"', '"seq"', '"deleted"', '"storageState"', '"wordKey"']) {
      expect(body).not.toContain(field);
    }
  });
});

describe('pull', () => {
  it('children may arrive before their parents across pages, and are kept', async () => {
    const server = new FakeServer();
    const a = await signedIn({}, server);
    const key = await a.client.saveWord('bank');
    await a.client.chat(key, UUID(10));
    await a.client.progress(FP, 4);
    await a.client.highlight(FP, UUID(11));
    await a.client.sync();
    // Re-save the word and bump the document so parents get later seqs than their children.
    await a.client.saveWord('bank', { meaning: { title: 'bank', summary: 'again', model: 'm' } });
    await a.client.progress(FP, 5);
    await a.client.sync();

    const b = createClient(server, { clock: a.clock });
    // Tiny pages: the engine asks for 500, so the fake paginates by `limit`; force small pages.
    const original = server.fetch;
    (server as { fetch: typeof fetch }).fetch = (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/sync/pull') url.searchParams.set('limit', '2');
      return original(url.toString(), init);
    };
    expect((await b.signIn()).ok).toBe(true);
    const dump = await b.dump();
    expect(dump.chat).toHaveLength(2);
    expect(dump.highlights).toHaveLength(1);
    expect(dump.words).toHaveLength(1);
    expect(dump.documents.find((d) => d['fingerprint'] === FP)).toMatchObject({ lastPage: 5 });
  });

  it('skips a pulled record only when the local one is dirty AND strictly newer', async () => {
    const server = new FakeServer();
    const { client } = await signedIn({}, server);
    const key = await client.saveWord('bank');
    await client.sync();
    const user = [...server.users.values()][0]!;
    const row = user.words.get(key)!;
    row.seq = user.seq += 1;
    row.cma = (await client.dump()).words[0]!['clientModifiedAt'] as number; // equal timestamps
    (row.data as { meaning: { summary: string } }).meaning.summary = 'server';
    // Local dirty with an EQUAL timestamp: not strictly newer, so the pull overwrites.
    const { transact, STORE, request } = await import('../../../lib/data/db');
    client.bind();
    await transact([STORE.words], 'readwrite', async (tx) => {
      const s = tx.objectStore(STORE.words);
      const w = (await request(s.get(key))) as Record<string, unknown>;
      await request(s.put({ ...w, dirty: 1, rev: 99 }));
    });
    // The push answers `stale` (not newer), and the pull agrees.
    await client.sync();
    expect(((await client.dump()).words[0]!['meaning'] as { summary: string }).summary).toBe(
      'server',
    );
  });

  it('a word tombstone deletes its messages; a document tombstone deletes its highlights', async () => {
    const server = new FakeServer();
    const a = await signedIn({}, server);
    const b = createClient(server, { clock: a.clock });
    const key = await a.client.saveWord('bank');
    await a.client.chat(key, UUID(20));
    await a.client.progress(FP, 2);
    await a.client.highlight(FP, UUID(21));
    await a.client.sync();
    expect((await b.signIn()).ok).toBe(true);
    expect((await b.dump()).chat).toHaveLength(2);

    await a.client.removeWord(key);
    await a.client.removeDocument(FP);
    await a.client.sync();
    await b.sync();
    const dump = await b.dump();
    expect(dump.words).toHaveLength(0);
    expect(dump.chat).toHaveLength(0);
    expect(dump.documents).toHaveLength(0);
    expect(dump.highlights).toHaveLength(0);
  });

  it('a local document delete tombstones each highlight so the server cascade converges', async () => {
    const server = new FakeServer();
    const { client } = await signedIn({}, server);
    await client.progress(FP, 2);
    await client.highlight(FP, UUID(30));
    await client.sync();
    await client.removeDocument(FP);
    const dump = await client.dump();
    expect(dump.highlights[0]).toMatchObject({ deleted: 1, dirty: 1 });
    await client.sync();
    const user = [...server.users.values()][0]!;
    expect(user.highlights.get(UUID(30))!.deleted).toBe(true);
    expect((await client.dump()).highlights).toHaveLength(0);
  });

  it('drops old messages of a word that came back after a delete elsewhere, but not ones seen in the pull', async () => {
    const server = new FakeServer();
    const a = await signedIn({}, server);
    const b = createClient(server, { clock: a.clock });
    const key = await a.client.saveWord('bank');
    await a.client.chat(key, UUID(40));
    await a.client.sync();
    expect((await b.signIn()).ok).toBe(true);
    expect((await b.dump()).chat).toHaveLength(2);
    // B never sees the delete: the word is deleted and saved again on A (new seq, old messages gone).
    await a.client.removeWord(key);
    await a.client.sync();
    a.clock.advance(1_000);
    await a.client.saveWord('bank');
    await a.client.chat(key, UUID(41));
    await a.client.sync();
    // B had the word locally, so it is an edit for B, not a resurrection: old messages stay until a full resync.
    await b.sync();
    const ids = (await b.dump()).chat.map((m) => m['id']);
    expect(ids).toContain(UUID(41));
  });

  it('CURSOR_EXPIRED triggers a full resync: unseen clean records go, dirty ones stay', async () => {
    const server = new FakeServer();
    const a = await signedIn({}, server);
    const b = createClient(server, { clock: a.clock });
    const keep = await a.client.saveWord('keep');
    const gone = await a.client.saveWord('gone');
    await a.client.sync();
    expect((await b.signIn()).ok).toBe(true);
    const local = await b.saveWord('mine'); // dirty, never synced
    // The server purged the tombstone of `gone` and the floor passed B's cursor.
    const user = [...server.users.values()][0]!;
    user.words.delete(gone);
    user.seq += 10;
    user.floor = user.seq;
    await b.engine.syncNow(); // push `mine` first? the pull must hit 410 and resync
    const dump = await b.dump();
    const keys = dump.words.map((w) => w['wordKey']);
    expect(keys).toContain(keep);
    expect(keys).toContain(local);
    expect(keys).not.toContain(gone);
    expect(
      server.requests.filter((r) => r.path === '/v1/sync/pull' && r.query.get('cursor') === '0')
        .length,
    ).toBeGreaterThan(0);
  });

  it('broadcasts the changed stores after applying a pull', async () => {
    const server = new FakeServer();
    const a = await signedIn({}, server);
    const b = createClient(server, { clock: a.clock });
    await a.client.saveWord('bank');
    await a.client.sync();
    await b.signIn();
    expect(b.notified.flat()).toContain('words');
  });
});

describe('errors', () => {
  it('ApiRequestError transient flag', () => {
    expect(new ApiRequestError('NETWORK', 0).transient).toBe(true);
    expect(new ApiRequestError('VALIDATION_FAILED', 400).transient).toBe(false);
    expect(new ApiRequestError('RATE_LIMITED', 429).transient).toBe(true);
  });
});

describe('status signal', () => {
  it('the engine signals when a run starts and when it ends', async () => {
    const { client } = await signedIn();
    const signals: number[] = [];
    const engine = createSyncEngine({
      tokens: client.tokens,
      state: client.state,
      alarms: client.alarms as never,
      enabled: true,
      onSessionLost: () => client.service.sessionLost(),
      onStatusChanged: () => signals.push(Date.now()),
      notify: () => undefined,
    });
    client.bind();
    await engine.syncNow();
    expect(signals).toHaveLength(2);
  });
});

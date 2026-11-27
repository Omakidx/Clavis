import { IDBFactory } from 'fake-indexeddb';
import { createApiClient } from '../../../lib/account/api';
import { createAccountService, type AccountService } from '../../../lib/account/service';
import { createTokenClient, createTokenStore } from '../../../lib/account/tokens';
import { appendChatPair } from '../../../lib/data/chat';
import { deleteDocument, saveProgress } from '../../../lib/data/documents';
import { createIdbHighlightStore } from '../../../lib/data/highlights';
import { STORE, getAll, transact } from '../../../lib/data/db';
import { deleteWord, putWord } from '../../../lib/data/words';
import { createSyncEngine, type LocksLike } from '../../../lib/sync/engine';
import { createSyncStateStore } from '../../../lib/sync/state';
import { MemoryArea } from '../storage/memory-area';
import { sampleWord } from '../data/fixtures';
import { FakeServer, wordKey } from './fake-server';

export const API = 'https://api.test';
export const FP = 'f'.repeat(64);

export interface Clock {
  t: number;
  now(): number;
  advance(ms: number): void;
}
export function createClock(start = 1_760_000_000_000): Clock {
  const clock = {
    t: start,
    now: () => clock.t,
    advance: (ms: number) => {
      clock.t += ms;
    },
  };
  return clock;
}

export interface FakeAlarms {
  created: { name: string; info: Record<string, unknown> }[];
  cleared: string[];
  active: Set<string>;
  create(name: string, info: Record<string, unknown>): void;
  clear(name: string): boolean;
  get(name: string): Promise<unknown>;
}

/**
 * One device: its own IndexedDB factory, its own storage areas and its own engine, against a
 * (shared) fake server. `bind()` makes this device's IndexedDB the current one; call it before
 * touching local data, and run one device's work to completion before switching (the data layer
 * opens `globalThis.indexedDB`).
 */
export function createClient(
  server: FakeServer,
  options: {
    clock?: Clock;
    email?: string;
    googleClientId?: string;
    apiTimeoutMs?: number;
    maxPullPages?: number;
    locks?: LocksLike;
    enabled?: boolean;
    lockedDown?: () => Promise<boolean>;
  } = {},
) {
  const clock = options.clock ?? createClock();
  const idb = new IDBFactory();
  const local = new MemoryArea();
  const session = new MemoryArea();
  const state = createSyncStateStore(local);
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const alarms: FakeAlarms = {
    created: [],
    cleared: [],
    active: new Set(),
    create(name, info) {
      this.created.push({ name, info });
      this.active.add(name);
    },
    clear(name) {
      this.cleared.push(name);
      return this.active.delete(name);
    },
    get: (name) => Promise.resolve(alarms.active.has(name) ? { name } : undefined),
  };
  const api = createApiClient({
    origin: API,
    fetch: server.fetch,
    ...(options.apiTimeoutMs === undefined ? {} : { timeoutMs: options.apiTimeoutMs }),
  });
  const store = createTokenStore({
    local,
    session,
    lockedDown: options.lockedDown ?? (() => Promise.resolve(true)),
  });
  const notified: string[][] = [];
  // eslint-disable-next-line prefer-const -- the token client needs the service, the service the client
  let service!: AccountService;
  const tokens = createTokenClient({
    store,
    api,
    now: clock.now,
    onSessionLost: () => service.sessionLost(),
    generation: () => service.generation(),
  });
  const engine = createSyncEngine({
    tokens,
    state,
    alarms: alarms as never,
    enabled: options.enabled ?? true,
    onSessionLost: () => service.sessionLost(),
    ...(options.maxPullPages === undefined ? {} : { maxPullPages: options.maxPullPages }),
    now: clock.now,
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (h) => {
      (h as { cancelled: boolean }).cancelled = true;
    },
    notify: (stores) => notified.push([...stores]),
    ...(options.locks === undefined ? {} : { locks: options.locks }),
  });
  let email = options.email ?? 'a@example.test';
  const launched: string[] = [];
  service = createAccountService({
    config: {
      apiOrigin: API,
      googleClientId: options.googleClientId ?? 'client-id',
      googleAuthUrl: 'https://accounts.example/authorize',
      googleLoginHint: undefined,
    },
    api,
    tokens,
    store,
    state,
    engine,
    local,
    identity: {
      getRedirectURL: () => 'https://extid.chromiumapp.org/',
      launchWebAuthFlow: ({ url }) => {
        launched.push(url);
        const params = new URL(url).searchParams;
        return Promise.resolve(
          `https://extid.chromiumapp.org/?code=code-${email}&state=${params.get('state')}`,
        );
      },
    },
    enabled: options.enabled ?? true,
    notify: () => undefined,
  });

  const deps = { now: clock.now, signedIn: () => Promise.resolve(true) };
  const bind = (): void => {
    globalThis.indexedDB = idb;
  };

  return {
    setEmail: (next: string) => {
      email = next;
    },
    api,
    server,
    clock,
    idb,
    local,
    session,
    state,
    store,
    tokens,
    engine,
    service,
    alarms,
    timers,
    notified,
    launched,
    bind,
    /** Local edits through the real data layer, as a signed-in device. */
    async saveWord(text: string, over: Record<string, unknown> = {}) {
      bind();
      const key = await wordKey(text);
      await putWord(key, sampleWord({ text, createdAt: clock.now(), ...over }), deps);
      return key;
    },
    async removeWord(key: string) {
      bind();
      return deleteWord(key, deps);
    },
    async chat(key: string, id: string, content = 'q?', at = clock.now()) {
      bind();
      await appendChatPair(
        key,
        [
          { id, role: 'user', content, createdAt: at },
          {
            id: `ffffffff${id.slice(8)}`,
            role: 'assistant',
            content: 'a.',
            model: 'm',
            createdAt: at + 1,
          },
        ],
        deps,
      );
    },
    async progress(fingerprint: string, page: number) {
      bind();
      await saveProgress(
        fingerprint,
        { title: 'T', pageCount: 10, fileBytes: 100, lastPage: page, pageOffset: 0 },
        deps,
      );
    },
    async highlight(fingerprint: string, id: string) {
      bind();
      const marks = createIdbHighlightStore(deps);
      await marks.add(fingerprint, [
        { id, page: 1, start: 0, end: 5, color: 'yellow', createdAt: clock.now() },
      ]);
    },
    async removeDocument(fingerprint: string) {
      bind();
      return deleteDocument(fingerprint, deps);
    },
    async dump() {
      bind();
      return transact(
        [STORE.words, STORE.chat, STORE.documents, STORE.highlights],
        'readonly',
        async (tx) => ({
          words: await getAll<Record<string, unknown>>(tx.objectStore(STORE.words)),
          chat: await getAll<Record<string, unknown>>(tx.objectStore(STORE.chat)),
          documents: await getAll<Record<string, unknown>>(tx.objectStore(STORE.documents)),
          highlights: await getAll<Record<string, unknown>>(tx.objectStore(STORE.highlights)),
        }),
      );
    },
    /** Sign in and wait for the first sync. */
    async signIn() {
      bind();
      const result = await service.signIn();
      await engine.syncNow();
      return result;
    },
    async sync() {
      bind();
      return engine.syncNow();
    },
  };
}

export type Client = ReturnType<typeof createClient>;

/** Live records of a dump as comparable plain data (no sync bookkeeping). */
export function visible(dump: Awaited<ReturnType<Client['dump']>>) {
  const live = (r: Record<string, unknown>): boolean => r['deleted'] !== 1;
  return {
    words: dump.words
      .filter(live)
      .map((w) => w['wordKey'])
      .sort(),
    chat: dump.chat
      .filter(live)
      .map((m) => m['id'])
      .sort(),
    documents: dump.documents
      .filter(live)
      .map((d) => `${d['fingerprint']}:${d['lastPage']}`)
      .sort(),
    highlights: dump.highlights
      .filter(live)
      .map((h) => h['id'])
      .sort(),
  };
}

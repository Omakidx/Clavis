import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  PullResponse,
  PushResponse,
  wordKey,
  type PushChange,
  type SavedMeaning,
  type WordData,
} from '../../../shared/api-contract';
import type { DbHandle } from '../../src/db/client';
import type { ObjectStorage } from '../../src/storage/types';
import { bearer, createHarness, extSignIn, type Harness, type Pair } from '../auth/harness';

let userN = 0;

export const meaning = (over: Partial<SavedMeaning> = {}): SavedMeaning => ({
  title: 'Title',
  summary: 'Summary',
  model: 'test-model',
  ...over,
});

export async function makeWord(
  text: string,
  cma: number,
  over: Partial<WordData> = {},
): Promise<Extract<PushChange, { kind: 'word'; op: 'upsert' }>> {
  return {
    kind: 'word',
    op: 'upsert',
    key: await wordKey(text),
    clientModifiedAt: cma,
    data: {
      text,
      meaning: meaning(),
      source: { kind: 'webpage', url: 'https://example.test/a', title: 'A page' },
      createdAt: cma,
      ...over,
    },
  };
}

export const wordDel = async (text: string, cma: number): Promise<PushChange> => ({
  kind: 'word',
  op: 'delete',
  key: await wordKey(text),
  clientModifiedAt: cma,
});

export const docUp = (
  fp: string,
  cma: number,
  data: Partial<{
    title: string | null;
    pageCount: number | null;
    lastPage: number | null;
    pageOffset: number | null;
    fileBytes: number | null;
  }> = {},
): PushChange => ({
  kind: 'document',
  op: 'upsert',
  key: fp,
  clientModifiedAt: cma,
  data: { title: 'Doc', pageCount: 10, lastPage: 1, pageOffset: 0, fileBytes: 1000, ...data },
});

export const docDel = (fp: string, cma: number): PushChange => ({
  kind: 'document',
  op: 'delete',
  key: fp,
  clientModifiedAt: cma,
});

export const hlUp = (
  id: string,
  fp: string,
  cma: number,
  over: Partial<{ page: number; start: number; end: number; color: 'yellow' }> = {},
): PushChange => ({
  kind: 'highlight',
  op: 'upsert',
  id,
  clientModifiedAt: cma,
  data: { fingerprint: fp, page: 1, start: 0, end: 5, color: 'yellow', createdAt: cma, ...over },
});

export const hlDel = (id: string, fp: string, cma: number): PushChange => ({
  kind: 'highlight',
  op: 'delete',
  id,
  fingerprint: fp,
  clientModifiedAt: cma,
});

export const chatIns = (
  id: string,
  key: string,
  cma: number,
  over: Partial<{ role: 'user' | 'assistant'; content: string; model: string }> = {},
): PushChange => {
  const role = over.role ?? 'user';
  return {
    kind: 'chat',
    op: 'insert',
    id,
    data: {
      wordKey: key,
      role,
      content: over.content ?? 'hello',
      ...(role === 'assistant' ? { model: over.model ?? 'm' } : {}),
      createdAt: cma,
    },
  };
};

export const fp = (c: string) => c.repeat(64).slice(0, 64);

export class Api {
  constructor(
    readonly h: Harness,
    readonly pair: Pair,
    readonly sub = '',
  ) {}
  get userId() {
    return this.pair.user.id;
  }
  push(changes: unknown[], key: string = randomUUID(), headers: Record<string, string> = {}) {
    return this.h.app.request('/v1/sync/push', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': key,
        ...bearer(this.pair),
        ...headers,
      },
      body: JSON.stringify({ changes }),
    });
  }
  async pushOk(changes: unknown[], key?: string): Promise<PushResponse> {
    const res = await this.push(changes, key);
    if (res.status !== 200) throw new Error(`push ${res.status} ${await res.text()}`);
    return PushResponse.parse(await res.json());
  }
  pull(cursor = '0', limit?: number) {
    const qs = new URLSearchParams({ cursor, ...(limit ? { limit: String(limit) } : {}) });
    return this.h.app.request(`/v1/sync/pull?${qs}`, { headers: bearer(this.pair) });
  }
  async pullOk(cursor = '0', limit?: number): Promise<PullResponse> {
    const res = await this.pull(cursor, limit);
    if (res.status !== 200) throw new Error(`pull ${res.status} ${await res.text()}`);
    return PullResponse.parse(await res.json());
  }
  /** Pull everything after `cursor`, following hasMore. */
  async pullAll(cursor = '0', limit = 500) {
    const changes: PullResponse['changes'] = [];
    let next = cursor;
    for (;;) {
      const p = await this.pullOk(next, limit);
      changes.push(...p.changes);
      next = p.nextCursor;
      if (!p.hasMore) return { changes, nextCursor: next };
    }
  }
  req(method: string, path: string, headers: Record<string, string> = {}) {
    return this.h.app.request(path, { method, headers: { ...bearer(this.pair), ...headers } });
  }
}

export interface World {
  h: Harness;
  db: DbHandle;
  /** Fresh signed-in user. */
  user(): Promise<Api>;
  /** Another device (token family) of the same user. */
  device(of: Api): Promise<Api>;
}

/** Harness without per-user rate limits (the limiter itself is covered by its own test). */
export async function makeWorld(
  db: DbHandle,
  opts: {
    limited?: boolean;
    storage?: ObjectStorage | undefined;
    env?: Record<string, string> | undefined;
  } = {},
): Promise<World> {
  const h = await createHarness({ db, storage: opts.storage, env: opts.env });
  if (!opts.limited) h.limiter.take = () => 0;
  return {
    h,
    db,
    async user() {
      const n = ++userN;
      const sub = `sync-${n}-${Math.random()}`;
      const pair = await extSignIn(h, { sub, email: `s${n}@example.test` }, n);
      return new Api(h, pair, sub);
    },
    async device(of) {
      const n = ++userN;
      const pair = await extSignIn(h, { sub: of.sub, email: `s${n}@example.test` }, n);
      return new Api(h, pair, of.sub);
    },
  };
}

export async function rows<T = Record<string, unknown>>(db: DbHandle, q: ReturnType<typeof sql>) {
  return (await db.db.execute(q)).rows as T[];
}

export async function userRow(db: DbHandle, id: string) {
  return (
    await rows<{ change_seq: string; storage_used_bytes: string }>(
      db,
      sql`SELECT change_seq, storage_used_bytes FROM users WHERE id = ${id}`,
    )
  )[0] as { change_seq: string; storage_used_bytes: string };
}

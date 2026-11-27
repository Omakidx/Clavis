import {
  PushRequest,
  type PushChange,
  type PushResult,
  type ServerChange,
} from '../../../shared/api-contract/sync';
import { wordKey } from '../../../shared/api-contract/words';

/**
 * An in-memory Clavis API implementing the shared contract (docs/clavis-sync-design.md 4.2-4.4, 5):
 * per-user sequence, last-writer-wins on clientModifiedAt, cascades, idempotency keys, token pairs
 * with rotation and reuse detection, cursor expiry. A `fetch` stand-in for the extension's client.
 */

interface Row<T> {
  data: T | null;
  deleted: boolean;
  cma: number;
  seq: number;
}
interface ChatRow {
  data: Record<string, unknown>;
  seq: number;
}
interface UserState {
  id: string;
  email: string;
  seq: number;
  floor: number;
  words: Map<string, Row<Record<string, unknown>>>;
  chat: Map<string, ChatRow>;
  documents: Map<string, Row<Record<string, unknown>>>;
  highlights: Map<string, Row<Record<string, unknown>> & { fingerprint: string }>;
  idempotency: Map<string, { body: string; response: unknown }>;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string | undefined;
}

export interface FakeServerOptions {
  now?: () => number;
  maxWords?: number;
  accessTtlMs?: number;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
const err = (status: number, code: string, headers: Record<string, string> = {}): Response =>
  json(status, { error: { code, message: code } }, headers);

export class FakeServer {
  readonly users = new Map<string, UserState>();
  readonly requests: RecordedRequest[] = [];
  /** Runs after the server handled a request and before the client gets the response (races). */
  after: ((request: RecordedRequest) => Promise<void>) | null = null;
  /** Scripted failures, consumed first-in-first-out by matching path substring. */
  readonly failures: { match: string; response: () => Response; times: number }[] = [];
  private readonly access = new Map<string, { userId: string; family: string; exp: number }>();
  private readonly refresh = new Map<string, { userId: string; family: string; used: boolean }>();
  private readonly revokedFamilies = new Set<string>();
  private counter = 0;
  readonly now: () => number;
  readonly maxWords: number;
  readonly accessTtlMs: number;

  constructor(options: FakeServerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.maxWords = options.maxWords ?? 5000;
    this.accessTtlMs = options.accessTtlMs ?? 15 * 60_000;
  }

  user(email: string): UserState {
    let user = [...this.users.values()].find((u) => u.email === email);
    if (user === undefined) {
      user = {
        id: crypto.randomUUID(),
        email,
        seq: 0,
        floor: 0,
        words: new Map(),
        chat: new Map(),
        documents: new Map(),
        highlights: new Map(),
        idempotency: new Map(),
      };
      this.users.set(user.id, user);
    }
    return user;
  }

  failNext(match: string, response: () => Response, times = 1): void {
    this.failures.push({ match, response, times });
  }
  revokeAll(): void {
    for (const t of this.refresh.values()) this.revokedFamilies.add(t.family);
  }
  /** Simulate a purged-tombstone window: pulls with cursor below it get 410. */
  setFloor(email: string, floor: number): void {
    this.user(email).floor = floor;
  }

  private issue(userId: string, family: string) {
    const n = (this.counter += 1);
    const user = this.users.get(userId)!;
    const accessToken = `acc-${n}`;
    const refreshToken = `crt_${String(n).padStart(43, 'r')}`;
    this.access.set(accessToken, { userId, family, exp: this.now() + this.accessTtlMs });
    this.refresh.set(refreshToken, { userId, family, used: false });
    return {
      accessToken,
      accessTokenExpiresAt: this.now() + this.accessTtlMs,
      refreshToken,
      refreshTokenExpiresAt: this.now() + 30 * 86_400_000,
      user: { id: userId, email: user.email, displayName: null, createdAt: 1_700_000_000_000 },
    };
  }

  /** What `GET /v1/account` reports, and how often it was asked. */
  usage = { storageUsedBytes: 5_242_880, storageQuotaBytes: 104_857_600 };
  accountReads = 0;

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k.toLowerCase()] = v));
    const body = typeof init?.body === 'string' ? init.body : undefined;
    const request: RecordedRequest = {
      method: init?.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
    };
    this.requests.push(request);
    const scripted = this.failures.find((f) => url.pathname.includes(f.match) && f.times > 0);
    if (scripted !== undefined) {
      scripted.times -= 1;
      return scripted.response();
    }
    const response = this.route(request);
    if (this.after !== null) await this.after(request);
    return response;
  };

  private authed(request: RecordedRequest): UserState | Response {
    const token = /^Bearer (.+)$/.exec(request.headers['authorization'] ?? '')?.[1];
    const entry = token === undefined ? undefined : this.access.get(token);
    if (entry === undefined || entry.exp <= this.now()) return err(401, 'UNAUTHENTICATED');
    if (this.revokedFamilies.has(entry.family)) return err(401, 'SESSION_REVOKED');
    return this.users.get(entry.userId)!;
  }

  private route(request: RecordedRequest): Response {
    const { method, path } = request;
    if (method === 'POST' && path === '/v1/auth/extension/google') {
      const { code } = JSON.parse(request.body ?? '{}') as { code: string };
      const email = code.replace(/^code-/, '');
      const user = this.user(email);
      return json(200, this.issue(user.id, `fam-${(this.counter += 1)}`));
    }
    if (method === 'POST' && path === '/v1/auth/extension/refresh') {
      const { refreshToken } = JSON.parse(request.body ?? '{}') as { refreshToken: string };
      const entry = this.refresh.get(refreshToken);
      if (entry === undefined) return err(401, 'UNAUTHENTICATED');
      if (this.revokedFamilies.has(entry.family)) return err(401, 'SESSION_REVOKED');
      if (entry.used) return err(401, 'TOKEN_REUSED');
      entry.used = true;
      return json(200, this.issue(entry.userId, entry.family));
    }
    if (method === 'POST' && path === '/v1/auth/extension/logout') {
      const { refreshToken } = JSON.parse(request.body ?? '{}') as { refreshToken: string };
      const entry = this.refresh.get(refreshToken);
      if (entry !== undefined) this.revokedFamilies.add(entry.family);
      return new Response(null, { status: 204 });
    }
    const user = this.authed(request);
    if (user instanceof Response) return user;
    if (method === 'POST' && path === '/v1/account/logout-all') {
      for (const t of this.refresh.values())
        if (t.userId === user.id) this.revokedFamilies.add(t.family);
      return new Response(null, { status: 204 });
    }
    if (method === 'GET' && path === '/v1/account') {
      this.accountReads += 1;
      return json(200, {
        user: { id: user.id, email: user.email, displayName: null, createdAt: 1_700_000_000_000 },
        usage: { ...this.usage, words: 0, documents: 0 },
      });
    }
    if (method === 'POST' && path === '/v1/sync/push') return this.push(user, request);
    if (method === 'GET' && path === '/v1/sync/pull') return this.pull(user, request);
    return err(404, 'NOT_FOUND');
  }

  // ---- push ---------------------------------------------------------------------------

  private push(user: UserState, request: RecordedRequest): Response {
    const key = request.headers['idempotency-key'];
    if (key === undefined) return err(400, 'VALIDATION_FAILED');
    const prior = user.idempotency.get(key);
    if (prior !== undefined) {
      return prior.body === request.body
        ? json(200, prior.response)
        : err(409, 'IDEMPOTENCY_MISMATCH');
    }
    const parsed = PushRequest.safeParse(JSON.parse(request.body ?? 'null'));
    if (!parsed.success) return err(400, 'VALIDATION_FAILED');
    const results = parsed.data.changes.map((c, index) => this.apply(user, c, index));
    const response = { results, serverTime: this.now() };
    user.idempotency.set(key, { body: request.body ?? '', response });
    return json(200, response);
  }

  private bump(user: UserState): number {
    user.seq += 1;
    return user.seq;
  }

  private applied(index: number, seq: number): PushResult {
    return { index, status: 'applied', seq: String(seq) };
  }

  private lww<T>(
    user: UserState,
    map: Map<string, Row<T>>,
    key: string,
    cma: number,
    index: number,
    make: (seq: number) => Row<T>,
    current: () => ServerChange,
  ): PushResult {
    const existing = map.get(key);
    if (existing !== undefined && cma <= existing.cma)
      return { index, status: 'stale', current: current() };
    const seq = this.bump(user);
    map.set(key, make(seq));
    return this.applied(index, seq);
  }

  private apply(user: UserState, c: PushChange, index: number): PushResult {
    switch (c.kind) {
      case 'word': {
        const liveWords = [...user.words.values()].filter((w) => !w.deleted).length;
        if (c.op === 'upsert') {
          // The key must be the hash of the text.
          const existing = user.words.get(c.key);
          if ((existing === undefined || existing.deleted) && liveWords >= this.maxWords) {
            return { index, status: 'rejected', code: 'LIMIT_EXCEEDED' };
          }
          return this.lww(
            user,
            user.words,
            c.key,
            c.clientModifiedAt,
            index,
            (seq) => ({
              data: c.data as unknown as Record<string, unknown>,
              deleted: false,
              cma: c.clientModifiedAt,
              seq,
            }),
            () => this.wordChange(user, c.key),
          );
        }
        const result = this.lww(
          user,
          user.words,
          c.key,
          c.clientModifiedAt,
          index,
          (seq) => ({ data: null, deleted: true, cma: c.clientModifiedAt, seq }),
          () => this.wordChange(user, c.key),
        );
        if (result.status === 'applied') {
          for (const [id, m] of user.chat) if (m.data['wordKey'] === c.key) user.chat.delete(id);
        }
        return result;
      }
      case 'chat': {
        const word = user.words.get(c.data.wordKey);
        if (word === undefined || word.deleted)
          return { index, status: 'rejected', code: 'NOT_FOUND' };
        const existing = user.chat.get(c.id);
        if (existing !== undefined) {
          return JSON.stringify(existing.data) === JSON.stringify(c.data)
            ? this.applied(index, existing.seq)
            : { index, status: 'rejected', code: 'CONFLICT' };
        }
        const seq = this.bump(user);
        user.chat.set(c.id, { data: c.data as unknown as Record<string, unknown>, seq });
        return this.applied(index, seq);
      }
      case 'document': {
        if (c.op === 'upsert') {
          return this.lww(
            user,
            user.documents,
            c.key,
            c.clientModifiedAt,
            index,
            (seq) => ({
              data: c.data as unknown as Record<string, unknown>,
              deleted: false,
              cma: c.clientModifiedAt,
              seq,
            }),
            () => this.docChange(user, c.key),
          );
        }
        const result = this.lww(
          user,
          user.documents,
          c.key,
          c.clientModifiedAt,
          index,
          (seq) => ({ data: null, deleted: true, cma: c.clientModifiedAt, seq }),
          () => this.docChange(user, c.key),
        );
        if (result.status === 'applied') {
          for (const h of user.highlights.values()) {
            if (h.fingerprint === c.key && !h.deleted) {
              h.deleted = true;
              h.data = null;
              h.seq = this.bump(user);
            }
          }
        }
        return result;
      }
      case 'highlight': {
        const fp = c.op === 'upsert' ? c.data.fingerprint : c.fingerprint;
        const stubIfNeeded = (): void => {
          const doc = user.documents.get(fp);
          if (c.op === 'upsert' && (doc === undefined || doc.deleted)) {
            user.documents.set(fp, {
              data: {
                title: null,
                pageCount: null,
                lastPage: null,
                pageOffset: null,
                fileBytes: null,
              },
              deleted: false,
              cma: c.clientModifiedAt,
              seq: this.bump(user),
            });
          }
        };
        const existing = user.highlights.get(c.id);
        if (existing !== undefined && c.clientModifiedAt <= existing.cma) {
          return { index, status: 'stale', current: this.highlightChange(user, c.id) };
        }
        stubIfNeeded();
        const seq = this.bump(user);
        user.highlights.set(c.id, {
          data: c.op === 'upsert' ? (c.data as unknown as Record<string, unknown>) : null,
          deleted: c.op === 'delete',
          cma: c.clientModifiedAt,
          seq,
          fingerprint: fp,
        });
        return this.applied(index, seq);
      }
    }
  }

  private wordChange(user: UserState, key: string): ServerChange {
    const w = user.words.get(key)!;
    return {
      kind: 'word',
      key,
      seq: String(w.seq),
      deleted: w.deleted,
      clientModifiedAt: w.cma,
      data: w.data as never,
    };
  }
  private docChange(user: UserState, key: string): ServerChange {
    const d = user.documents.get(key)!;
    return {
      kind: 'document',
      key,
      seq: String(d.seq),
      deleted: d.deleted,
      clientModifiedAt: d.cma,
      data: d.data as never,
      storage: { state: 'none', bytes: null },
    };
  }
  private highlightChange(user: UserState, id: string): ServerChange {
    const h = user.highlights.get(id)!;
    return {
      kind: 'highlight',
      id,
      seq: String(h.seq),
      deleted: h.deleted,
      clientModifiedAt: h.cma,
      fingerprint: h.fingerprint,
      data: h.data as never,
    };
  }

  // ---- pull ---------------------------------------------------------------------------

  private pull(user: UserState, request: RecordedRequest): Response {
    const cursor = Number(request.query.get('cursor') ?? '0');
    const limit = Number(request.query.get('limit') ?? '500');
    if (cursor > 0 && cursor < user.floor) return err(410, 'CURSOR_EXPIRED');
    const all: ServerChange[] = [
      ...[...user.words.keys()].map((k) => this.wordChange(user, k)),
      ...[...user.chat].map(([id, m]) => ({
        kind: 'chat' as const,
        id,
        seq: String(m.seq),
        data: m.data as never,
      })),
      ...[...user.documents.keys()].map((k) => this.docChange(user, k)),
      ...[...user.highlights.keys()].map((k) => this.highlightChange(user, k)),
    ]
      .filter((c) => Number(c.seq) > cursor)
      .sort((a, b) => Number(a.seq) - Number(b.seq));
    const changes = all.slice(0, limit);
    const last = changes.at(-1);
    return json(200, {
      changes,
      nextCursor: last === undefined ? String(cursor) : last.seq,
      hasMore: all.length > limit,
    });
  }
}

export { wordKey };

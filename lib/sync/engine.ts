import { ENDPOINTS } from '../../shared/api-contract/endpoints';
import { PullResponse, PushResponse } from '../../shared/api-contract/sync';
import { SYNC } from '../config/constants';
import { notifyAccountStatusChanged, notifyDataChanged } from '../data/channel';
import type { StoreName } from '../data/db';
import { ApiRequestError } from '../account/api';
import {
  NotSignedInError,
  SessionLostError,
  StorageLockedError,
  type TokenClient,
} from '../account/tokens';
import { toChange, toPushRequest, type Candidate } from './payload';
import type { SyncErrorCode, SyncStateStore } from './state';
import {
  applyPulled,
  applyPushResults,
  collectBatch,
  countPending,
  markUnpushable,
  newPullContext,
  reconcile,
  sweepUnseen,
} from './store';

/**
 * The sync engine (docs/clavis-sync-design.md 4.3, 4.6, 4.7). Background only. One run at a time
 * (a navigator.locks lock), push then pull, with a debounced push after SYNC_KICK, a periodic
 * alarm, and exponential backoff through a one-shot alarm.
 */

export interface AlarmsLike {
  create(
    name: string,
    info: { when?: number; delayInMinutes?: number; periodInMinutes?: number },
  ): Promise<void> | void;
  clear(name: string): Promise<boolean> | Promise<void> | void;
  get(name: string): Promise<unknown>;
}

export interface LocksLike {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
}

export interface EngineDeps {
  tokens: TokenClient;
  state: SyncStateStore;
  alarms: AlarmsLike;
  /** `FEATURES.accountSync`: false means the engine never does anything. */
  enabled: boolean;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  locks?: LocksLike;
  newId?: () => string;
  notify?: (stores: readonly StoreName[]) => void;
  batchSize?: number;
  /** Tokens vanished under a bound device (or the server ended the session): sign out locally, keep the data. */
  onSessionLost: () => Promise<void>;
  /** Pages one pull may take before it stops as a retryable error. */
  maxPullPages?: number;
  /** Sync started or ended: tell open pages to re-read the status (a bare signal). */
  onStatusChanged?: () => void;
}

export type RunResult =
  | { status: 'ok' }
  | { status: 'signed-out' }
  | { status: 'disabled' }
  | { status: 'error'; code: SyncErrorCode };

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'offline';
  pending: number;
  rejected: number;
  lastSyncAt?: number;
  error?: SyncErrorCode;
}

class PullCapError extends Error {
  constructor() {
    super('sync:pull-cap');
  }
}

class NoProgressError extends Error {
  constructor() {
    super('sync:no-progress');
  }
}

const MAX_PUSH_ROUNDS = 50;

/** One in-process mutex, the fallback where navigator.locks does not exist (tests). */
function memoryLocks(): LocksLike {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    request(_name, callback) {
      const run = tail.then(callback, callback);
      tail = run.catch(() => undefined);
      return run;
    },
  };
}

export function defaultLocks(): LocksLike {
  const real = (globalThis.navigator as Navigator | undefined)?.locks;
  return real === undefined
    ? memoryLocks()
    : { request: (name, callback) => real.request(name, callback) as Promise<never> };
}

export function createSyncEngine(deps: EngineDeps) {
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const locks = deps.locks ?? defaultLocks();
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const notify = deps.notify ?? notifyDataChanged;
  const batchSize = deps.batchSize ?? 200;
  const maxPages = deps.maxPullPages ?? 100;
  const statusChanged = deps.onStatusChanged ?? notifyAccountStatusChanged;

  let running = false;
  let current: Promise<RunResult> | null = null;
  let next: Promise<RunResult> | null = null;
  let pushTimer: unknown = null;
  /** The batch in flight: a retry of the same batch reuses its Idempotency-Key. */
  let pending: { signature: string; key: string } | null = null;

  async function push(accountId: string, signal?: AbortSignal, deadline?: number): Promise<void> {
    for (let round = 0; round < MAX_PUSH_ROUNDS; round += 1) {
      if (deadline !== undefined && now() > deadline) return;
      const candidates = await collectBatch(batchSize);
      if (candidates.length === 0) return;
      const sendable: { candidate: Candidate; change: NonNullable<ReturnType<typeof toChange>> }[] =
        [];
      const unpushable: Candidate[] = [];
      for (const candidate of candidates) {
        const change = toChange(candidate);
        if (change === null) unpushable.push(candidate);
        else sendable.push({ candidate, change });
      }
      if (unpushable.length > 0) {
        await markUnpushable(unpushable);
        await deps.state.update(accountId, {
          rejectedCount: ((await deps.state.read())?.rejectedCount ?? 0) + unpushable.length,
        });
      }
      if (sendable.length === 0) continue;

      const signature = sendable.map(({ candidate: c }) => `${c.kind}:${c.key}:${c.rev}`).join('|');
      if (pending?.signature !== signature) pending = { signature, key: newId() };
      const body = toPushRequest(sendable.map((s) => s.change));
      const response = await deps.tokens.request({
        method: 'POST',
        path: ENDPOINTS.syncPush.path,
        headers: { 'Idempotency-Key': pending.key },
        body,
        response: PushResponse,
        ...(signal === undefined ? {} : { signal }),
      });
      pending = null;
      const touched = new Set<StoreName>();
      const outcome = await applyPushResults(
        sendable.map((s) => s.candidate),
        response.results,
        touched,
      );
      await deps.state.update(accountId, {
        lastPushAt: now(),
        ...(outcome.rejected > 0
          ? { rejectedCount: ((await deps.state.read())?.rejectedCount ?? 0) + outcome.rejected }
          : {}),
      });
      if (touched.size > 0) notify([...touched]);
      if (outcome.progress === 0) throw new NoProgressError();
    }
  }

  async function stillBound(accountId: string): Promise<void> {
    if ((await deps.state.read())?.accountId !== accountId) throw new SessionLostError();
  }

  async function pull(accountId: string): Promise<void> {
    const start = await deps.state.read();
    if (start === null) throw new SessionLostError();
    let cursor = start.cursor;
    let full = false;
    let ctx = newPullContext();
    let pages = 0;
    for (;;) {
      // A full resync legitimately takes many pages; a normal pull that does not end is a fault.
      pages += 1;
      if (pages > (full ? 10 * maxPages : maxPages)) throw new PullCapError();
      let page;
      try {
        page = await deps.tokens.request({
          method: 'GET',
          path: ENDPOINTS.syncPull.path,
          query: { cursor, limit: '500' },
          response: PullResponse,
        });
      } catch (error) {
        if (error instanceof ApiRequestError && error.code === 'CURSOR_EXPIRED' && !full) {
          // Full resync: pull everything, then drop what the server no longer lists.
          full = true;
          cursor = '0';
          ctx = newPullContext();
          continue;
        }
        throw error;
      }
      await stillBound(accountId);
      await applyPulled(page.changes, ctx);
      const advanced = page.nextCursor !== cursor;
      cursor = page.nextCursor;
      // During a full resync the old cursor stays until the end, so an interrupted one restarts.
      if (!full) await deps.state.update(accountId, { cursor });
      if (!page.hasMore) break;
      if (!advanced) throw new NoProgressError();
    }
    await stillBound(accountId);
    if (full) await sweepUnseen(ctx);
    await reconcile(ctx);
    await deps.state.update(accountId, { cursor, lastPullAt: now() });
    if (ctx.touched.size > 0) notify([...ctx.touched]);
  }

  function classify(error: unknown): SyncErrorCode {
    if (error instanceof ApiRequestError) {
      return error.code === 'NETWORK'
        ? 'NETWORK'
        : error.code === 'BAD_RESPONSE'
          ? 'INTERNAL'
          : error.code;
    }
    return 'INTERNAL';
  }

  async function scheduleRetry(accountId: string, error: unknown): Promise<void> {
    // The count lives in `clavis.sync-state`, so a worker that keeps crashing still backs off.
    const failures = ((await deps.state.read())?.failures ?? 0) + 1;
    const backoff = Math.min(SYNC.backoffBaseMs * 2 ** (failures - 1), SYNC.backoffMaxMs);
    const hinted = error instanceof ApiRequestError ? error.retryAfterMs : undefined;
    // A server hint can lengthen the wait, never shorten it (Retry-After: 0 must not disable backoff).
    const delay = Math.min(Math.max(hinted ?? 0, backoff), SYNC.backoffMaxMs);
    await deps.state.update(accountId, { failures, retryAt: now() + delay });
    // chrome.alarms will not fire sooner than about 30 s.
    await deps.alarms.create(SYNC.retryAlarmName, { when: now() + Math.max(delay, 30_000) });
  }

  async function doRun(options: { push: boolean; pull: boolean }): Promise<RunResult> {
    if (!deps.enabled) return { status: 'disabled' };
    return locks.request(SYNC.lockName, async () => {
      const state = await deps.state.read();
      if (state === null) return { status: 'signed-out' } as const;
      running = true;
      statusChanged();
      try {
        if (options.push) await push(state.accountId);
        if (options.pull) await pull(state.accountId);
        pending = null;
        await deps.alarms.clear(SYNC.retryAlarmName);
        await deps.state.update(state.accountId, {}, ['lastError', 'failures', 'retryAt']);
        return { status: 'ok' } as const;
      } catch (error) {
        if (error instanceof SessionLostError) return { status: 'signed-out' } as const;
        if (error instanceof NotSignedInError) {
          // Tokens vanished under a bound device: it can never recover on its own. Same as a
          // session the server ended: sign out locally, keep the data, show the notice.
          await deps.onSessionLost().catch(() => undefined);
          return { status: 'signed-out' } as const;
        }
        if (error instanceof StorageLockedError) {
          await deps.state.update(state.accountId, { lastError: 'INTERNAL' });
          await scheduleRetry(state.accountId, error);
          return { status: 'error', code: 'INTERNAL' } as const;
        }
        if (error instanceof ApiRequestError && error.code === 'IDEMPOTENCY_MISMATCH')
          pending = null;
        const code = classify(error);
        await deps.state.update(state.accountId, { lastError: code });
        await scheduleRetry(state.accountId, error);
        return { status: 'error', code } as const;
      } finally {
        running = false;
        statusChanged();
      }
    });
  }

  /**
   * Run now. At most one run is in flight and one waits behind it (a kick during a push still gets
   * its own push afterwards); further callers share the waiting one.
   */
  function run(options: { push: boolean; pull: boolean }): Promise<RunResult> {
    if (!deps.enabled) return Promise.resolve({ status: 'disabled' });
    const start = (): Promise<RunResult> => {
      const p = doRun(options).finally(() => {
        if (current === p) current = null;
      });
      current = p;
      return p;
    };
    if (current === null) return start();
    if (next !== null) return next;
    next = current.then(() => {
      next = null;
      return start();
    });
    return next;
  }

  const cancelPushTimer = (): void => {
    if (pushTimer !== null) clearTimer(pushTimer);
    pushTimer = null;
  };

  async function ensureAlarm(): Promise<void> {
    if (!deps.enabled || (await deps.state.read()) === null) return;
    if ((await deps.alarms.get(SYNC.alarmName)) == null) {
      await deps.alarms.create(SYNC.alarmName, {
        delayInMinutes: SYNC.alarmPeriodMinutes,
        periodInMinutes: SYNC.alarmPeriodMinutes,
      });
    }
  }

  return {
    /** Local data changed (SYNC_KICK, a saved word): push soon, after everyone's edits coalesce. */
    async kick(pullToo = false): Promise<void> {
      if (!deps.enabled) return;
      const state = await deps.state.read();
      if (state === null || now() < (state.retryAt ?? 0)) return;
      if (pullToo) {
        const recent =
          state.lastPullAt !== undefined && now() - state.lastPullAt < SYNC.pullKickMinGapMs;
        if (!recent) {
          void run({ push: true, pull: true });
          return;
        }
      }
      if (pushTimer !== null) return;
      pushTimer = setTimer(() => {
        pushTimer = null;
        void run({ push: true, pull: true });
      }, SYNC.pushDebounceMs);
    },

    /** The Sync now button, and the first sync after sign-in. Ignores backoff. */
    syncNow(): Promise<RunResult> {
      cancelPushTimer();
      return run({ push: true, pull: true });
    },

    /** `runtime.onStartup`. */
    async onStartup(): Promise<void> {
      if (!deps.enabled || (await deps.state.read()) === null) return;
      await ensureAlarm();
      await run({ push: true, pull: true });
    },

    async onAlarm(name: string): Promise<void> {
      if (name !== SYNC.alarmName && name !== SYNC.retryAlarmName) return;
      await run({ push: true, pull: true });
    },

    /** The 30-minute alarm exists while signed in. */
    ensureAlarm,

    /** Sign-out and session loss: no timer, alarm or backoff survives. */
    async stop(): Promise<void> {
      cancelPushTimer();
      pending = null;
      await deps.alarms.clear(SYNC.alarmName);
      await deps.alarms.clear(SYNC.retryAlarmName);
    },

    /**
     * Hold the engine's lock (no push or pull can interleave) and run `work`, which may start with
     * a final push bounded by `budgetMs` (sign-out, design 4.7).
     */
    async exclusive<T>(
      work: (helpers: { finalPush(budgetMs: number): Promise<void> }) => Promise<T>,
    ): Promise<T> {
      cancelPushTimer();
      return locks.request(SYNC.lockName, () =>
        work({
          async finalPush(budgetMs) {
            const state = await deps.state.read();
            if (state === null) return;
            const controller = new AbortController();
            const timer = setTimer(() => controller.abort(), budgetMs);
            try {
              await push(state.accountId, controller.signal, now() + budgetMs);
            } catch {
              // Best effort: what is left shows as "not synced yet".
            } finally {
              clearTimer(timer);
            }
          },
        }),
      );
    },

    async status(): Promise<SyncStatus> {
      const state = await deps.state.read();
      if (state === null) return { state: 'idle', pending: 0, rejected: 0 };
      const last = Math.max(state.lastPullAt ?? 0, state.lastPushAt ?? 0);
      return {
        state: running
          ? 'syncing'
          : state.lastError === undefined
            ? 'idle'
            : state.lastError === 'NETWORK'
              ? 'offline'
              : 'error',
        pending: await countPending(),
        rejected: state.rejectedCount ?? 0,
        ...(last > 0 ? { lastSyncAt: last } : {}),
        ...(state.lastError === undefined ? {} : { error: state.lastError }),
      };
    },
  };
}

export type SyncEngine = ReturnType<typeof createSyncEngine>;

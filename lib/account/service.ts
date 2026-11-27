import { AccountResponse, ENDPOINTS, TokenPair } from '../../shared/api-contract/endpoints';
import { SYNC } from '../config/constants';
import type { AccountStatus } from '../contracts/account';
import type { ErrorCode } from '../contracts/errors';
import { notifyAccountStatusChanged, notifyDataChanged } from '../data/channel';
import { STORE_NAMES } from '../data/db';
import type { SyncEngine } from '../sync/engine';
import type { SyncStateStore } from '../sync/state';
import { countPending, detachForKeep, markAllDirty, wipeLocal } from '../sync/store';
import type { StorageAreaLike } from '../storage/area';
import { STORAGE_KEYS } from '../storage/keys';
import { ApiRequestError, type ApiClient } from './api';
import { OVERRIDES_ALLOWED, type AccountConfig } from './config';
import { withLoginHint } from './dev-config';
import { buildAuthorizeUrl, createPkceSecrets, parseCallback, type Random } from './pkce';
import {
  NotSignedInError,
  SessionLostError,
  StorageLockedError,
  type TokenClient,
  type TokenStore,
} from './tokens';

/**
 * Sign-in, sign-out and status (docs/clavis-sync-design.md 2.2, 4.7). Background only.
 * "Signed in" means `clavis.sync-state` names an account, the same flag the data writers read.
 */

export type ServiceResult<T = unknown> = ({ ok: true } & T) | { ok: false; code: ErrorCode };

export interface IdentityApi {
  getRedirectURL(): string;
  launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
}

export interface AccountServiceDeps {
  config: AccountConfig;
  api: ApiClient;
  tokens: TokenClient;
  store: TokenStore;
  state: SyncStateStore;
  engine: SyncEngine;
  /** `chrome.storage.local` (for the non-secret notice). */
  local: StorageAreaLike;
  identity: IdentityApi;
  enabled: boolean;
  random?: Random;
  onStatusChanged?: () => void;
  newId?: () => string;
  now?: () => number;
  notify?: (stores: readonly (typeof STORE_NAMES)[number][]) => void;
}

/** How long the server's storage usage is reused (a refresh is forced after an upload or removal). */
const USAGE_TTL_MS = 30_000;
const USAGE_FAILURE_TTL_MS = 10_000;
const USAGE_TIMEOUT_MS = 5_000;
type Usage = NonNullable<AccountStatus['usage']>;

const idleSync = { state: 'idle', pending: 0, rejected: 0 } as const;

export function createAccountService(deps: AccountServiceDeps) {
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const notify = deps.notify ?? notifyDataChanged;
  const statusChanged = deps.onStatusChanged ?? notifyAccountStatusChanged;
  const now = deps.now ?? Date.now;
  let signingIn: Promise<ServiceResult> | null = null;
  let usageCache: { at: number; ttl: number; value: Usage | null } | null = null;
  /** Bumped by every sign-out and data clear; a sign-in or refresh started earlier is dropped. */
  let generation = 0;

  const setNotice = (): Promise<void> =>
    deps.local.set({ [STORAGE_KEYS.accountNotice]: { v: 1, data: 'session-ended' } });
  const clearNotice = (): Promise<void> => deps.local.remove(STORAGE_KEYS.accountNotice);

  async function readNotice(): Promise<'session-ended' | undefined> {
    try {
      const raw = (await deps.local.get(STORAGE_KEYS.accountNotice))[STORAGE_KEYS.accountNotice];
      return (raw as { data?: unknown } | undefined)?.data === 'session-ended'
        ? 'session-ended'
        : undefined;
    } catch {
      return undefined;
    }
  }

  async function doSignIn(): Promise<ServiceResult> {
    if (!deps.enabled) return { ok: false, code: 'NOT_CONFIGURED' };
    if (deps.config.googleClientId === '') return { ok: false, code: 'NOT_CONFIGURED' };
    if ((await deps.state.read()) !== null) return { ok: true };

    const started = generation;
    const secrets = await createPkceSecrets(deps.random);
    const redirectUri = deps.identity.getRedirectURL();
    const plainUrl = buildAuthorizeUrl({
      authUrl: deps.config.googleAuthUrl,
      clientId: deps.config.googleClientId,
      redirectUri,
      secrets,
    });
    // Dev/test builds only: a fake Google picks its user from `login_hint`. Compiled out of store builds.
    const url = OVERRIDES_ALLOWED ? withLoginHint(plainUrl, deps.config.googleLoginHint) : plainUrl;
    let returned: string | undefined;
    try {
      returned = await deps.identity.launchWebAuthFlow({ url, interactive: true });
    } catch (error) {
      // Chrome: "The user did not approve access." / "Authorization page could not be loaded."
      const message = error instanceof Error ? error.message : '';
      return {
        ok: false,
        code: /did not approve|cancel/i.test(message) ? 'CANCELLED' : 'OAUTH_FAILED',
      };
    }
    const callback = parseCallback(returned, redirectUri, secrets.state);
    if (!callback.ok)
      return { ok: false, code: callback.reason === 'cancelled' ? 'CANCELLED' : 'OAUTH_FAILED' };

    let pair: TokenPair;
    try {
      pair = await deps.api.request({
        method: 'POST',
        path: ENDPOINTS.extensionGoogle.path,
        body: {
          code: callback.code,
          codeVerifier: secrets.codeVerifier,
          redirectUri,
          nonce: secrets.nonce,
        },
        response: TokenPair,
      });
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.code === 'EMAIL_NOT_VERIFIED') return { ok: false, code: 'EMAIL_NOT_VERIFIED' };
        if (error.code === 'RATE_LIMITED') return { ok: false, code: 'RATE_LIMITED' };
        if (error.transient) return { ok: false, code: 'NETWORK_ERROR' };
      }
      return { ok: false, code: 'OAUTH_FAILED' };
    }

    // The rest runs under the sync lock and re-checks the generation: a sign-out or CLEAR_ALL_DATA
    // that happened while Google's window was open must not be undone by this sign-in finishing.
    const bound = await deps.engine.exclusive(async (): Promise<ServiceResult> => {
      if (generation !== started) return { ok: false, code: 'CANCELLED' };
      try {
        await deps.tokens.adopt(pair);
      } catch (error) {
        await deps.store.clear();
        return {
          ok: false,
          code: error instanceof StorageLockedError ? 'STORAGE_UNAVAILABLE' : 'INTERNAL_ERROR',
        };
      }
      // First sign-in merge (design 4.7): bind the device FIRST so concurrent writers mark their
      // edits dirty, then mark everything that exists as new to the account.
      await deps.state.start({ accountId: pair.user.id, cursor: '0', deviceId: newId() });
      await markAllDirty();
      await clearNotice();
      await deps.engine.ensureAlarm();
      notify([...STORE_NAMES]);
      statusChanged();
      return { ok: true };
    });
    if (bound.ok) void deps.engine.syncNow();
    return bound;
  }

  /** Everything after the network part of a sign-out. Never throws. */
  async function detachLocally(keepLocalCopy: boolean): Promise<void> {
    generation += 1;
    usageCache = null;
    // Unbind first: writers stop marking dirty, the engine finds nobody to work for.
    await deps.store.clear().catch(() => undefined);
    await deps.state.clear().catch(() => undefined);
    await (keepLocalCopy ? detachForKeep() : wipeLocal()).catch(() => undefined);
    await deps.engine.stop().catch(() => undefined);
    notify([...STORE_NAMES]);
    statusChanged();
  }

  /** `GET /v1/account` usage, cached briefly; null when the server cannot be asked. Never throws. */
  async function readUsage(): Promise<Usage | null> {
    if (usageCache !== null && now() - usageCache.at < usageCache.ttl) return usageCache.value;
    const started = generation;
    let value: Usage | null;
    try {
      const account = await deps.tokens.request({
        method: 'GET',
        path: ENDPOINTS.account.path,
        response: AccountResponse,
        timeoutMs: USAGE_TIMEOUT_MS,
      });
      value = {
        storageUsedBytes: account.usage.storageUsedBytes,
        storageQuotaBytes: account.usage.storageQuotaBytes,
      };
    } catch {
      value = null;
    }
    // Signed out (or data cleared) while asking: remember nothing.
    if (generation === started) {
      usageCache = { at: now(), ttl: value === null ? USAGE_FAILURE_TTL_MS : USAGE_TTL_MS, value };
    }
    return value;
  }

  return {
    /** The next status asks the server again (after a file was stored or removed). */
    invalidateUsage(): void {
      usageCache = null;
    },

    /** ACCOUNT_SIGN_IN. One at a time. */
    signIn(): Promise<ServiceResult> {
      signingIn ??= doSignIn().finally(() => {
        signingIn = null;
      });
      return signingIn;
    },

    /** ACCOUNT_SIGN_OUT (design 4.7). */
    async signOut(keepLocalCopy: boolean): Promise<ServiceResult<{ unsyncedDropped: number }>> {
      // At once, before waiting for the lock: a sign-in or refresh in flight is now stale.
      generation += 1;
      const unsynced = await deps.engine.exclusive(async ({ finalPush }) => {
        if ((await deps.state.read()) === null) return 0;
        await finalPush(SYNC.signOutPushBudgetMs);
        const left = await countPending();
        try {
          const session = await deps.store.readSession();
          if (session !== null) {
            await deps.api.request({
              method: 'POST',
              path: ENDPOINTS.extensionLogout.path,
              body: { refreshToken: session.refreshToken },
              // The logout call shares the sign-out's time budget.
              signal: AbortSignal.timeout(SYNC.signOutPushBudgetMs),
            });
          }
        } catch {
          // Best effort: the server expires the family on its own.
        }
        await detachLocally(keepLocalCopy);
        return left;
      });
      return { ok: true, unsyncedDropped: keepLocalCopy ? 0 : unsynced };
    },

    /** ACCOUNT_SIGN_OUT_EVERYWHERE: revoke every session, then sign out here keeping a copy. */
    async signOutEverywhere(): Promise<ServiceResult> {
      if ((await deps.state.read()) === null) return { ok: false, code: 'NOT_SIGNED_IN' };
      try {
        await deps.tokens.request({ method: 'POST', path: ENDPOINTS.logoutAll.path });
      } catch (error) {
        // The only "done" is a session that ended on its own (already signed out locally).
        if (error instanceof SessionLostError) return { ok: true };
        if (error instanceof NotSignedInError) {
          await deps.engine.exclusive(() => detachLocally(true));
          return { ok: false, code: 'NOT_SIGNED_IN' };
        }
        if (error instanceof StorageLockedError) return { ok: false, code: 'STORAGE_UNAVAILABLE' };
        if (error instanceof ApiRequestError) {
          return { ok: false, code: error.transient ? 'NETWORK_ERROR' : 'INTERNAL_ERROR' };
        }
        return { ok: false, code: 'INTERNAL_ERROR' };
      }
      await deps.engine.exclusive(() => detachLocally(true));
      return { ok: true };
    },

    /** The sign-out/clear generation (the token client drops refreshes started under another one). */
    generation: (): number => generation,

    /** CLEAR_ALL_DATA: whatever sign-in or refresh is in flight must not write anything back. */
    invalidate(): void {
      generation += 1;
    },

    /** The server ended the session (revoked, reused, deleted): sign out here, keep the data, say so. */
    async sessionLost(): Promise<void> {
      await detachLocally(true);
      await setNotice().catch(() => undefined);
    },

    /** ACCOUNT_GET_STATUS. Never a token. */
    async getStatus(): Promise<AccountStatus> {
      if (!deps.enabled) return { enabled: false, signedIn: false, sync: idleSync };
      const state = await deps.state.read();
      const notice = await readNotice();
      if (state === null) {
        return {
          enabled: true,
          signedIn: false,
          ...(notice === undefined ? {} : { notice }),
          sync: idleSync,
        };
      }
      let email: string | undefined;
      let displayName: string | undefined;
      try {
        const session = await deps.store.readSession();
        email = session?.email;
        displayName = session?.displayName ?? undefined;
      } catch {
        // Locked storage: still signed in, identity unknown for now.
      }
      return {
        enabled: true,
        signedIn: true,
        ...(email === undefined ? {} : { email }),
        ...(displayName === undefined ? {} : { displayName }),
        sync: await deps.engine.status(),
        usage: await readUsage(),
      };
    },
  };
}

export type AccountService = ReturnType<typeof createAccountService>;

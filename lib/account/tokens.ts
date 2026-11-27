import { z } from 'zod';
import { ENDPOINTS, TokenPair } from '../../shared/api-contract/endpoints';
import type { StorageAreaLike } from '../storage/area';
import { STORAGE_KEYS, unwrapRecord, wrapRecord } from '../storage/keys';
import { ApiRequestError, type ApiClient, type BlobRequestSpec, type RequestSpec } from './api';

/**
 * Token storage and refresh (docs/clavis-sync-design.md 2.3, 2.4). Background only. These are the
 * only modules that reference STORAGE_KEYS.accountSession / accountAccess (rule R1), tokens are
 * read only after the storage lockdown succeeded (R3), never logged, never in IndexedDB, and
 * never part of any reply.
 */

const sessionSchema = z.strictObject({
  refreshToken: z.string().min(1),
  refreshExpiresAt: z.number(),
  userId: z.string().min(1),
  email: z.string(),
  displayName: z.string().nullable(),
});
export type AccountSession = z.infer<typeof sessionSchema>;

const accessSchema = z.strictObject({ accessToken: z.string().min(1), expiresAt: z.number() });

/** Tokens cannot be read now (storage lockdown failed): try again later, do not sign out. */
export class StorageLockedError extends Error {
  constructor() {
    super('account:storage-locked');
  }
}
/** There is no session on this device. */
export class NotSignedInError extends Error {
  constructor() {
    super('account:not-signed-in');
  }
}
/** The server ended the session; the device has been signed out locally. */
export class SessionLostError extends Error {
  constructor() {
    super('account:session-lost');
  }
}

export interface TokenStoreDeps {
  local: StorageAreaLike;
  session: StorageAreaLike;
  lockedDown: () => Promise<boolean>;
}

export interface TokenStore {
  readSession(): Promise<AccountSession | null>;
  readAccess(): Promise<{ accessToken: string; expiresAt: number } | null>;
  writePair(pair: TokenPair): Promise<void>;
  /** Always allowed (R3): deleting tokens never needs the lockdown. */
  clear(): Promise<void>;
}

export function createTokenStore(deps: TokenStoreDeps): TokenStore {
  const guard = async (): Promise<void> => {
    if (!(await deps.lockedDown())) throw new StorageLockedError();
  };
  return {
    async readSession() {
      await guard();
      const raw = unwrapRecord(
        (await deps.local.get(STORAGE_KEYS.accountSession))[STORAGE_KEYS.accountSession],
      );
      const parsed = sessionSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    async readAccess() {
      await guard();
      const raw = unwrapRecord(
        (await deps.session.get(STORAGE_KEYS.accountAccess))[STORAGE_KEYS.accountAccess],
      );
      const parsed = accessSchema.safeParse(raw);
      return parsed.success ? parsed.data : null;
    },
    async writePair(pair) {
      await guard();
      // The refresh token first: if the worker dies in between, the next call refreshes again.
      await deps.local.set({
        [STORAGE_KEYS.accountSession]: wrapRecord({
          refreshToken: pair.refreshToken,
          refreshExpiresAt: pair.refreshTokenExpiresAt,
          userId: pair.user.id,
          email: pair.user.email,
          displayName: pair.user.displayName,
        } satisfies AccountSession),
      });
      await deps.session.set({
        [STORAGE_KEYS.accountAccess]: wrapRecord({
          accessToken: pair.accessToken,
          expiresAt: pair.accessTokenExpiresAt,
        }),
      });
    },
    async clear() {
      await Promise.all([
        deps.local.remove(STORAGE_KEYS.accountSession),
        deps.session.remove(STORAGE_KEYS.accountAccess),
      ]);
    },
  };
}

/** Refresh answers that mean "this session is over". */
const SESSION_OVER = new Set([
  'UNAUTHENTICATED',
  'TOKEN_EXPIRED',
  'SESSION_REVOKED',
  'TOKEN_REUSED',
]);
/** Refresh within this long before the access token expires. */
const EXPIRY_MARGIN_MS = 60_000;

export interface TokenClientDeps {
  store: TokenStore;
  api: ApiClient;
  now?: () => number;
  /** Sign out locally (keepLocalCopy = true) with a notice. Called once, then SessionLostError is thrown. */
  onSessionLost: () => Promise<void>;
  /**
   * Counts sign-outs and data clears. A refresh or sign-in that started under another generation
   * is dropped: it must not write tokens back after the user signed out.
   */
  generation?: () => number;
}

export interface TokenClient {
  /** A valid access token, refreshing (single flight) when it is about to expire. */
  accessToken(signal?: AbortSignal): Promise<string>;
  /** An authenticated call; a 401 refreshes once and repeats. */
  request<S extends z.ZodType | undefined = undefined>(
    spec: Omit<RequestSpec<S>, 'token'>,
  ): Promise<S extends z.ZodType ? z.infer<S> : undefined>;
  /** An authenticated file download (a 401 refreshes once and repeats), bounded by `maxBytes`. */
  requestBlob(spec: Omit<BlobRequestSpec, 'token'>): Promise<Blob>;
  /** Store the pair of a fresh sign-in. */
  adopt(pair: TokenPair): Promise<void>;
}

export function createTokenClient(deps: TokenClientDeps): TokenClient {
  const now = deps.now ?? Date.now;
  let inFlight: Promise<string> | null = null;
  let lost: Promise<void> | null = null;

  const sessionLost = async (): Promise<never> => {
    lost ??= deps.onSessionLost().finally(() => {
      lost = null;
    });
    await lost.catch(() => undefined);
    throw new SessionLostError();
  };

  const generation = deps.generation ?? (() => 0);

  async function refreshOnce(signal?: AbortSignal): Promise<string> {
    const started = generation();
    let session = await deps.store.readSession();
    if (session === null) throw new NotSignedInError();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const pair = await deps.api.request({
          method: 'POST',
          path: ENDPOINTS.extensionRefresh.path,
          body: { refreshToken: session.refreshToken },
          response: TokenPair,
          ...(signal === undefined ? {} : { signal }),
        });
        // Signed out (or data cleared) while this was in flight: drop the result.
        if (generation() !== started) throw new SessionLostError();
        if (pair.user.id !== session.userId) return sessionLost();
        await deps.store.writePair(pair);
        if (generation() !== started) {
          await deps.store.clear();
          throw new SessionLostError();
        }
        return pair.accessToken;
      } catch (error) {
        if (!(error instanceof ApiRequestError)) throw error;
        // A refresh that was overtaken by a sign-out is not a lost session: nothing to report.
        if (generation() !== started) throw new SessionLostError();
        if (error.code === 'TOKEN_REUSED') {
          // A refresh that raced ours may already have rotated the token: use what is stored now.
          const stored = await deps.store.readSession();
          if (stored !== null && stored.refreshToken !== session.refreshToken && attempt === 0) {
            session = stored;
            continue;
          }
        }
        if (SESSION_OVER.has(error.code)) return sessionLost();
        throw error;
      }
    }
    return sessionLost();
  }

  const refresh = (signal?: AbortSignal): Promise<string> => {
    inFlight ??= refreshOnce(signal).finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  async function accessToken(signal?: AbortSignal): Promise<string> {
    const access = await deps.store.readAccess();
    if (access !== null && access.expiresAt - now() > EXPIRY_MARGIN_MS) return access.accessToken;
    return refresh(signal);
  }

  /** Run `call` with an access token; a 401 refreshes once and repeats (the shared auth loop). */
  async function authorized<T>(
    signal: AbortSignal | undefined,
    call: (token: string) => Promise<T>,
  ): Promise<T> {
    let token = await accessToken(signal);
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await call(token);
      } catch (error) {
        if (!(error instanceof ApiRequestError)) throw error;
        if (error.code === 'SESSION_REVOKED') return sessionLost();
        if (attempt === 0 && (error.code === 'UNAUTHENTICATED' || error.code === 'TOKEN_EXPIRED')) {
          token = await refresh(signal);
          continue;
        }
        throw error;
      }
    }
  }

  return {
    accessToken,
    adopt: (pair) => deps.store.writePair(pair),
    request(spec) {
      return authorized(spec.signal, (token) =>
        deps.api.request({ ...spec, token } as RequestSpec<never>),
      ) as never;
    },
    requestBlob(spec) {
      return authorized(spec.signal, (token) => deps.api.requestBlob({ ...spec, token }));
    },
  };
}

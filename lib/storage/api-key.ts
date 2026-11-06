import { z } from 'zod';
import { LIMITS } from '../config/constants';
import {
  keyStatusSchema,
  type KeyStatus,
  type KeyStorage,
  type KeyVerification,
  type ModelInfo,
} from '../contracts';
import { createQueue, type StorageAreaLike } from './area';
import { StorageUnavailableError } from './errors';
import { KEY_RECORD_KEYS, STORAGE_KEYS, unwrapRecord, wrapRecord } from './keys';

/** Shown only when the key is long enough that four characters reveal little (rule 5). */
const MIN_KEY_CHARS_FOR_LAST4 = 12;

const keyRecordSchema = z.strictObject({ key: z.string().min(1).max(LIMITS.maxApiKeyChars) });
const keyMetaSchema = keyStatusSchema.omit({ hasKey: true });
type KeyMeta = z.infer<typeof keyMetaSchema>;

export const NO_KEY_STATUS: KeyStatus = {
  hasKey: false,
  storage: null,
  last4: null,
  verification: 'never',
  verifiedAt: null,
  models: [],
};

/** A stored key. Contains the SECRET: it must never leave the background. */
export interface StoredApiKey {
  apiKey: string;
  /** The area it is stored in (the area decides, not the metadata). */
  storage: KeyStorage;
  status: KeyStatus;
}

/** Outcome of a key check (FR-004), written by `recordVerification`. */
export type VerificationUpdate =
  | { verification: 'valid'; models: ModelInfo[]; at: number }
  | { verification: 'invalid'; verificationHttpStatus?: number }
  | {
      verification: 'unverified';
      verificationHttpStatus?: number;
      forbiddenReason?: KeyStatus['forbiddenReason'];
      accessProbe?: KeyStatus['accessProbe'];
    };

export interface ApiKeyStore {
  /**
   * The stored key and its status, or `undefined` when none is stored.
   * Rejects with StorageUnavailableError when the storage lockdown did not succeed.
   */
  read(): Promise<StoredApiKey | undefined>;
  /** Key status without the secret. Same failure behaviour as `read`. */
  getStatus(): Promise<KeyStatus>;
  /**
   * Store the key in exactly one area (the other is cleared first) with fresh metadata.
   * Rejects with StorageUnavailableError.
   */
  set(apiKey: string, storage: KeyStorage): Promise<KeyStatus>;
  /**
   * Record a check result, but only if `expectedApiKey` is still the stored key (a check
   * that raced a key change or removal must not write stale state). Returns the new
   * status, or `undefined` when the key changed or is gone.
   */
  recordVerification(
    expectedApiKey: string,
    update: VerificationUpdate,
  ): Promise<KeyStatus | undefined>;
  /** Clear the key and its metadata from BOTH areas. Allowed even without the lockdown. */
  remove(): Promise<void>;
  /** Run `task` after every queued key operation and before the next (CLEAR_ALL_DATA). */
  exclusive<T>(task: () => Promise<T>): Promise<T>;
}

export interface ApiKeyStoreDeps {
  local: StorageAreaLike;
  session: StorageAreaLike;
  /** Secret boundary rule 1: resolves true only if every area was restricted. */
  lockedDown(): Promise<boolean>;
}

function last4Of(apiKey: string): string | null {
  return apiKey.length >= MIN_KEY_CHARS_FOR_LAST4 ? apiKey.slice(-4) : null;
}

function toStatus(storage: KeyStorage, meta: KeyMeta): KeyStatus {
  return keyStatusSchema.parse({ hasKey: true, ...meta, storage });
}

/** Read one area. The area, not the stored metadata, decides where the key lives. */
function readArea(raw: Record<string, unknown>, storage: KeyStorage): StoredApiKey | undefined {
  const record = keyRecordSchema.safeParse(unwrapRecord(raw[STORAGE_KEYS.apiKey]));
  if (!record.success) return undefined;
  const apiKey = record.data.key;
  const stored = keyMetaSchema.safeParse(unwrapRecord(raw[STORAGE_KEYS.keyMeta]));
  const meta: KeyMeta = stored.success
    ? stored.data
    : {
        storage,
        last4: last4Of(apiKey),
        verification: 'never',
        verifiedAt: null,
        models: [],
      };
  return { apiKey, storage, status: toStatus(storage, meta) };
}

export function createApiKeyStore(deps: ApiKeyStoreDeps): ApiKeyStore {
  const areas: Record<KeyStorage, StorageAreaLike> = { local: deps.local, session: deps.session };
  const serial = createQueue();

  async function gate(): Promise<void> {
    const ok = await deps.lockedDown().catch(() => false);
    if (!ok) throw new StorageUnavailableError();
  }

  async function readStored(): Promise<StoredApiKey | undefined> {
    await gate();
    try {
      const [session, local] = await Promise.all([
        areas.session.get([...KEY_RECORD_KEYS]),
        areas.local.get([...KEY_RECORD_KEYS]),
      ]);
      // Both areas should never hold a key; if they do, the more restrictive one wins.
      return readArea(session, 'session') ?? readArea(local, 'local');
    } catch {
      throw new StorageUnavailableError();
    }
  }

  return {
    exclusive: serial,

    read: () => serial(readStored),

    getStatus: () =>
      serial(async () => {
        const stored = await readStored();
        return stored?.status ?? NO_KEY_STATUS;
      }),

    set: (apiKey, storage) =>
      serial(async () => {
        await gate();
        const other: KeyStorage = storage === 'local' ? 'session' : 'local';
        const meta: KeyMeta = {
          storage,
          last4: last4Of(apiKey),
          verification: 'never',
          verifiedAt: null,
          models: [],
        };
        const status = toStatus(storage, meta);
        try {
          // Clear the other area FIRST: a failure here must not leave the key in both.
          await areas[other].remove([...KEY_RECORD_KEYS]);
          await areas[storage].set({
            [STORAGE_KEYS.apiKey]: wrapRecord({ key: apiKey }),
            [STORAGE_KEYS.keyMeta]: wrapRecord(meta),
          });
        } catch {
          throw new StorageUnavailableError();
        }
        return status;
      }),

    recordVerification: (expectedApiKey, update) =>
      serial(async () => {
        const stored = await readStored();
        if (stored === undefined || stored.apiKey !== expectedApiKey) return undefined;
        const current = stored.status;
        const verification: KeyVerification = update.verification;
        const meta: KeyMeta = {
          storage: stored.storage,
          last4: current.last4,
          verification,
          ...('verificationHttpStatus' in update && update.verificationHttpStatus !== undefined
            ? { verificationHttpStatus: update.verificationHttpStatus }
            : {}),
          ...('forbiddenReason' in update && update.forbiddenReason !== undefined
            ? { forbiddenReason: update.forbiddenReason }
            : {}),
          ...('accessProbe' in update && update.accessProbe !== undefined
            ? { accessProbe: update.accessProbe }
            : {}),
          // FR-072: an invalid result clears the "verified" state but nothing else the user set.
          verifiedAt:
            update.verification === 'valid'
              ? update.at
              : update.verification === 'invalid'
                ? null
                : current.verifiedAt,
          models:
            update.verification === 'valid'
              ? update.models
              : update.verification === 'invalid'
                ? []
                : current.models,
        };
        const parsed = keyMetaSchema.parse(meta);
        try {
          await areas[stored.storage].set({ [STORAGE_KEYS.keyMeta]: wrapRecord(parsed) });
        } catch {
          throw new StorageUnavailableError();
        }
        return toStatus(stored.storage, parsed);
      }),

    remove: () =>
      serial(async () => {
        try {
          // Deleting exposes nothing, so it is allowed even if the lockdown failed.
          await Promise.all([
            areas.local.remove([...KEY_RECORD_KEYS]),
            areas.session.remove([...KEY_RECORD_KEYS]),
          ]);
        } catch {
          throw new StorageUnavailableError();
        }
      }),
  };
}

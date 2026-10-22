import { GroqError } from '../../ai/errors';
import type { GroqModel } from '../../ai/groq';
import {
  modelIdSchema,
  type KeyStatus,
  type KeyStorage,
  type MessageReply,
  type ModelInfo,
} from '../../contracts';
import { logger } from '../../security/logger';
import { NO_KEY_STATUS, type ApiKeyStore, type VerificationUpdate } from '../../storage';
import { failure, success } from '../replies';

/** The only provider calls the key lifecycle needs. */
export interface KeyProvider {
  listModels(apiKey: string, signal?: AbortSignal): Promise<GroqModel[]>;
}

export interface KeyServiceDeps {
  store: ApiKeyStore;
  provider: KeyProvider;
  now(): number;
  /** Called after the key is replaced or removed: abort requests that were using the old key. */
  onKeyChanged(): void;
}

/**
 * Model ids that can never answer a text explanation: speech-to-text, text-to-speech,
 * safety classifiers and embeddings. They are listed by the same endpoint, so they are
 * filtered here (FR-005: offer only compatible models).
 */
const NON_TEXT_MODEL = /whisper|tts|orpheus|guard|embed|moderat|transcri|speech/i;

/** Map the provider list to the model picker: active, text-capable, bounded, sorted, unique. */
export function toModelInfos(models: readonly GroqModel[]): ModelInfo[] {
  const seen = new Set<string>();
  const out: ModelInfo[] = [];
  for (const model of models) {
    if (model.active === false) continue;
    if (!modelIdSchema.safeParse(model.id).success) continue;
    if (NON_TEXT_MODEL.test(model.id) || seen.has(model.id)) continue;
    seen.add(model.id);
    out.push({ id: model.id, supportsJsonSchema: model.supportsJsonSchema });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id)).slice(0, 200);
}

/**
 * Run the key check (FR-004, architecture §6): list the models with the key.
 * 200 -> valid; 401/403 -> invalid; anything else (network, timeout, 429, 5xx, bad body)
 * -> unverified, which is "connection not verified", NEVER "invalid key".
 */
export async function checkKey(
  provider: KeyProvider,
  apiKey: string,
  now: () => number,
): Promise<VerificationUpdate> {
  try {
    const models = await provider.listModels(apiKey);
    return { verification: 'valid', models: toModelInfos(models), at: now() };
  } catch (error) {
    if (error instanceof GroqError && error.code === 'INVALID_API_KEY') {
      return { verification: 'invalid' };
    }
    return { verification: 'unverified' };
  }
}

export interface KeyService {
  getStatus(): Promise<MessageReply<KeyStatus>>;
  /** Store the key (one area only) and check it immediately. */
  set(apiKey: string, storage: KeyStorage): Promise<MessageReply<KeyStatus>>;
  /** Re-check the stored key (FR-004). SETUP_REQUIRED if there is none. */
  test(): Promise<MessageReply<KeyStatus>>;
  remove(): Promise<MessageReply<KeyStatus>>;
  /**
   * An AI request came back 401/403: mark the key invalid so the UI prompts for a new one
   * (FR-072). Keeps every setting. No-op if the key has changed since.
   */
  markInvalid(apiKey: string): Promise<void>;
}

export function createKeyService(deps: KeyServiceDeps): KeyService {
  const { store } = deps;

  async function verifyStored(expectedApiKey: string): Promise<KeyStatus> {
    const outcome = await checkKey(deps.provider, expectedApiKey, deps.now);
    const recorded = await store.recordVerification(expectedApiKey, outcome);
    // undefined: the key was replaced or removed while the check ran; report what is stored now.
    return recorded ?? (await store.getStatus());
  }

  return {
    getStatus: async () => success(await store.getStatus()),

    set: async (apiKey, storage) => {
      await store.set(apiKey, storage);
      deps.onKeyChanged();
      return success(await verifyStored(apiKey));
    },

    test: async () => {
      const stored = await store.read();
      if (stored === undefined) return failure('SETUP_REQUIRED');
      return success(await verifyStored(stored.apiKey));
    },

    remove: async () => {
      await store.remove();
      deps.onKeyChanged();
      return success(NO_KEY_STATUS);
    },

    markInvalid: async (apiKey) => {
      try {
        await store.recordVerification(apiKey, { verification: 'invalid' });
      } catch {
        logger.warn('key_mark_invalid_failed');
      }
    },
  };
}

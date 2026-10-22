import { GroqError } from '../../ai/errors';
import type { ExplainOptions } from '../../ai/groq';
import { MODEL_CANDIDATES } from '../../config/constants';
import type {
  AiStatus,
  ErrorCode,
  ExplainRequest,
  ExplainResult,
  MessageReply,
  PublicSettings,
} from '../../contracts';
import { logger } from '../../security/logger';
import { StorageUnavailableError, type ApiKeyStore, type SettingsStore } from '../../storage';
import { senderKey, type AiGuard } from '../limiter';
import { failure, success } from '../replies';
import type { RouteContext } from '../router';
import type { KeyProvider, KeyService } from './key';

export interface AiProvider extends KeyProvider {
  explain(request: ExplainRequest, options: ExplainOptions): Promise<ExplainResult>;
}

export interface AiHandlerDeps {
  settings: SettingsStore;
  keys: ApiKeyStore;
  keyService: Pick<KeyService, 'markInvalid'>;
  provider: AiProvider;
  guard: AiGuard;
  lockedDown(): Promise<boolean>;
}

/** The model used for a request: the user's choice, else the D-09 candidate (never silently a paid tier). */
export function effectiveModel(preferred: string | undefined): string {
  return preferred ?? MODEL_CANDIDATES.quick;
}

type Readiness =
  | { state: 'ready'; apiKey: string; model: string; explanationLanguage: string }
  | { state: Exclude<AiStatus['state'], 'ready'>; model?: string };

/** `lockedDown` never rejects in production; a rejecting stand-in still fails closed. */
async function isLockedDown(deps: AiHandlerDeps): Promise<boolean> {
  try {
    return await deps.lockedDown();
  } catch {
    return false;
  }
}

/** Whether a key is stored; false (never an error) when storage is unusable. */
async function hasStoredKey(deps: AiHandlerDeps): Promise<boolean> {
  try {
    return (await isLockedDown(deps)) && (await deps.keys.read()) !== undefined;
  } catch {
    return false;
  }
}

/**
 * Readiness gate shared by GET_AI_STATUS and AI_EXPLAIN. Order matters: storage first
 * (fail closed), then key, then disclosure (FR-002), then the last verification (FR-072).
 * A model that is no longer in the account's list does not change the state: the UI
 * learns it from KeyStatus.models and prompts, and the user picks (FR-005).
 */
async function evaluate(deps: AiHandlerDeps): Promise<Readiness> {
  if (!(await isLockedDown(deps))) return { state: 'storage_unavailable' };

  let stored;
  try {
    stored = await deps.keys.read();
  } catch (error) {
    if (error instanceof StorageUnavailableError) return { state: 'storage_unavailable' };
    throw error;
  }
  if (stored === undefined) return { state: 'setup_required' };

  const [preferences, onboarding] = await Promise.all([
    deps.settings.getPreferences(),
    deps.settings.getOnboarding(),
  ]);
  const model = effectiveModel(preferences.model);
  if (onboarding.disclosureAcceptedAt === null) return { state: 'disclosure_required', model };
  if (stored.status.verification === 'invalid') return { state: 'invalid_key', model };
  return {
    state: 'ready',
    apiKey: stored.apiKey,
    model,
    explanationLanguage: preferences.explanationLanguage,
  };
}

const NOT_READY_CODE: Record<Exclude<AiStatus['state'], 'ready'>, ErrorCode> = {
  storage_unavailable: 'STORAGE_UNAVAILABLE',
  setup_required: 'SETUP_REQUIRED',
  // The disclosure must be acknowledged on an extension page first (FR-002); the UI reads
  // GET_AI_STATUS to tell this apart from a missing key.
  disclosure_required: 'SETUP_REQUIRED',
  invalid_key: 'INVALID_API_KEY',
};

export function createAiHandlers(deps: AiHandlerDeps) {
  return {
    async getAiStatus(): Promise<MessageReply<AiStatus>> {
      const readiness = await evaluate(deps);
      return success({
        state: readiness.state,
        ...(readiness.model === undefined ? {} : { model: readiness.model }),
      });
    },

    async getPublicSettings(): Promise<MessageReply<PublicSettings>> {
      const hasKey = await hasStoredKey(deps);
      const [preferences, onboarding] = await Promise.all([
        deps.settings.getPreferences(),
        deps.settings.getOnboarding(),
      ]);
      return success({
        hasKey,
        disclosureAccepted: onboarding.disclosureAcceptedAt !== null,
        explanationLanguage: preferences.explanationLanguage,
        readingLevel: preferences.readingLevel,
        tooltipBehavior: preferences.tooltipBehavior,
        ttsRate: preferences.ttsRate,
        ...(preferences.ttsLang === undefined ? {} : { ttsLang: preferences.ttsLang }),
        ...(preferences.model === undefined ? {} : { model: preferences.model }),
      });
    },

    /** AI_EXPLAIN. The caller has been authorized and the payload validated by the router. */
    async explain(
      payload: ExplainRequest,
      context: RouteContext,
    ): Promise<MessageReply<ExplainResult>> {
      const { requestId } = payload;
      const sender = senderKey(context.sender);

      // Rate limit first, so rejected and invalid calls cost nothing but cannot be free to spam.
      const decision = deps.guard.buckets.take(sender);
      if (!decision.ok) {
        return failure('RATE_LIMITED', { requestId, retryAfterMs: decision.retryAfterMs });
      }
      // Phase 5 adds the lazy tab modes; until then only `core` is served.
      if (payload.mode !== 'core') return failure('INVALID_REQUEST', { requestId });

      // Register BEFORE reading the key: a SET/REMOVE_API_KEY or CLEAR_ALL_DATA that lands while
      // readiness is being evaluated aborts this entry (onKeyChanged -> abortAll), and the
      // signal is checked before the provider is ever called. A new request from this sender
      // aborts its previous one (see lib/router/limiter.ts).
      const inFlight = deps.guard.inFlight.begin(sender, requestId);
      let apiKey: string | undefined;
      try {
        const readiness = await evaluate(deps);
        // Aborted while the key was being read (replaced, removed, cleared, superseded)?
        if (inFlight.signal.aborted) return failure('REQUEST_CANCELLED', { requestId });
        if (readiness.state !== 'ready') {
          return failure(NOT_READY_CODE[readiness.state], { requestId });
        }
        apiKey = readiness.apiKey;
        const result = await deps.provider.explain(
          { ...payload, targetLanguage: payload.targetLanguage ?? readiness.explanationLanguage },
          { apiKey, model: readiness.model, signal: inFlight.signal },
        );
        return success(result, requestId);
      } catch (error) {
        if (!(error instanceof GroqError)) {
          logger.error('explain_unexpected_failure', { requestId });
          return failure('INTERNAL_ERROR', { requestId });
        }
        // FR-072: a rejected key flips the status to invalid but keeps every setting.
        if (error.code === 'INVALID_API_KEY' && apiKey !== undefined) {
          await deps.keyService.markInvalid(apiKey);
        }
        return failure(error.code, { requestId, retryAfterMs: error.retryAfterMs });
      } finally {
        inFlight.end();
      }
    },

    /** AI_CANCEL: only the sender's own in-flight request can be cancelled. */
    async cancel(
      requestId: string,
      context: RouteContext,
    ): Promise<MessageReply<{ cancelled: boolean }>> {
      const cancelled = deps.guard.inFlight.cancel(senderKey(context.sender), requestId);
      return success({ cancelled }, requestId);
    },
  };
}

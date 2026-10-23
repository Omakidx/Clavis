import { GroqError } from '../../ai/errors';
import type { ExplainOptions } from '../../ai/groq';
import {
  FEATURES,
  MODE_FEATURE_FLAGS,
  MODEL_CANDIDATES,
  EXTENSION_PAGES,
} from '../../config/constants';
import type {
  AiStatus,
  ErrorCode,
  ExplainRequest,
  ExplainResult,
  MessageReply,
  PublicSettings,
  ReadingLevel,
} from '../../contracts';
import { logger } from '../../security/logger';
import { StorageUnavailableError, type ApiKeyStore, type SettingsStore } from '../../storage';
import { senderKey, type AiGuard } from '../limiter';
import { failure, success } from '../replies';
import type { RouteContext } from '../router';
import { PRACTICE_PAGE_PATH, type ClassifiedSender } from '../sender';
import type { KeyProvider, KeyService } from './key';

export interface AiProvider extends KeyProvider {
  explain(request: ExplainRequest, options: ExplainOptions): Promise<ExplainResult>;
}

/** Which optional (Should) modes are enabled; `lib/config/constants` FEATURES by default. */
export type FeatureFlags = Record<keyof typeof FEATURES, boolean>;

export interface AiHandlerDeps {
  settings: SettingsStore;
  keys: ApiKeyStore;
  keyService: Pick<KeyService, 'markInvalid'>;
  provider: AiProvider;
  guard: AiGuard;
  lockedDown(): Promise<boolean>;
  /** Overridable for tests; the build-time flags otherwise. */
  features?: FeatureFlags;
}

/**
 * Senders that may carry `acknowledgeDisclosure`: the contexts that show the one-time "Send this
 * to Groq?" prompt (the card in a web page's content world and the practice page). The reader is NOT
 * allowed yet: it has no card until Phase 7, so add it here together with its card. The popup,
 * options and onboarding pages have their own privileged ACCEPT_DISCLOSURE route and never call
 * AI_EXPLAIN, so the flag from them is refused.
 */
export function mayAcknowledgeDisclosure(sender: ClassifiedSender): boolean {
  if (sender.kind === 'content') return true;
  // The practice page and (since Phase 7) the PDF reader host the explanation card.
  return (
    sender.kind === 'extension' &&
    (sender.path === PRACTICE_PAGE_PATH || sender.path === EXTENSION_PAGES.reader)
  );
}

/** The model used for a request: the user's choice, else the D-09 candidate (never silently a paid tier). */
export function effectiveModel(preferred: string | undefined): string {
  return preferred ?? MODEL_CANDIDATES.quick;
}

type Readiness =
  | {
      state: 'ready';
      apiKey: string;
      model: string;
      explanationLanguage: string;
      readingLevel: ReadingLevel;
    }
  | { state: Exclude<AiStatus['state'], 'ready'>; model?: string };

/** Whether a mode may be served: Must modes always, Should modes behind their feature flag. */
export function modeEnabled(mode: ExplainRequest['mode'], features: FeatureFlags): boolean {
  const flag = (MODE_FEATURE_FLAGS as Record<string, keyof FeatureFlags | undefined>)[mode];
  return flag === undefined || features[flag];
}

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
    readingLevel: preferences.readingLevel,
  };
}

const NOT_READY_CODE: Record<Exclude<AiStatus['state'], 'ready'>, ErrorCode> = {
  storage_unavailable: 'STORAGE_UNAVAILABLE',
  setup_required: 'SETUP_REQUIRED',
  // Not reached from AI_EXPLAIN: that route answers disclosure_required itself (with
  // `reason: 'disclosure'`) so the card can show the one-time prompt.
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

    /**
     * AI_EXPLAIN. The caller has been authorized and the payload validated by the router.
     * Gates, in order: rate limit, mode (flagged-off modes), the acknowledgement flag's sender,
     * readiness (storage, key, disclosure, last key check), then the provider. Never retried here.
     */
    async explain(
      payload: ExplainRequest,
      context: RouteContext,
      options: { acknowledgeDisclosure?: boolean } = {},
    ): Promise<MessageReply<ExplainResult>> {
      const { requestId } = payload;
      const sender = senderKey(context.sender);

      // Rate limit first, so rejected and invalid calls cost nothing but cannot be free to spam.
      const decision = deps.guard.buckets.take(sender);
      if (!decision.ok) {
        return failure('RATE_LIMITED', {
          requestId,
          retryAfterMs: decision.retryAfterMs,
          reason: 'local-limit',
        });
      }
      // Should-priority modes stay off until their flags are on (Phase 8 decides).
      if (!modeEnabled(payload.mode, deps.features ?? FEATURES)) {
        return failure('INVALID_REQUEST', { requestId });
      }
      // The disclosure flag is only meaningful from the contexts that show the prompt.
      const acknowledging = options.acknowledgeDisclosure === true;
      if (acknowledging && !mayAcknowledgeDisclosure(context.sender)) {
        return failure('INVALID_REQUEST', { requestId });
      }

      // Register BEFORE reading the key: a SET/REMOVE_API_KEY or CLEAR_ALL_DATA that lands while
      // readiness is being evaluated aborts this entry (onKeyChanged -> abortAll), and the
      // signal is checked before the provider is ever called. A new request from this sender
      // aborts its previous one (see lib/router/limiter.ts).
      const inFlight = deps.guard.inFlight.begin(sender, requestId);
      let apiKey: string | undefined;
      try {
        let readiness = await evaluate(deps);
        // Aborted while the key was being read (replaced, removed, cleared, superseded)?
        if (inFlight.signal.aborted) return failure('REQUEST_CANCELLED', { requestId });

        if (readiness.state === 'disclosure_required') {
          // A key exists but the user never acknowledged what is sent (FR-002, onboarding skipped).
          // Without the flag the card shows "Send this to Groq?" and resends with it.
          if (!acknowledging) {
            return failure('SETUP_REQUIRED', { requestId, reason: 'disclosure' });
          }
          await deps.settings.acceptDisclosure();
          readiness = await evaluate(deps);
          if (inFlight.signal.aborted) return failure('REQUEST_CANCELLED', { requestId });
        }
        if (readiness.state !== 'ready') {
          return failure(NOT_READY_CODE[readiness.state], { requestId });
        }
        apiKey = readiness.apiKey;
        const result = await deps.provider.explain(
          { ...payload, targetLanguage: payload.targetLanguage ?? readiness.explanationLanguage },
          {
            apiKey,
            model: readiness.model,
            readingLevel: readiness.readingLevel,
            signal: inFlight.signal,
          },
        );
        return success(result, requestId);
      } catch (error) {
        if (error instanceof StorageUnavailableError) {
          return failure('STORAGE_UNAVAILABLE', { requestId });
        }
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

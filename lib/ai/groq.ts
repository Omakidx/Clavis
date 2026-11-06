import { z } from 'zod';
import { GROQ, LIMITS, REQUEST_TIMEOUT_MS } from '../config/constants';
import {
  explainRequestSchema,
  modelIdSchema,
  type ExplainRequest,
  type ExplainResult,
  type ReadingLevel,
} from '../contracts';
import { logger as defaultLogger, type LogMetadata } from '../security/logger';
import { maxCompletionTokensFor } from './budgets';
import { getModelCapabilities, type ModelCapabilities } from './capabilities';
import { createCapabilityCache, type CapabilityCache } from './capability-cache';
import {
  GroqError,
  codeForStatus,
  parseRetryAfter,
  type GroqErrorInit,
  type GroqUsage,
} from './errors';
import type { AccessProbe, ForbiddenReason } from '../contracts/setup';
import { buildResult, schemaNameFor, strictSchemaFor } from './modes';
import { buildPrompt, type ResponseMode } from './prompts';

export type { ResponseMode } from './prompts';

/** Sampling temperature for explanations: low, but not greedy. */
const TEMPERATURE = 0.2;
/** Hard cap on provider response bytes, enforced while reading (never buffer past it). */
const MAX_BODY_BYTES = 1_048_576;
/** Printable ASCII only: blocks header injection and obvious paste mistakes before any network call. */
const API_KEY_PATTERN = /^[\x21-\x7e]+$/;
/** Provider error identifiers are kept only if they look like short tokens. */
const TOKEN_PATTERN = /^[A-Za-z0-9_.-]{1,48}$/;
/** A 400 mentioning these means the model/endpoint rejected `response_format` itself. */
const UNSUPPORTED_FORMAT_PATTERN =
  /response_format|json_schema|json schema|structured output|json_object|json mode/i;
/** A 400 naming the effort parameter means this model does not take `reasoning_effort`. */
const UNSUPPORTED_EFFORT_PATTERN = /reasoning[_ -]?effort/i;
/**
 * At most this many HTTP exchanges per explain call: the first attempt, one fallback for an
 * unsupported `response_format` and one for an unsupported `reasoning_effort`. Never a loop.
 */
const MAX_ATTEMPTS = 3;
/** Thinking-model wrappers some models put in `content` before the JSON. */
const THINK_BLOCK = /^\s*<think>[\s\S]*?<\/think>\s*/;

export interface GroqModel {
  id: string;
  ownedBy?: string;
  active?: boolean;
  contextWindow?: number;
  /** Capability-table verdict, not a live probe. */
  supportsJsonSchema: boolean;
}

export interface ExplainOptions {
  apiKey: string;
  model: string;
  signal?: AbortSignal;
  /** Preferred response format. Defaults from the capability table. */
  responseMode?: ResponseMode;
  /** Overall deadline for the call including its capability fallbacks. */
  timeoutMs?: number;
  /** Override the per-mode budget table (lib/ai/budgets.ts). */
  maxCompletionTokens?: number;
  /** The user's reading level (FR-006). Defaults to `standard`. */
  readingLevel?: ReadingLevel;
}

export interface ExplainDetails {
  result: ExplainResult;
  /** Format that produced the result. */
  responseMode: ResponseMode;
  /** Format of the first attempt (json_object when a cached verdict skipped json_schema). */
  startedWith: ResponseMode;
  /** True when json_schema was rejected with a 400 and the call was retried as json_object. */
  fellBack: boolean;
  /** `reasoning_effort` value of the successful request, null when none was sent. */
  reasoningEffort: 'low' | null;
  /** `max_completion_tokens` of the successful request. */
  maxCompletionTokens: number;
  usage: GroqUsage;
  finishReason: string | undefined;
  requestCount: number;
  /** Provider error identifiers of the rejected json_schema attempt, when `fellBack`. Diagnostic only. */
  fallbackFrom?: { providerErrorType?: string; providerErrorCode?: string };
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface GroqDeps {
  /** Injected for tests and the mock spike run. Defaults to the global fetch. */
  fetch?: FetchLike;
  logger?: Pick<typeof defaultLogger, 'debug' | 'warn' | 'error'>;
  /** Monotonic-ish clock in ms. Defaults to `performance.now()`. */
  now?: () => number;
  /** Wall clock in ms, used for HTTP-date Retry-After. Defaults to `Date.now()`. */
  wallNow?: () => number;
  /**
   * What this account's models were observed to accept. Defaults to a private in-memory cache;
   * the background passes one backed by `chrome.storage.session`.
   */
  capabilityCache?: CapabilityCache;
}

// ---------------------------------------------------------------------------
// Tolerant provider-response schemas: only what we consume, unknown keys ignored.
// ---------------------------------------------------------------------------

const modelListSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1).max(LIMITS.maxModelIdChars),
      owned_by: z.string().optional(),
      active: z.boolean().optional(),
      context_window: z.number().optional(),
    }),
  ),
});

const completionSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({ content: z.string().nullable().optional() }),
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .min(1),
  usage: z
    .object({
      prompt_tokens: z.number().optional(),
      completion_tokens: z.number().optional(),
      total_tokens: z.number().optional(),
      completion_tokens_details: z.object({ reasoning_tokens: z.number().optional() }).optional(),
    })
    .optional(),
});

function readUsage(usage: z.infer<typeof completionSchema>['usage']): GroqUsage {
  if (!usage) return {};
  const out: GroqUsage = {};
  if (usage.prompt_tokens !== undefined) out.promptTokens = usage.prompt_tokens;
  if (usage.completion_tokens !== undefined) out.completionTokens = usage.completion_tokens;
  if (usage.total_tokens !== undefined) out.totalTokens = usage.total_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  if (reasoning !== undefined) out.reasoningTokens = reasoning;
  return out;
}

interface HttpOutcome {
  status: number;
  ok: boolean;
  text: string;
  retryAfter: string | null;
}

/**
 * Read a response body as text without ever holding more than `maxBytes`.
 * Rejects early on a declared Content-Length over the cap, then counts streamed bytes and
 * cancels the stream the moment the cap is crossed.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const tooLarge = () => new GroqError('INVALID_RESPONSE', { stage: 'body' });
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).length > maxBytes) throw tooLarge();
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function tokenOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && TOKEN_PATTERN.test(value) ? value : undefined;
}

/** Best-effort read of Groq's `{ error: { message, type, code } }` body. */
function readProviderError(text: string): { type?: string; code?: string; message: string } {
  try {
    const parsed: unknown = JSON.parse(text);
    const error = (parsed as { error?: unknown } | null)?.error;
    if (typeof error !== 'object' || error === null) return { message: '' };
    const { message, type, code } = error as Record<string, unknown>;
    const out: { type?: string; code?: string; message: string } = {
      message: typeof message === 'string' ? message : '',
    };
    const safeType = tokenOrUndefined(type);
    const safeCode = tokenOrUndefined(code);
    if (safeType) out.type = safeType;
    if (safeCode) out.code = safeCode;
    return out;
  } catch {
    return { message: '' };
  }
}

/** Classify only recognized 403 markers. Never persist or forward the response body. */
function forbiddenReason(text: string, type?: string, code?: string): ForbiddenReason {
  if (code === 'model_permission_blocked_org' || type === 'model_permission_blocked_org') {
    return 'model_permission_org';
  }
  if (code === 'model_permission_blocked_project' || type === 'model_permission_blocked_project') {
    return 'model_permission_project';
  }
  if (code === 'model_permission_blocked' || type === 'model_permission_blocked') {
    return 'model_permission';
  }
  // The documented Groq error.type identifies a permission response without naming its scope.
  if (type === 'permissions_error') return 'permission_restriction';
  // Cloudflare challenge/block pages contain its name and a numeric 1xxx error code.
  // Numbers alone are insufficient; a provider message might contain them as ordinary text.
  if (/cloudflare/i.test(text)) {
    if (/\b1009\b/.test(text)) return 'region_block';
    if (/\b(?:1010|1020)\b/.test(text)) return 'edge_block';
  }
  return 'unknown';
}

export class GroqProvider {
  readonly id = 'groq' as const;
  private readonly deps: GroqDeps;
  private readonly cache: CapabilityCache;

  constructor(deps: GroqDeps = {}) {
    this.deps = deps;
    this.cache = deps.capabilityCache ?? createCapabilityCache();
  }

  private get log(): NonNullable<GroqDeps['logger']> {
    return this.deps.logger ?? defaultLogger;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : performance.now();
  }

  private wallNow(): number {
    return this.deps.wallNow ? this.deps.wallNow() : Date.now();
  }

  private doFetch(url: string, init: RequestInit): Promise<Response> {
    // Never call a detached `fetch` through an object: browsers throw "Illegal invocation".
    return this.deps.fetch ? this.deps.fetch(url, init) : globalThis.fetch(url, init);
  }

  /** One bounded HTTP exchange. Transport failures become typed `GroqError`s. */
  private async send(
    url: string,
    init: { method: 'GET' | 'POST'; apiKey: string; body?: string },
    signals: { caller: AbortSignal | undefined; deadline: AbortSignal },
  ): Promise<HttpOutcome> {
    // Cancelled while waiting for the capability cache (or between fallback attempts): no request.
    if (signals.caller?.aborted) throw new GroqError('REQUEST_CANCELLED');
    const signal = signals.caller
      ? AbortSignal.any([signals.caller, signals.deadline])
      : signals.deadline;
    try {
      const response = await this.doFetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${init.apiKey}`,
          Accept: 'application/json',
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
        signal,
        // The key rides in a header: never follow a redirect (it could leak to another host),
        // send no cookies or referrer, and never serve or store a cached response.
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      const text = await readBoundedText(response, MAX_BODY_BYTES);
      return {
        status: response.status,
        ok: response.ok,
        text,
        retryAfter: response.headers.get('retry-after'),
      };
    } catch (error) {
      if (error instanceof GroqError) throw error;
      if (signals.caller?.aborted) throw new GroqError('REQUEST_CANCELLED');
      if (signals.deadline.aborted) throw new GroqError('TIMEOUT');
      // The raw TypeError can include request details; never forward its message.
      throw new GroqError('NETWORK_ERROR');
    }
  }

  private failure(outcome: HttpOutcome): GroqError {
    const provider = readProviderError(outcome.text);
    const init: GroqErrorInit = { status: outcome.status };
    const retryAfterMs = parseRetryAfter(outcome.retryAfter, this.wallNow());
    if (retryAfterMs !== undefined && outcome.status === 429) init.retryAfterMs = retryAfterMs;
    // Existing format-fallback diagnostics use short provider identifiers on 400s.
    // A 403 keeps only the fixed classification below, never arbitrary provider identifiers.
    if (outcome.status !== 403 && provider.type) init.providerErrorType = provider.type;
    if (outcome.status !== 403 && provider.code) init.providerErrorCode = provider.code;
    if (outcome.status === 403) {
      init.forbiddenReason = forbiddenReason(outcome.text, provider.type, provider.code);
    }
    // Groq returns 400 `json_validate_failed` when its own schema check on the output failed.
    if (outcome.status === 400 && provider.code === 'json_validate_failed') {
      return new GroqError('INVALID_RESPONSE', { ...init, stage: 'schema' });
    }
    const codeFromProviderCode = codeForStatus(outcome.status, provider.code);
    const code =
      codeFromProviderCode === 'NETWORK_ERROR'
        ? codeForStatus(outcome.status, provider.type)
        : codeFromProviderCode;
    return new GroqError(code, init);
  }

  /** List models visible to the key. Also serves as the key check (only 401 proves invalid). */
  async listModels(apiKey: string, signal?: AbortSignal): Promise<GroqModel[]> {
    assertApiKey(apiKey);
    const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS.keyValidation);
    const outcome = await this.send(
      GROQ.modelsUrl,
      { method: 'GET', apiKey },
      { caller: signal, deadline },
    );
    if (!outcome.ok) throw this.failure(outcome);
    let parsed: z.infer<typeof modelListSchema>;
    try {
      parsed = modelListSchema.parse(JSON.parse(outcome.text));
    } catch {
      throw new GroqError('INVALID_RESPONSE', { status: outcome.status, stage: 'schema' });
    }
    return parsed.data.map((entry) => ({
      id: entry.id,
      ...(entry.owned_by !== undefined ? { ownedBy: entry.owned_by } : {}),
      ...(entry.active !== undefined ? { active: entry.active } : {}),
      ...(entry.context_window !== undefined ? { contextWindow: entry.context_window } : {}),
      supportsJsonSchema: getModelCapabilities(entry.id).jsonSchema !== 'unknown',
    }));
  }

  /** Keyless, bounded comparison after a keyed models request returns 403. Reads no body. */
  async probeUnauthenticatedAccess(): Promise<AccessProbe> {
    try {
      const response = await this.doFetch(GROQ.modelsUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(3_000),
        redirect: 'error',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
      void response.body?.cancel().catch(() => undefined);
      if (response.status === 401) return 'auth-required';
      if (response.status === 403) return 'forbidden';
      return 'other-response';
    } catch {
      return 'unreachable';
    }
  }

  /** Explain a selection in the requested mode. Returns the unified result. */
  async explain(request: ExplainRequest, opts: ExplainOptions): Promise<ExplainResult> {
    return (await this.explainDetailed(request, opts)).result;
  }

  /** Like `explain`, plus response mode, fallback flags and token usage for measurement. */
  async explainDetailed(request: ExplainRequest, opts: ExplainOptions): Promise<ExplainDetails> {
    const parsedRequest = explainRequestSchema.safeParse(request);
    if (!parsedRequest.success) throw new TypeError('Invalid explain request');
    const valid = parsedRequest.data;
    if (!modelIdSchema.safeParse(opts.model).success) {
      throw new GroqError('MODEL_UNAVAILABLE');
    }
    assertApiKey(opts.apiKey);

    const started = this.now();
    const meta = (extra: LogMetadata = {}): LogMetadata => ({
      requestId: valid.requestId,
      mode: valid.mode,
      durationMs: Math.round(this.now() - started),
      ...extra,
    });

    const capabilities = getModelCapabilities(opts.model);
    const observed = await this.cache.get(opts.model);
    // What a past call learned beats the static table: a cached rejection is not re-tried.
    const schemaExpected = observed.jsonSchema ?? capabilities.jsonSchema !== 'unknown';
    const startedWith: ResponseMode =
      opts.responseMode ?? (schemaExpected ? 'json_schema' : 'json_object');
    let reasoningEffort: ModelCapabilities['reasoningEffort'] =
      observed.reasoningEffort === false ? null : capabilities.reasoningEffort;
    const maxCompletionTokens =
      opts.maxCompletionTokens ?? maxCompletionTokensFor(valid.mode, capabilities);
    const deadline = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS.default);
    const signals = { caller: opts.signal, deadline };

    let responseMode = startedWith;
    let fellBack = false;
    let fallbackFrom: ExplainDetails['fallbackFrom'];
    let requestCount = 0;
    try {
      for (;;) {
        requestCount += 1;
        const outcome = await this.send(
          GROQ.chatCompletionsUrl,
          {
            method: 'POST',
            apiKey: opts.apiKey,
            body: JSON.stringify(
              buildBody({
                request: valid,
                model: opts.model,
                capabilities,
                responseMode,
                reasoningEffort,
                maxCompletionTokens,
                readingLevel: opts.readingLevel,
              }),
            ),
          },
          signals,
        );
        if (outcome.ok) {
          const mapped = mapCompletion(outcome.text, valid, opts.model);
          // A json_schema request that worked is a verdict worth keeping (an unknown model).
          if (responseMode === 'json_schema' && observed.jsonSchema !== true && !fellBack) {
            await this.cache.record(opts.model, { jsonSchema: true });
          }
          this.log.debug('groq_explain_ok', meta({ status: outcome.status }));
          return {
            ...mapped,
            responseMode,
            startedWith,
            fellBack,
            reasoningEffort,
            maxCompletionTokens,
            requestCount,
            ...(fallbackFrom ? { fallbackFrom } : {}),
          };
        }
        const unsupported = outcome.status === 400 ? readProviderError(outcome.text) : undefined;
        // `json_validate_failed` is the MODEL's output failing the schema, not an unsupported
        // option: never a fallback, and never a cached verdict about the model.
        if (
          unsupported !== undefined &&
          unsupported.code !== 'json_validate_failed' &&
          requestCount < MAX_ATTEMPTS
        ) {
          if (
            responseMode === 'json_schema' &&
            UNSUPPORTED_FORMAT_PATTERN.test(unsupported.message)
          ) {
            const rejected = this.failure(outcome);
            fallbackFrom = {
              ...(rejected.providerErrorType
                ? { providerErrorType: rejected.providerErrorType }
                : {}),
              ...(rejected.providerErrorCode
                ? { providerErrorCode: rejected.providerErrorCode }
                : {}),
            };
            responseMode = 'json_object';
            fellBack = true;
            await this.cache.record(opts.model, { jsonSchema: false });
            this.log.debug('groq_format_fallback', meta({ status: outcome.status }));
            continue;
          }
          if (reasoningEffort !== null && UNSUPPORTED_EFFORT_PATTERN.test(unsupported.message)) {
            reasoningEffort = null;
            await this.cache.record(opts.model, { reasoningEffort: false });
            this.log.debug('groq_effort_fallback', meta({ status: outcome.status }));
            continue;
          }
        }
        throw this.failure(outcome);
      }
    } catch (error) {
      const groqError = error instanceof GroqError ? error : new GroqError('NETWORK_ERROR');
      this.log.warn(
        'groq_explain_failed',
        meta({
          errorCode: groqError.code,
          ...(groqError.status !== undefined ? { status: groqError.status } : {}),
        }),
      );
      throw groqError;
    }
  }
}

function assertApiKey(apiKey: string): void {
  if (
    typeof apiKey !== 'string' ||
    apiKey.length === 0 ||
    apiKey.length > LIMITS.maxApiKeyChars ||
    !API_KEY_PATTERN.test(apiKey)
  ) {
    throw new GroqError('INVALID_API_KEY');
  }
}

interface BodyInput {
  request: ExplainRequest;
  model: string;
  capabilities: ModelCapabilities;
  responseMode: ResponseMode;
  reasoningEffort: ModelCapabilities['reasoningEffort'];
  maxCompletionTokens: number;
  readingLevel: ReadingLevel | undefined;
}

function buildBody(input: BodyInput): Record<string, unknown> {
  const { request, model, capabilities, responseMode, reasoningEffort } = input;
  const responseFormat =
    responseMode === 'json_schema'
      ? {
          type: 'json_schema',
          json_schema: {
            name: schemaNameFor(request.mode),
            strict: capabilities.jsonSchema === 'strict',
            schema: strictSchemaFor(request.mode),
          },
        }
      : { type: 'json_object' };
  return {
    model,
    messages: buildPrompt(request, {
      responseMode,
      ...(input.readingLevel === undefined ? {} : { readingLevel: input.readingLevel }),
    }),
    temperature: TEMPERATURE,
    max_completion_tokens: input.maxCompletionTokens,
    response_format: responseFormat,
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };
}

/** Take only `choices[0].message.content`; ignore reasoning fields entirely. */
function mapCompletion(
  text: string,
  request: ExplainRequest,
  model: string,
): Pick<ExplainDetails, 'result' | 'usage' | 'finishReason'> {
  let body: z.infer<typeof completionSchema>;
  try {
    body = completionSchema.parse(JSON.parse(text));
  } catch {
    throw new GroqError('INVALID_RESPONSE', { stage: 'body' });
  }
  const usage = readUsage(body.usage);
  const choice = body.choices[0];
  const content = choice?.message.content;
  const finishReason = choice?.finish_reason ?? undefined;
  const fail = (stage: 'empty' | 'truncated' | 'json' | 'schema') =>
    new GroqError('INVALID_RESPONSE', { stage, usage });

  if (typeof content !== 'string' || content.trim() === '') throw fail('empty');
  if (finishReason === 'length') throw fail('truncated');
  let json: unknown;
  try {
    json = JSON.parse(content.replace(THINK_BLOCK, ''));
  } catch {
    throw fail('json');
  }
  const result = buildResult(request, model, json);
  if (result === undefined) throw fail('schema');
  return { result, usage, finishReason };
}

/** Shared default instance for tests and tools; the background builds its own with a persistent cache. */
export const groqProvider = new GroqProvider();

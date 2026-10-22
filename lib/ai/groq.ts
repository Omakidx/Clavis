import { z } from 'zod';
import { GROQ, LIMITS, REQUEST_TIMEOUT_MS } from '../config/constants';
import {
  coreOutputSchema,
  explainRequestSchema,
  explainResultSchema,
  modelIdSchema,
  type ExplainRequest,
  type ExplainResult,
} from '../contracts';
import { logger as defaultLogger, type LogMetadata } from '../security/logger';
import { getModelCapabilities } from './capabilities';
import {
  GroqError,
  codeForStatus,
  parseRetryAfter,
  type GroqErrorInit,
  type GroqUsage,
} from './errors';
import { buildCorePrompt, type ResponseMode } from './prompts';
import { dropNulls, toStrictJsonSchema } from './schema';

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
  /** Overall deadline for the call including the one json_object retry. */
  timeoutMs?: number;
  maxCompletionTokens?: number;
}

export interface ExplainDetails {
  result: ExplainResult;
  /** Format that produced the result. */
  responseMode: ResponseMode;
  /** True when json_schema was rejected with a 400 and the call was retried as json_object. */
  fellBack: boolean;
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

export class GroqProvider {
  readonly id = 'groq' as const;
  private readonly deps: GroqDeps;

  constructor(deps: GroqDeps = {}) {
    this.deps = deps;
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
    const signal = signals.caller
      ? AbortSignal.any([signals.caller, signals.deadline])
      : signals.deadline;
    try {
      const response = await this.doFetch(url, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${init.apiKey}`,
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
    if (provider.type) init.providerErrorType = provider.type;
    if (provider.code) init.providerErrorCode = provider.code;
    // Groq returns 400 `json_validate_failed` when its own schema check on the output failed.
    if (outcome.status === 400 && provider.code === 'json_validate_failed') {
      return new GroqError('INVALID_RESPONSE', { ...init, stage: 'schema' });
    }
    return new GroqError(codeForStatus(outcome.status), init);
  }

  /** List models visible to the key. Also serves as the key check (401/403 → INVALID_API_KEY). */
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

  /** Explain a selection (mode `core` only in this spike). Returns the unified result. */
  async explain(request: ExplainRequest, opts: ExplainOptions): Promise<ExplainResult> {
    return (await this.explainDetailed(request, opts)).result;
  }

  /** Like `explain`, plus response mode, fallback flag and token usage for measurement. */
  async explainDetailed(request: ExplainRequest, opts: ExplainOptions): Promise<ExplainDetails> {
    const parsedRequest = explainRequestSchema.safeParse(request);
    if (!parsedRequest.success) throw new TypeError('Invalid explain request');
    const valid = parsedRequest.data;
    if (valid.mode !== 'core') throw new TypeError('Only mode "core" is implemented in Spike A');
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
    const preferred: ResponseMode =
      opts.responseMode ?? (capabilities.jsonSchema === 'unknown' ? 'json_object' : 'json_schema');
    const deadline = AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS.default);
    const signals = { caller: opts.signal, deadline };

    let responseMode = preferred;
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
              buildBody(valid, opts.model, responseMode, opts.maxCompletionTokens),
            ),
          },
          signals,
        );
        if (outcome.ok) {
          const mapped = mapCompletion(outcome.text, valid, opts.model);
          this.log.debug('groq_explain_ok', meta({ status: outcome.status }));
          return {
            ...mapped,
            responseMode,
            fellBack,
            requestCount,
            ...(fallbackFrom ? { fallbackFrom } : {}),
          };
        }
        if (
          outcome.status === 400 &&
          responseMode === 'json_schema' &&
          UNSUPPORTED_FORMAT_PATTERN.test(readProviderError(outcome.text).message)
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
          continue;
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

function buildBody(
  request: ExplainRequest,
  model: string,
  responseMode: ResponseMode,
  maxCompletionTokens: number | undefined,
): Record<string, unknown> {
  const capabilities = getModelCapabilities(model);
  const responseFormat =
    responseMode === 'json_schema'
      ? {
          type: 'json_schema',
          json_schema: {
            name: 'clavis_core',
            strict: capabilities.jsonSchema === 'strict',
            schema: toStrictJsonSchema(coreOutputSchema),
          },
        }
      : { type: 'json_object' };
  return {
    model,
    messages: buildCorePrompt(request, responseMode),
    temperature: TEMPERATURE,
    max_completion_tokens: maxCompletionTokens ?? capabilities.defaultMaxCompletionTokens,
    response_format: responseFormat,
    ...(capabilities.reasoningEffort ? { reasoning_effort: capabilities.reasoningEffort } : {}),
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
    json = JSON.parse(content);
  } catch {
    throw fail('json');
  }
  const core = coreOutputSchema.safeParse(dropNulls(json));
  if (!core.success) throw fail('schema');
  const result = explainResultSchema.safeParse({
    requestId: request.requestId,
    selectedText: request.snapshot.text,
    mode: 'core',
    title: core.data.title,
    summary: core.data.summary,
    contextualMeaning: core.data.contextualMeaning,
    definition: core.data.definition,
    examples: core.data.examples,
    ...(core.data.caveat !== undefined ? { caveat: core.data.caveat } : {}),
    provider: 'groq',
    model,
  });
  if (!result.success) throw fail('schema');
  return { result: result.data, usage, finishReason };
}

/** Shared default instance for the extension background. */
export const groqProvider = new GroqProvider();

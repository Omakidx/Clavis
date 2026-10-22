import type { ErrorCode, ErrorEnvelope } from '../contracts';
import { LIMITS } from '../config/constants';

/** Longest Retry-After the client will ever surface: one hour (matches `errorEnvelopeSchema`). */
export const MAX_RETRY_AFTER_MS = 3_600_000;

/** Fixed, key-free, content-free user-facing messages. Provider bodies are never echoed. */
const MESSAGES: Record<ErrorCode, string> = {
  SETUP_REQUIRED: 'Connect your Groq API key to continue.',
  INVALID_API_KEY: 'Groq rejected the API key.',
  MODEL_UNAVAILABLE: 'The selected model is unavailable or does not support this request.',
  RATE_LIMITED: 'Groq rate limit reached. Try again shortly.',
  NETWORK_ERROR: 'Could not reach Groq.',
  TIMEOUT: 'Groq did not answer in time.',
  INVALID_RESPONSE: 'Groq returned an answer that could not be formatted.',
  UNSUPPORTED_SITE: 'This page does not allow the extension.',
  NO_VOICE: 'Voice is not available on this device.',
  PERMISSION_DENIED: 'Permission was denied.',
  PDF_LOAD_ERROR: 'The PDF could not be loaded.',
  REQUEST_CANCELLED: 'The request was cancelled.',
  SELECTION_TOO_LONG: 'The selection is too long.',
};

/** Why an `INVALID_RESPONSE` happened. Diagnostic only; carries no model output. */
export type InvalidResponseStage = 'body' | 'empty' | 'truncated' | 'json' | 'schema';

/** Token accounting reported by Groq. Every field is optional because providers vary. */
export interface GroqUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
}

export interface GroqErrorInit {
  status?: number;
  retryAfterMs?: number;
  stage?: InvalidResponseStage;
  /** Provider `error.type` / `error.code` identifiers, sanitized to a short token charset. */
  providerErrorType?: string;
  providerErrorCode?: string;
  usage?: GroqUsage;
}

/**
 * Typed failure of a Groq call. The message is a fixed string per code, so it can
 * never contain the API key, selected text, headers or provider output.
 */
export class GroqError extends Error {
  readonly code: ErrorCode;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly stage: InvalidResponseStage | undefined;
  readonly providerErrorType: string | undefined;
  readonly providerErrorCode: string | undefined;
  readonly usage: GroqUsage | undefined;

  constructor(code: ErrorCode, init: GroqErrorInit = {}) {
    super(MESSAGES[code]);
    this.name = 'GroqError';
    this.code = code;
    this.status = init.status;
    this.retryAfterMs = init.retryAfterMs;
    this.stage = init.stage;
    this.providerErrorType = init.providerErrorType;
    this.providerErrorCode = init.providerErrorCode;
    this.usage = init.usage;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      code: this.code,
      message: this.message.slice(0, LIMITS.maxErrorMessageChars),
      ...(this.retryAfterMs !== undefined ? { retryAfterMs: this.retryAfterMs } : {}),
    };
  }
}

/**
 * Parse a `Retry-After` header: delta-seconds (integer or decimal) or an HTTP-date.
 * Returns milliseconds clamped to [0, one hour], or undefined when absent or unparseable.
 */
export function parseRetryAfter(
  header: string | null | undefined,
  nowMs: number,
): number | undefined {
  if (header === null || header === undefined) return undefined;
  const value = header.trim();
  if (value === '') return undefined;
  let ms: number;
  if (/^\d+(\.\d+)?$/.test(value)) {
    ms = Math.round(Number(value) * 1000);
  } else {
    // HTTP-dates always contain letters; this keeps Date.parse from reading "-5" as a year.
    if (!/[A-Za-z]/.test(value)) return undefined;
    const at = Date.parse(value);
    if (Number.isNaN(at)) return undefined;
    ms = at - nowMs;
  }
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

/** Map an HTTP status to an error code (architecture §6 table). */
export function codeForStatus(status: number): ErrorCode {
  if (status === 401 || status === 403) return 'INVALID_API_KEY';
  if (status === 404) return 'MODEL_UNAVAILABLE';
  if (status === 408) return 'TIMEOUT';
  if (status === 429) return 'RATE_LIMITED';
  // 400/422: invalid request or unsupported option/model. No dedicated code exists, and the
  // user remedy ("Choose another model") matches MODEL_UNAVAILABLE in requirements §7.
  if (status === 400 || status === 422) return 'MODEL_UNAVAILABLE';
  return 'NETWORK_ERROR';
}

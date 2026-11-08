import { browser } from 'wxt/browser';
import { LIMITS, MESSAGE_VERSION, TTS_RATES } from '../config/constants';
import type { ErrorCode, ErrorReason } from '../contracts/errors';
import type { SpeakResult } from '../contracts/speech';
import { describeError } from '../ui-client/errors';
import type { ClientResult } from '../ui-client/request';

/** The reader uses this small client so opening a PDF does not load runtime contract schemas. */
const REPLY_TIMEOUT_MS = 7_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$/;
const ERROR_CODES = new Set<ErrorCode>([
  'SETUP_REQUIRED',
  'INVALID_API_KEY',
  'MODEL_UNAVAILABLE',
  'RATE_LIMITED',
  'NETWORK_ERROR',
  'TIMEOUT',
  'INVALID_RESPONSE',
  'UNSUPPORTED_SITE',
  'NO_VOICE',
  'PERMISSION_DENIED',
  'PDF_LOAD_ERROR',
  'REQUEST_CANCELLED',
  'SELECTION_TOO_LONG',
  'INVALID_REQUEST',
  'STORAGE_UNAVAILABLE',
  'INTERNAL_ERROR',
]);
const ERROR_REASONS = new Set<ErrorReason>([
  'disclosure',
  'no-voice-linux',
  'no-voice-language',
  'start-failed',
  'online-only',
  'local-limit',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));
const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const isLanguage = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= LIMITS.maxLanguageTagChars && LANGUAGE.test(value);
const isOffset = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= LIMITS.maxSelectionChars;
const badReply = <T>(): ClientResult<T> => ({ ok: false, error: describeError('BAD_REPLY') });
const noResponse = <T>(): ClientResult<T> => ({ ok: false, error: describeError('NO_RESPONSE') });

async function send(message: Record<string, unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      browser.runtime.sendMessage({ v: MESSAGE_VERSION, ...message }),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), REPLY_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function failure(reply: Record<string, unknown>): ClientResult<never> | null {
  const error = reply['error'];
  if (!isRecord(error) || !hasOnly(error, ['code', 'message', 'retryAfterMs', 'reason']))
    return null;
  const code = error['code'];
  const reason = error['reason'];
  const retryAfterMs = error['retryAfterMs'];
  if (
    typeof code !== 'string' ||
    !ERROR_CODES.has(code as ErrorCode) ||
    typeof error['message'] !== 'string' ||
    error['message'].length > LIMITS.maxErrorMessageChars ||
    (reason !== undefined &&
      (typeof reason !== 'string' || !ERROR_REASONS.has(reason as ErrorReason))) ||
    (retryAfterMs !== undefined &&
      (typeof retryAfterMs !== 'number' ||
        !Number.isInteger(retryAfterMs) ||
        retryAfterMs < 0 ||
        retryAfterMs > 3_600_000))
  )
    return null;
  return {
    ok: false,
    error: describeError(
      code as ErrorCode,
      retryAfterMs as number | undefined,
      reason as ErrorReason | undefined,
    ),
  };
}

function envelope<T>(
  reply: unknown,
  parseData: (value: unknown) => T | null,
  requestId?: string,
): ClientResult<T> {
  if (reply === undefined || reply === null) return noResponse();
  if (!isRecord(reply) || !hasOnly(reply, ['ok', 'requestId', 'data', 'error'])) return badReply();
  if (requestId !== undefined) {
    if (reply['requestId'] !== requestId) return badReply();
  } else if (reply['requestId'] !== undefined && !isUuid(reply['requestId'])) return badReply();
  if (reply['ok'] === true) {
    if (!hasOnly(reply, ['ok', 'requestId', 'data'])) return badReply();
    const data = parseData(reply['data']);
    return data === null ? badReply() : { ok: true, data };
  }
  if (reply['ok'] !== false || !hasOnly(reply, ['ok', 'requestId', 'error'])) return badReply();
  return failure(reply) ?? badReply();
}

function parseSettings(value: unknown): { ttsRate: number; ttsLang?: string } | null {
  if (!isRecord(value)) return null;
  const rate = value['ttsRate'];
  const lang = value['ttsLang'];
  if (
    typeof rate !== 'number' ||
    !Number.isFinite(rate) ||
    rate < TTS_RATES.min ||
    rate > TTS_RATES.max ||
    (lang !== undefined && !isLanguage(lang))
  )
    return null;
  return { ttsRate: rate, ...(lang === undefined ? {} : { ttsLang: lang as string }) };
}

function parseSpeakResult(value: unknown): SpeakResult | null {
  if (!isRecord(value) || !hasOnly(value, ['state', 'engine', 'voiceName', 'lang', 'remote']))
    return null;
  const { state, engine, voiceName, lang, remote } = value;
  if (
    state !== 'started' ||
    (engine !== 'chrome-tts' && engine !== 'offscreen-web-speech') ||
    typeof remote !== 'boolean' ||
    (voiceName !== undefined &&
      (typeof voiceName !== 'string' || voiceName.length < 1 || voiceName.length > 128)) ||
    (lang !== undefined && !isLanguage(lang))
  )
    return null;
  return {
    state,
    engine,
    remote,
    ...(voiceName === undefined ? {} : { voiceName: voiceName as string }),
    ...(lang === undefined ? {} : { lang: lang as string }),
  };
}

export const readerSpeech = {
  async getPublicSettings(): Promise<ClientResult<{ ttsRate: number; ttsLang?: string }>> {
    return envelope(await send({ type: 'GET_PUBLIC_SETTINGS' }), parseSettings);
  },

  async speak(input: {
    requestId: string;
    text: string;
    rate: number;
    lang?: string;
    trackWords: true;
  }): Promise<ClientResult<SpeakResult>> {
    if (
      !isUuid(input.requestId) ||
      typeof input.text !== 'string' ||
      input.text.trim().length === 0 ||
      typeof input.rate !== 'number' ||
      !Number.isFinite(input.rate) ||
      input.rate < TTS_RATES.min ||
      input.rate > TTS_RATES.max ||
      (input.lang !== undefined && !isLanguage(input.lang)) ||
      input.trackWords !== true
    ) {
      return { ok: false, error: describeError('INVALID_REQUEST') };
    }
    if (input.text.trim().length > LIMITS.maxSelectionChars)
      return { ok: false, error: describeError('SELECTION_TOO_LONG') };
    return envelope(await send({ type: 'TTS_SPEAK', ...input }), parseSpeakResult, input.requestId);
  },

  /** Best effort cancellation; an absent worker or failed stop never throws into the reader. */
  async stopSpeaking(requestId: string): Promise<unknown> {
    if (!isUuid(requestId)) return undefined;
    return send({ type: 'TTS_STOP', requestId });
  },
} as const;

export type ReaderSpeechEvent =
  | { type: 'TTS_BOUNDARY'; requestId: string; charIndex: number; length?: number }
  | { type: 'TTS_EVENT'; requestId: string; state: 'ended' | 'cancelled' | 'error' };

/** Parse only the two speech pushes; the caller also verifies the background sender and request. */
export function parseReaderSpeechEvent(message: unknown): ReaderSpeechEvent | null {
  if (!isRecord(message) || message['v'] !== MESSAGE_VERSION || !isUuid(message['requestId']))
    return null;
  if (message['type'] === 'TTS_BOUNDARY') {
    if (
      !hasOnly(message, ['v', 'type', 'requestId', 'charIndex', 'length']) ||
      !isOffset(message['charIndex']) ||
      (message['length'] !== undefined && !isOffset(message['length']))
    )
      return null;
    return {
      type: 'TTS_BOUNDARY',
      requestId: message['requestId'],
      charIndex: message['charIndex'],
      ...(message['length'] === undefined ? {} : { length: message['length'] }),
    };
  }
  if (message['type'] === 'TTS_EVENT') {
    if (!hasOnly(message, ['v', 'type', 'requestId', 'state'])) return null;
    const state = message['state'];
    if (state !== 'ended' && state !== 'cancelled' && state !== 'error') return null;
    return { type: 'TTS_EVENT', requestId: message['requestId'], state };
  }
  return null;
}

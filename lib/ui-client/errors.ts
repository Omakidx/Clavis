import type { ErrorCode, ErrorReason } from '../contracts/errors';
import { t, type MessageKey } from '../i18n';

/**
 * What the user can do about an error. The UI turns this into a button:
 * `update-key` / `connect` open Settings at the key section, `open-settings` opens Settings,
 * `retry` repeats the action, `none` has no useful action.
 */
export type ErrorAction = 'retry' | 'update-key' | 'connect' | 'open-settings' | 'none';

/** Errors this client adds on top of the wire contract. */
export type ClientErrorCode = ErrorCode | 'NO_RESPONSE' | 'BAD_REPLY';

/**
 * A failure ready to show. `message` is ALWAYS our own localized text: the `message` field of a
 * reply envelope (which could echo provider text) is never displayed.
 */
export interface ClientError {
  code: ClientErrorCode;
  message: string;
  action: ErrorAction;
  retryAfterMs?: number;
  /** Extra, localized advice shown under `message` (for example how to install a voice). */
  hint?: string;
}

interface Mapping {
  key: MessageKey;
  action: ErrorAction;
}

const MAPPING = {
  SETUP_REQUIRED: { key: 'errSetupRequired', action: 'connect' },
  INVALID_API_KEY: { key: 'errInvalidApiKey', action: 'update-key' },
  MODEL_UNAVAILABLE: { key: 'errModelUnavailable', action: 'open-settings' },
  RATE_LIMITED: { key: 'errRateLimited', action: 'retry' },
  NETWORK_ERROR: { key: 'errNetwork', action: 'retry' },
  TIMEOUT: { key: 'errTimeout', action: 'retry' },
  INVALID_RESPONSE: { key: 'errInvalidResponse', action: 'retry' },
  UNSUPPORTED_SITE: { key: 'errUnsupportedSite', action: 'none' },
  NO_VOICE: { key: 'speechNoVoice', action: 'none' },
  PERMISSION_DENIED: { key: 'errPermission', action: 'open-settings' },
  PDF_LOAD_ERROR: { key: 'errGeneric', action: 'none' },
  REQUEST_CANCELLED: { key: 'errCancelled', action: 'none' },
  SELECTION_TOO_LONG: { key: 'errSelectionTooLong', action: 'none' },
  INVALID_REQUEST: { key: 'errInvalidRequest', action: 'none' },
  STORAGE_UNAVAILABLE: { key: 'errStorage', action: 'retry' },
  INTERNAL_ERROR: { key: 'errGeneric', action: 'retry' },
  NO_RESPONSE: { key: 'errNoResponse', action: 'retry' },
  BAD_REPLY: { key: 'errInvalidResponse', action: 'retry' },
} as const satisfies Record<ClientErrorCode, Mapping>;

/** Map a code (and an optional provider retry delay) to localized, actionable text. */
export function describeError(
  code: ClientErrorCode,
  retryAfterMs?: number,
  reason?: ErrorReason,
): ClientError {
  const voice = code === 'NO_VOICE' ? noVoice(reason) : undefined;
  const mapping: Mapping = voice?.mapping ??
    MAPPING[code] ?? { key: 'errGeneric', action: 'retry' };
  const seconds = retryAfterMs === undefined ? 0 : Math.ceil(retryAfterMs / 1000);
  // Clavis's own throttle says so; Groq's 429 keeps the provider wording.
  const own = code === 'RATE_LIMITED' && reason === 'local-limit';
  const message =
    code === 'RATE_LIMITED' && seconds > 0
      ? t(own ? 'errRateLimitedLocalSeconds' : 'errRateLimitedSeconds', String(seconds))
      : t(own ? 'errRateLimitedLocal' : mapping.key);
  return {
    code,
    message,
    action: mapping.action,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(voice?.hint === undefined ? {} : { hint: t(voice.hint) }),
  };
}

/**
 * NO_VOICE means different things, told apart by `reason` (an unknown or missing one gets the
 * generic copy): no engine on Linux, no voice at all, no voice for the language, or a voice that
 * did not start. Only the first two suggest installing something.
 */
function noVoice(reason: ErrorReason | undefined): { mapping: Mapping; hint?: MessageKey } {
  if (reason === 'start-failed') return { mapping: { key: 'speechStartFailed', action: 'retry' } };
  if (reason === 'no-voice-language') {
    return { mapping: { key: 'speechNoVoiceForLanguage', action: 'none' } };
  }
  if (reason === 'online-only') return { mapping: { key: 'speechOnlineOnly', action: 'none' } };
  return {
    mapping: { key: 'speechNoVoice', action: 'none' },
    hint: reason === 'no-voice-linux' ? 'speechNoVoiceLinuxHint' : 'speechNoVoiceHint',
  };
}

import type { ErrorCode } from '../contracts/errors';
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
export function describeError(code: ClientErrorCode, retryAfterMs?: number): ClientError {
  const mapping: Mapping = MAPPING[code] ?? { key: 'errGeneric', action: 'retry' };
  const seconds = retryAfterMs === undefined ? 0 : Math.ceil(retryAfterMs / 1000);
  const message =
    code === 'RATE_LIMITED' && seconds > 0
      ? t('errRateLimitedSeconds', String(seconds))
      : t(mapping.key);
  return {
    code,
    message,
    action: mapping.action,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

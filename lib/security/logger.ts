/**
 * Metadata-only diagnostics logger (FR-073).
 *
 * Selected text, context, model output, keys and URLs must never be logged.
 * This logger enforces that structurally: only a fixed allowlist of metadata
 * fields is accepted, values are primitives, and every string is truncated.
 * Uses console.warn / console.error only (console.log is lint-forbidden).
 */

/** Fixed allowlist of loggable metadata fields. */
export const LOG_METADATA_FIELDS = [
  'requestId',
  'mode',
  'status',
  'durationMs',
  'errorCode',
] as const;
export type LogMetadataField = (typeof LOG_METADATA_FIELDS)[number];

export type LogMetadata = Partial<Record<LogMetadataField, string | number | undefined>>;

/** Longest string (including the truncation marker) that is ever emitted. */
export const MAX_LOG_STRING_CHARS = 64;

const TRUNCATION_MARKER = '…';
const EVENT_PATTERN = /^[A-Za-z0-9_.:-]{1,48}$/;
const INVALID_EVENT = 'invalid_event';

// eslint-disable-next-line no-control-regex -- strip control characters to prevent log injection
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

function sanitizeString(value: string): string {
  const clean = value.replace(CONTROL_CHARS, ' ');
  return clean.length > MAX_LOG_STRING_CHARS
    ? clean.slice(0, MAX_LOG_STRING_CHARS - TRUNCATION_MARKER.length) + TRUNCATION_MARKER
    : clean;
}

/**
 * Reduce arbitrary input to allowlisted, primitive, bounded metadata.
 * Non-allowlisted keys, non-finite numbers and non-primitive values are dropped.
 */
export function sanitizeMetadata(meta: unknown): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  if (typeof meta !== 'object' || meta === null) return out;
  const source = meta as Record<string, unknown>;
  for (const field of LOG_METADATA_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const value = source[field];
    if (typeof value === 'string') out[field] = sanitizeString(value);
    else if (typeof value === 'number' && Number.isFinite(value)) out[field] = value;
  }
  return out;
}

function sanitizeEvent(event: string): string {
  return typeof event === 'string' && EVENT_PATTERN.test(event) ? event : INVALID_EVENT;
}

function isDevBuild(): boolean {
  return import.meta.env.DEV === true;
}

function format(event: string): string {
  return `[clavis] ${sanitizeEvent(event)}`;
}

export const logger = {
  /** Development builds only; a no-op in production. Emitted via console.warn. */
  debug(event: string, meta?: LogMetadata): void {
    if (!isDevBuild()) return;
    console.warn(format(event), sanitizeMetadata(meta));
  },
  /** Always emitted, including production. */
  warn(event: string, meta?: LogMetadata): void {
    console.warn(format(event), sanitizeMetadata(meta));
  },
  /** Always emitted, including production. */
  error(event: string, meta?: LogMetadata): void {
    console.error(format(event), sanitizeMetadata(meta));
  },
} as const;

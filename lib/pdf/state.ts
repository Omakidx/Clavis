import { MAX_PDF_BYTES, MAX_PDF_PAGES } from './limits';

/** Error codes the reader can show (docs/architecture.md section 8, requirements section 7). */
export type ReaderErrorCode = 'CORRUPT' | 'PERMISSION' | 'TOO_LARGE' | 'UNSUPPORTED';

/**
 * Reader state model (docs/architecture.md section 8).
 *
 * Two additions to the normative shape, proposed for the architecture doc:
 * - `password-required.incorrect` is true after a wrong password, so the prompt can say so.
 * - `error.message` is a short English diagnostic for logs/tests; the UI renders text by `code`.
 * - `error.limit` says whether a TOO_LARGE error is about bytes or pages.
 */
export type ReaderState =
  | { phase: 'empty' }
  | { phase: 'loading'; name: string }
  | { phase: 'ready'; name: string; pageCount: number; page: number; zoom: number }
  | { phase: 'password-required'; name: string; incorrect?: boolean }
  | { phase: 'image-only'; name: string; pageCount: number }
  | {
      phase: 'error';
      code: ReaderErrorCode;
      message: string;
      /** For TOO_LARGE: which limit was exceeded, so the UI can name it. */
      limit?: 'bytes' | 'pages';
    };

export const EMPTY_STATE: ReaderState = { phase: 'empty' };

/** Fixed, content-free diagnostics. Never include file names, bytes or raw PDF.js messages. */
const DIAGNOSTIC: Record<ReaderErrorCode, string> = {
  CORRUPT: 'The file is damaged or is not a valid PDF structure.',
  PERMISSION: 'The browser could not read the selected file.',
  TOO_LARGE: 'The file exceeds a reader size limit.',
  UNSUPPORTED: 'The file or one of its features is not supported.',
};

export function errorState(
  code: ReaderErrorCode,
  detail?: string,
  limit?: 'bytes' | 'pages',
): ReaderState {
  const message = detail ? `${DIAGNOSTIC[code]} (${detail})` : DIAGNOSTIC[code];
  return limit === undefined
    ? { phase: 'error', code, message }
    : { phase: 'error', code, message, limit };
}

/** Names PDF.js gives to the errors it throws or rejects with (matched by name across the worker boundary). */
const CORRUPT_NAMES = new Set([
  'InvalidPDFException',
  'MissingPDFException',
  'FormatError',
  'XRefParseException',
  'ParserEOFException',
]);
const PERMISSION_NAMES = new Set(['NotReadableError', 'NotAllowedError', 'SecurityError']);

function errorName(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return 'Error';
}

/**
 * Map a failure while reading or loading a PDF to a ReaderState.
 * Returns null for cancellations (AbortException): a newer open or a close superseded the load,
 * so nothing must be shown. A PasswordException that reaches here (the prompt was dismissed or
 * the loader gave up) maps to password-required.
 */
export function mapLoadError(error: unknown, fileName = ''): ReaderState | null {
  const name = errorName(error);
  if (name === 'AbortException') return null;
  if (name === 'PasswordException') return { phase: 'password-required', name: fileName };
  if (CORRUPT_NAMES.has(name)) return errorState('CORRUPT', name);
  if (PERMISSION_NAMES.has(name)) return errorState('PERMISSION', name);
  // Allocation failures while buffering or parsing a very large file.
  if (name === 'RangeError') return errorState('TOO_LARGE', name);
  return errorState('UNSUPPORTED', name);
}

export interface FileLike {
  name: string;
  size: number;
  type: string;
}

/** Cheap checks done before any bytes are read. Returns an error state, or null when acceptable. */
export function validateFileMeta(
  file: FileLike,
  maxBytes: number = MAX_PDF_BYTES,
): ReaderState | null {
  if (file.size > maxBytes) {
    return errorState('TOO_LARGE', `${file.size} > ${maxBytes} bytes`, 'bytes');
  }
  if (file.size === 0) return errorState('CORRUPT', 'empty file');
  return null;
}

/** Page-count cap, checked right after the document loads and before the viewer builds any page. */
export function validatePageCount(
  pageCount: number,
  maxPages: number = MAX_PDF_PAGES,
): ReaderState | null {
  if (pageCount > maxPages) {
    return errorState('TOO_LARGE', `${pageCount} > ${maxPages} pages`, 'pages');
  }
  return null;
}

/** `%PDF-` must appear within the first 1024 bytes (ISO 32000-1, Annex H). */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 1024) - 4;
  for (let i = 0; i < limit; i++) {
    if (
      bytes[i] === 0x25 &&
      bytes[i + 1] === 0x50 &&
      bytes[i + 2] === 0x44 &&
      bytes[i + 3] === 0x46 &&
      bytes[i + 4] === 0x2d
    ) {
      return true;
    }
  }
  return false;
}

/** State used when the bytes do not look like a PDF at all (for example a renamed text file). */
export function notAPdfState(): ReaderState {
  return errorState('UNSUPPORTED', 'not a PDF file');
}

export function clampPage(page: number, pageCount: number): number {
  if (!Number.isFinite(page)) return 1;
  return Math.min(Math.max(Math.trunc(page), 1), Math.max(pageCount, 1));
}

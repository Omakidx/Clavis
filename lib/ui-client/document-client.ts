import { browser } from 'wxt/browser';
import { MESSAGE_VERSION } from '../config/constants';
import { describeError, type ClientError, type ClientErrorCode } from './errors';

/**
 * The reader's and the library's client for the PDF file routes (docs/clavis-sync-design.md 6.6,
 * 7.4). Hand-written and zod-free like lib/data/kick.ts, so the reader's first-load chunks do not
 * pull in the contract schemas. The pages never call the API (rule R2): a file travels through the
 * `fileHandoff` store and these messages only name it by fingerprint.
 *
 * Nothing here is retried: an upload or download that was cut off (the worker restarted) is for
 * the user to repeat, and a repeat of a finished upload is refused by the server by itself.
 */

export type DocumentResult<T> = { ok: true; data: T } | { ok: false; error: ClientError };

export interface StoredStatus {
  state: 'none' | 'stored';
  bytes: number | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function call(message: Record<string, unknown>): Promise<DocumentResult<unknown>> {
  let reply: unknown;
  try {
    reply = await browser.runtime.sendMessage({ v: MESSAGE_VERSION, ...message });
  } catch {
    return { ok: false, error: describeError('NO_RESPONSE') };
  }
  if (!isRecord(reply)) return { ok: false, error: describeError('NO_RESPONSE') };
  if (reply['ok'] === true) return { ok: true, data: reply['data'] };
  const error = reply['error'];
  const code = isRecord(error) && typeof error['code'] === 'string' ? error['code'] : 'BAD_REPLY';
  // An unknown code gets the generic text; the reply's own message is never shown.
  return { ok: false, error: describeError(code as ClientErrorCode) };
}

function storedStatus(data: unknown): StoredStatus | null {
  if (!isRecord(data) || !isRecord(data['storage'])) return null;
  const { state, bytes } = data['storage'];
  if (state !== 'none' && state !== 'stored') return null;
  return { state, bytes: typeof bytes === 'number' ? bytes : null };
}

export const documentClient = {
  /** The file must be in `fileHandoff[fingerprint]` (direction upload) before this is called. */
  async upload(fingerprint: string, title: string): Promise<DocumentResult<StoredStatus>> {
    const result = await call({ type: 'DOCUMENT_UPLOAD', fingerprint, title });
    if (!result.ok) return result;
    const storage = storedStatus(result.data);
    return storage === null
      ? { ok: false, error: describeError('BAD_REPLY') }
      : { ok: true, data: storage };
  },
  /** Afterwards the file is in `fileHandoff[fingerprint]` (direction download). */
  async fetchFile(fingerprint: string): Promise<DocumentResult<null>> {
    const result = await call({ type: 'DOCUMENT_FETCH', fingerprint });
    return result.ok ? { ok: true, data: null } : result;
  },
  async removeFile(fingerprint: string): Promise<DocumentResult<null>> {
    const result = await call({ type: 'DOCUMENT_REMOVE_FILE', fingerprint });
    return result.ok ? { ok: true, data: null } : result;
  },
} as const;

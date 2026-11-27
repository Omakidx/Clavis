import { FileUploadResponse } from '../../../shared/api-contract/endpoints';
import { ApiRequestError } from '../../account/api';
import { NotSignedInError, SessionLostError, StorageLockedError } from '../../account/tokens';
import type { TokenClient } from '../../account/tokens';
import { LIMITS } from '../../../shared/api-contract/limits';
import type { ErrorCode, MessageReply } from '../../contracts';
import type { DocumentStorageView } from '../../contracts/documents';
import { setStorageState } from '../../data/documents';
import { dropHandoff, putHandoff, sweepStaleHandoffs, takeHandoff } from '../../data/handoff';
import { isSignedIn } from '../../data/sync-flag';
import { failure, success } from '../replies';

/**
 * DOCUMENT_UPLOAD, DOCUMENT_FETCH and DOCUMENT_REMOVE_FILE (docs/clavis-sync-design.md 6.6, 7.4).
 * The only place a PDF crosses to or from the Clavis API (rule R2): the reader leaves the file in
 * the `fileHandoff` store and this handler streams it, or fetches a stored one and leaves it
 * there for the reader. The handoff entry never outlives the transfer. Replies carry codes and
 * sizes, never a token, a URL or file bytes.
 */

export interface DocumentHandlerDeps {
  tokens: Pick<TokenClient, 'request' | 'requestBlob'>;
  /** `FEATURES.accountSync`: false means nothing here ever touches the network. */
  enabled: boolean;
  signedIn?: () => Promise<boolean>;
  /** Wake the sync engine after a local change (a pull learns the server's view of the document). */
  onLocalChange?: () => void;
  /** The account's stored bytes changed (an upload or a removal): refresh the usage shown. */
  onStorageChanged?: () => void;
  maxFileBytes?: number;
  take?: typeof takeHandoff;
  put?: typeof putHandoff;
  drop?: typeof dropHandoff;
  sweep?: typeof sweepStaleHandoffs;
  markStorage?: typeof setStorageState;
}

/** Longest a whole upload or download may take (a 15 MiB file on a slow link). */
const TRANSFER_TIMEOUT_MS = 120_000;

/** The server refuses a title header longer than this many encoded characters. */
export const MAX_TITLE_HEADER_CHARS = 1800;

/**
 * `X-Clavis-Title` for `title`: well-formed UTF-16 (a lone surrogate would make encodeURIComponent
 * throw), percent-encoded, cut by whole code points until it fits. No header when nothing is left.
 */
export function titleHeaders(title: string): Record<string, string> {
  const points = [...title.toWellFormed()];
  let encoded = encodeURIComponent(points.join(''));
  while (encoded.length > MAX_TITLE_HEADER_CHARS && points.length > 0) {
    points.pop();
    encoded = encodeURIComponent(points.join(''));
  }
  return encoded === '' ? {} : { 'X-Clavis-Title': encoded };
}

/** The server's code for what went wrong, as the extension's own error code (replies never carry more). */
export function documentErrorCode(error: unknown): ErrorCode {
  if (error instanceof ApiRequestError) {
    switch (error.code) {
      case 'QUOTA_EXCEEDED':
      case 'FILE_TOO_LARGE':
      case 'NOT_A_PDF':
      case 'FINGERPRINT_MISMATCH':
      case 'UPLOAD_IN_PROGRESS':
      case 'NOT_FOUND':
      case 'RATE_LIMITED':
      case 'LIMIT_EXCEEDED':
        return error.code;
      case 'CONFLICT':
        // The upload reservation expired mid-transfer: worth repeating.
        return 'UPLOAD_IN_PROGRESS';
      case 'PAYLOAD_TOO_LARGE':
        return 'FILE_TOO_LARGE';
      case 'UNSUPPORTED_MEDIA_TYPE':
        return 'NOT_A_PDF';
      case 'UNAUTHENTICATED':
      case 'TOKEN_EXPIRED':
      case 'TOKEN_REUSED':
      case 'SESSION_REVOKED':
        return 'NOT_SIGNED_IN';
      default:
        return error.transient ? 'NETWORK_ERROR' : 'INTERNAL_ERROR';
    }
  }
  if (error instanceof NotSignedInError || error instanceof SessionLostError) {
    return 'NOT_SIGNED_IN';
  }
  if (error instanceof StorageLockedError) return 'STORAGE_UNAVAILABLE';
  return 'INTERNAL_ERROR';
}

export function createDocumentHandlers(deps: DocumentHandlerDeps) {
  const maxFileBytes = deps.maxFileBytes ?? LIMITS.maxFileBytes;
  const signedIn = deps.signedIn ?? isSignedIn;
  const take = deps.take ?? takeHandoff;
  const put = deps.put ?? putHandoff;
  const drop = deps.drop ?? dropHandoff;
  const markStorage = deps.markStorage ?? setStorageState;
  const sweep = deps.sweep ?? sweepStaleHandoffs;
  const uploading = new Set<string>();
  /** A file must not wait in the handoff store: every handler clears what is stale first. */
  const sweepFirst = (): Promise<unknown> => sweep().catch(() => 0);

  const ready = async (): Promise<boolean> => deps.enabled && (await signedIn());
  const filePath = (fingerprint: string): string => `/v1/documents/${fingerprint}/file`;

  return {
    async upload(payload: {
      fingerprint: string;
      title: string;
    }): Promise<MessageReply<{ storage: DocumentStorageView }>> {
      const { fingerprint, title } = payload;
      // Another upload of this file owns the handoff entry: leave it alone.
      if (uploading.has(fingerprint)) return failure('UPLOAD_IN_PROGRESS');
      uploading.add(fingerprint);
      await sweepFirst();
      try {
        // Read and delete the entry first, whatever happens next: the bytes never wait here.
        let blob: Blob | null;
        try {
          blob = await take(fingerprint, 'upload');
        } catch {
          return failure('INTERNAL_ERROR');
        }
        if (!(await ready())) return failure('NOT_SIGNED_IN');
        if (blob === null) return failure('NOT_FOUND');
        if (blob.size > maxFileBytes) return failure('FILE_TOO_LARGE');
        if (blob.size === 0) return failure('NOT_A_PDF');
        try {
          const { document } = await deps.tokens.request({
            method: 'PUT',
            path: filePath(fingerprint),
            blob: new Blob([blob], { type: 'application/pdf' }),
            headers: titleHeaders(title),
            response: FileUploadResponse,
            timeoutMs: TRANSFER_TIMEOUT_MS,
          });
          if (document.fingerprint !== fingerprint) return failure('INTERNAL_ERROR');
          await markStorage(fingerprint, document.storage.state).catch(() => false);
          deps.onLocalChange?.();
          deps.onStorageChanged?.();
          return success({
            storage: { state: document.storage.state, bytes: document.storage.bytes },
          });
        } catch (error) {
          return failure(documentErrorCode(error));
        }
      } finally {
        uploading.delete(fingerprint);
        await drop(fingerprint, 'upload');
      }
    },

    async fetchFile(payload: {
      fingerprint: string;
    }): Promise<MessageReply<Record<string, never>>> {
      const { fingerprint } = payload;
      await sweepFirst();
      if (!(await ready())) return failure('NOT_SIGNED_IN');
      try {
        const blob = await deps.tokens.requestBlob({
          method: 'GET',
          path: filePath(fingerprint),
          maxBytes: maxFileBytes,
          timeoutMs: TRANSFER_TIMEOUT_MS,
        });
        if (blob.size === 0) return failure('NOT_FOUND');
        // An upload of this file owns the entry right now: do not overwrite it.
        if (!(await put(fingerprint, blob, 'download'))) return failure('UPLOAD_IN_PROGRESS');
        return success({});
      } catch (error) {
        return failure(documentErrorCode(error));
      }
    },

    async removeFile(payload: {
      fingerprint: string;
    }): Promise<MessageReply<Record<string, never>>> {
      const { fingerprint } = payload;
      await sweepFirst();
      if (!(await ready())) return failure('NOT_SIGNED_IN');
      try {
        await deps.tokens.request({ method: 'DELETE', path: filePath(fingerprint) });
      } catch (error) {
        // A file that is already gone is the state the user asked for.
        if (documentErrorCode(error) !== 'NOT_FOUND') return failure(documentErrorCode(error));
      }
      await markStorage(fingerprint, 'none').catch(() => false);
      deps.onLocalChange?.();
      deps.onStorageChanged?.();
      return success({});
    },
  };
}

export type DocumentHandlers = ReturnType<typeof createDocumentHandlers>;

import { z } from 'zod';
import { MESSAGE_VERSION } from '../config/constants';
import { Hex64, Text } from '../../shared/api-contract/primitives';
import { parseMessage, type MessageParseResult } from './messages';

/**
 * PDF files in the account (docs/clavis-sync-design.md 6.6, 7.4). Strict, versioned. The PDF
 * bytes are never in a message: they cross between a page and the background through the
 * `fileHandoff` store of IndexedDB. Who may send what is the route table's job
 * (lib/router/routes.ts); these only validate shape.
 */

const v = z.literal(MESSAGE_VERSION);

/** Reader → background: upload the file in `fileHandoff[fingerprint]` (direction upload). */
export const documentUploadMessageSchema = z.strictObject({
  v,
  type: z.literal('DOCUMENT_UPLOAD'),
  fingerprint: Hex64,
  title: Text(300),
});

/** Reader → background: download the stored file into `fileHandoff[fingerprint]` (direction download). */
export const documentFetchMessageSchema = z.strictObject({
  v,
  type: z.literal('DOCUMENT_FETCH'),
  fingerprint: Hex64,
});

/** Reader or library → background: delete the stored file; progress and highlights stay. */
export const documentRemoveFileMessageSchema = z.strictObject({
  v,
  type: z.literal('DOCUMENT_REMOVE_FILE'),
  fingerprint: Hex64,
});

export const documentMessageSchema = z.discriminatedUnion('type', [
  documentUploadMessageSchema,
  documentFetchMessageSchema,
  documentRemoveFileMessageSchema,
]);
export type DocumentMessage = z.infer<typeof documentMessageSchema>;

export function parseDocumentMessage(input: unknown): MessageParseResult<DocumentMessage> {
  return parseMessage(documentMessageSchema, input);
}

// ---------------------------------------------------------------------------
// Reply data
// ---------------------------------------------------------------------------

export const documentStorageSchema = z.strictObject({
  state: z.enum(['none', 'stored']),
  bytes: z.number().int().nonnegative().nullable(),
});
export type DocumentStorageView = z.infer<typeof documentStorageSchema>;

export const documentUploadResultSchema = z.strictObject({ storage: documentStorageSchema });
export const documentFetchResultSchema = z.strictObject({});
export const documentRemoveFileResultSchema = z.strictObject({});

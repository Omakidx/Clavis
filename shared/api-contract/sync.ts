import { z } from 'zod';
import { LIMITS } from './limits';
import { ChatData, DocumentData, DocumentStorage, HighlightData, WordData } from './records';
import { EpochMs, Hex64, Seq, Uuid } from './primitives';

// §5.3. The design's `${kind}:${op}` discrimination is implemented as nested discriminated
// unions (kind, then op), so every variant keeps strict key checking.

export const PushChange = z.discriminatedUnion('kind', [
  z.discriminatedUnion('op', [
    z.strictObject({
      kind: z.literal('word'),
      op: z.literal('upsert'),
      key: Hex64,
      clientModifiedAt: EpochMs,
      data: WordData,
    }),
    z.strictObject({
      kind: z.literal('word'),
      op: z.literal('delete'),
      key: Hex64,
      clientModifiedAt: EpochMs,
    }),
  ]),
  z.strictObject({ kind: z.literal('chat'), op: z.literal('insert'), id: Uuid, data: ChatData }),
  z.discriminatedUnion('op', [
    z.strictObject({
      kind: z.literal('document'),
      op: z.literal('upsert'),
      key: Hex64,
      clientModifiedAt: EpochMs,
      data: DocumentData,
    }),
    z.strictObject({
      kind: z.literal('document'),
      op: z.literal('delete'),
      key: Hex64,
      clientModifiedAt: EpochMs,
    }),
  ]),
  z.discriminatedUnion('op', [
    z.strictObject({
      kind: z.literal('highlight'),
      op: z.literal('upsert'),
      id: Uuid,
      clientModifiedAt: EpochMs,
      data: HighlightData,
    }),
    z.strictObject({
      kind: z.literal('highlight'),
      op: z.literal('delete'),
      id: Uuid,
      fingerprint: Hex64,
      clientModifiedAt: EpochMs,
    }),
  ]),
]);
export type PushChange = z.infer<typeof PushChange>;

export const PushRequest = z.strictObject({
  changes: z.array(PushChange).min(1).max(LIMITS.maxPushChanges),
});
export type PushRequest = z.infer<typeof PushRequest>;

export const ServerChange = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('word'),
    key: Hex64,
    seq: Seq,
    deleted: z.boolean(),
    clientModifiedAt: EpochMs,
    data: WordData.nullable(),
  }),
  z.strictObject({ kind: z.literal('chat'), id: Uuid, seq: Seq, data: ChatData }),
  z.strictObject({
    kind: z.literal('document'),
    key: Hex64,
    seq: Seq,
    deleted: z.boolean(),
    clientModifiedAt: EpochMs,
    data: DocumentData.nullable(),
    storage: DocumentStorage,
  }),
  z.strictObject({
    kind: z.literal('highlight'),
    id: Uuid,
    seq: Seq,
    deleted: z.boolean(),
    clientModifiedAt: EpochMs,
    fingerprint: Hex64,
    data: HighlightData.nullable(),
  }),
]);
export type ServerChange = z.infer<typeof ServerChange>;

export const PushResult = z.strictObject({
  index: z.number().int().nonnegative(),
  status: z.enum(['applied', 'stale', 'rejected']),
  /** applied */
  seq: Seq.optional(),
  /** stale: the server's current record */
  current: ServerChange.optional(),
  /** rejected */
  code: z.enum(['LIMIT_EXCEEDED', 'VALIDATION_FAILED', 'NOT_FOUND', 'CONFLICT']).optional(),
});
export type PushResult = z.infer<typeof PushResult>;

export const PushResponse = z.strictObject({
  results: z.array(PushResult).max(LIMITS.maxPushChanges),
  serverTime: EpochMs,
});
export type PushResponse = z.infer<typeof PushResponse>;

export const PullQuery = z.strictObject({
  cursor: Seq.default('0'),
  limit: z.coerce.number().int().min(1).max(LIMITS.maxPullLimit).default(LIMITS.defaultPullLimit),
});
export type PullQuery = z.infer<typeof PullQuery>;

export const PullResponse = z.strictObject({
  changes: z.array(ServerChange).max(LIMITS.maxPullLimit),
  nextCursor: Seq,
  hasMore: z.boolean(),
});
export type PullResponse = z.infer<typeof PullResponse>;

export const IdempotencyKeyHeader = Uuid;

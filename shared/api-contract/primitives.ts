import { z } from 'zod';

export const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
export const Uuid = z.uuid();
/** Milliseconds since the epoch, no earlier than 2020-01-01. */
export const EpochMs = z.number().int().min(1_577_836_800_000);
/** A bigint sequence number carried as a decimal string. */
export const Seq = z.string().regex(/^\d{1,19}$/);
/** Plain text only; UIs render it as text nodes (D-10). */
export const Text = (max: number) => z.string().max(max);

/** Opaque keyset pagination cursor (base64url). */
export const PageCursor = z.string().regex(/^[A-Za-z0-9_-]{1,512}$/);

export const pageQuery = {
  cursor: PageCursor.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

export type Hex64 = z.infer<typeof Hex64>;
export type EpochMs = z.infer<typeof EpochMs>;
export type Seq = z.infer<typeof Seq>;

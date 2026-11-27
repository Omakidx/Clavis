// Opaque keyset cursors (docs/clavis-sync-design.md §5.4): base64url of JSON `[sortKey, id]`.
import { Hex64 } from '../../../shared/api-contract';
import { ApiException } from './errors';

/** End of year 9999: the largest value a Date (and Postgres timestamptz) round-trips. */
const MAX_EPOCH_MS = 253_402_300_799_999;

export function encodeCursor(sortKey: number, id: string): string {
  return Buffer.from(JSON.stringify([sortKey, id])).toString('base64url');
}

export function decodeCursor(raw: string): { sortKey: number; id: string } {
  const bad = () =>
    new ApiException('VALIDATION_FAILED', 'Invalid cursor', { details: { field: 'cursor' } });
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      Number.isSafeInteger(v[0]) &&
      (v[0] as number) >= 0 &&
      (v[0] as number) <= MAX_EPOCH_MS &&
      Hex64.safeParse(v[1]).success
    ) {
      return { sortKey: v[0] as number, id: v[1] as string };
    }
  } catch {
    /* fall through */
  }
  throw bad();
}

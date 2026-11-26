// POST /v1/sync/push core (docs/clavis-sync-design.md §4.3). One transaction per request:
//   lock the user row -> idempotency lookup -> apply each change in order -> store the response -> commit seq.
// An item failure is an item result; an unexpected error (anything but a data/check violation of that one item)
// aborts the whole transaction and surfaces as 5xx, so a retry with the same Idempotency-Key starts clean.
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { PushChange, type PushResponse, type PushResult } from '../../../shared/api-contract';
import type { Database } from '../db/client';
import { commitSeq, lockUserForSeq } from '../db/queries';
import { idempotencyKeys } from '../db/schema';
import { ApiException } from '../http/errors';
import { applyChange, createResettableSeq, type Outcome } from './apply';

/** JSON with object keys sorted, so the same logical body always hashes the same. */
export const MAX_JSON_DEPTH = 32;

export function canonicalJson(v: unknown, depth = 0): string {
  // Real requests nest about 6 levels; a hostile body nested ~200k deep would overflow the stack.
  if (depth > MAX_JSON_DEPTH) throw new RangeError('JSON nested too deeply');
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJson(x, depth + 1)).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k], depth + 1)}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

export const hashBody = (body: unknown): Buffer =>
  createHash('sha256').update(canonicalJson(body)).digest();

/** Postgres cannot store NUL in text/jsonb nor lone surrogates in jsonb: reject those items up front. */
function unstorable(v: unknown): boolean {
  if (typeof v === 'string')
    return v.includes('\u0000') || !(v as string & { isWellFormed(): boolean }).isWellFormed();
  if (Array.isArray(v)) return v.some(unstorable);
  if (v !== null && typeof v === 'object') return Object.values(v).some(unstorable);
  return false;
}

/** SQLSTATE of a failed statement (drizzle wraps the pg error as `cause`). */
function sqlState(err: unknown): string | undefined {
  const e = ((err as { cause?: unknown }).cause ?? err) as { code?: unknown };
  return typeof e.code === 'string' ? e.code : undefined;
}

/** Data exceptions (class 22), CHECK violations and unserialisable values describe one bad item, not a broken server. */
export const isItemDataError = (err: unknown): boolean => {
  const code = sqlState(err);
  if (code !== undefined) return code.startsWith('22') || code === '23514';
  // A value the driver cannot serialise (e.g. a Date outside the representable range) throws a JS RangeError
  // before any SQL runs. That is this item's fault; connection errors are not RangeErrors and still abort.
  const inner = (err as { cause?: unknown }).cause ?? err;
  return inner instanceof RangeError;
};

function toResult(index: number, o: Outcome): PushResult {
  switch (o.status) {
    case 'applied':
      return { index, status: 'applied', seq: o.seq.toString() };
    case 'stale':
      return { index, status: 'stale', current: o.current };
    case 'rejected':
      return { index, status: 'rejected', code: o.code };
  }
}

export interface PushArgs {
  userId: string;
  idempotencyKey: string;
  requestHash: Buffer;
  /** Raw (unvalidated) items: each is validated on its own so one bad item cannot sink the batch. */
  items: unknown[];
  nowMs: number;
  /** Operational warnings (never user content). */
  warn?: (msg: string) => void;
}

export async function pushChanges(db: Database, a: PushArgs): Promise<PushResponse> {
  return db.transaction(async (tx) => {
    const current = await lockUserForSeq(tx, a.userId);
    if (current === null) throw new ApiException('UNAUTHENTICATED', 'Account no longer exists');

    const [prior] = await tx
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.userId, a.userId), eq(idempotencyKeys.key, a.idempotencyKey)))
      .limit(1);
    if (prior) {
      if (!prior.requestHash.equals(a.requestHash)) {
        throw new ApiException(
          'IDEMPOTENCY_MISMATCH',
          'Idempotency-Key was used with another body',
        );
      }
      return prior.response as PushResponse;
    }

    const seq = createResettableSeq(current);
    const results: PushResult[] = [];
    for (const [index, raw] of a.items.entries()) {
      const parsed = PushChange.safeParse(raw);
      if (!parsed.success || unstorable(raw)) {
        results.push({ index, status: 'rejected', code: 'VALIDATION_FAILED' });
        continue;
      }
      const mark = seq.last();
      try {
        // A savepoint per item: a database-level rejection of one item rolls back only that item.
        const outcome = await tx.transaction((sp) =>
          applyChange({ tx: sp, userId: a.userId, seq, nowMs: a.nowMs, warn: a.warn }, parsed.data),
        );
        results.push(toResult(index, outcome));
        if (outcome.status !== 'applied') seq.reset(mark);
      } catch (err) {
        seq.reset(mark);
        if (!isItemDataError(err)) throw err;
        results.push({ index, status: 'rejected', code: 'VALIDATION_FAILED' });
      }
    }

    const response: PushResponse = { results, serverTime: a.nowMs };
    await tx.insert(idempotencyKeys).values({
      userId: a.userId,
      key: a.idempotencyKey,
      requestHash: a.requestHash,
      response,
    });
    await commitSeq(tx, a.userId, seq);
    return response;
  });
}

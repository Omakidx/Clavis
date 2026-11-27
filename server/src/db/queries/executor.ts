import type { Database } from '../client';

/** Anything that can run a statement: the pool-backed `db` or the `tx` inside `db.transaction(...)`. */
export type Executor = Pick<Database, 'execute'>;
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** pg returns bigint/count columns as strings; normalise to bigint. */
export function toBig(v: unknown): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' || typeof v === 'number') return BigInt(v);
  throw new TypeError('expected a bigint-compatible value');
}

import { and, eq, sql } from 'drizzle-orm';
import type { DocumentView } from '../../../shared/api-contract';
import type { Database } from '../db/client';
import { documents } from '../db/schema';
import { documentData, type DocumentRow } from '../sync/records';

// Drizzle renders columns unqualified in a single-table select, which would make the correlation
// `h.user_id = user_id` compare the subquery's own column (always true, counting across users): qualify them.
export const OUTER_USER = sql.raw('"documents"."user_id"');
export const OUTER_FP = sql.raw('"documents"."fingerprint"');

export function documentView(row: DocumentRow, highlightCount: number): DocumentView {
  return {
    ...documentData(row),
    fingerprint: row.fingerprint,
    clientModifiedAt: row.clientModifiedAt.getTime(),
    highlightCount,
    storage: {
      state: row.storageState === 'stored' ? 'stored' : 'none',
      bytes: row.storedBytes === null ? null : Number(row.storedBytes),
      storedAt: row.storedAt === null ? null : row.storedAt.getTime(),
    },
  };
}

/** The live document as a view (with its live highlight count), or undefined. */
export async function loadDocumentView(
  db: Database,
  userId: string,
  fingerprint: string,
): Promise<DocumentView | undefined> {
  const [r] = await db
    .select({
      row: documents,
      highlightCount: sql<number>`(SELECT count(*)::int FROM highlights h
        WHERE h.user_id = ${OUTER_USER} AND h.fingerprint = ${OUTER_FP}
          AND h.deleted_at IS NULL)`,
    })
    .from(documents)
    .where(
      and(
        eq(documents.userId, userId),
        eq(documents.fingerprint, fingerprint),
        sql`${documents.deletedAt} IS NULL`,
      ),
    );
  return r ? documentView(r.row, Number(r.highlightCount)) : undefined;
}

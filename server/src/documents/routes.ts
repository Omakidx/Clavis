// Document REST (docs/clavis-sync-design.md §5.4): list, detail, delete. `B|C`; scoped to the authenticated user.
// File upload/download/delete live in ./file-routes.ts. Deleting a document also removes its stored file (§6.4).
import { and, asc, desc, eq, gt, isNull, lt, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { Hex64, PageQuery, type HighlightView } from '../../../shared/api-contract';
import { requireBearerOrCookie } from '../auth/middleware';
import type { AuthRuntime } from '../auth/runtime';
import type { Database } from '../db/client';
import { commitSeq, lockUserForSeq } from '../db/queries';
import { documents, highlights } from '../db/schema';
import { ApiException, parseOrThrow } from '../http/errors';
import { decodeCursor, encodeCursor } from '../http/pagination';
import { enforce, perMinute } from '../http/rate-limit';
import type { AppEnv } from '../http/types';
import type { Logger } from '../logger';
import { createResettableSeq, getDocument, writeDocumentTombstone } from '../sync/apply';
import { highlightData } from '../sync/records';
import { deleteQueuedKeys } from '../storage/deletions';
import type { ObjectStorage } from '../storage/types';
import { OUTER_FP, OUTER_USER, documentView } from './view';

export function documentRoutes(
  rt: AuthRuntime,
  db: Database,
  logger: Logger,
  storage?: ObjectStorage | undefined,
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const auth = requireBearerOrCookie(rt);
  const prelude = (c: { get(k: 'auth'): { userId: string } | undefined }): string => {
    const a = c.get('auth');
    if (!a) throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    enforce(rt.limiter, `user:documents:${a.userId}`, perMinute(120));
    return a.userId;
  };
  const fpParam = (raw: string | undefined): string => {
    const k = Hex64.safeParse(raw);
    if (!k.success) throw new ApiException('NOT_FOUND', 'Not found');
    return k.data;
  };

  app.get('/v1/documents', auth, async (c) => {
    const uid = prelude(c);
    const q = parseOrThrow(PageQuery, c.req.query());
    const conds = [eq(documents.userId, uid), isNull(documents.deletedAt)];
    if (q.cursor) {
      const at = decodeCursor(q.cursor);
      const after = or(
        lt(documents.clientModifiedAt, new Date(at.sortKey)),
        and(eq(documents.clientModifiedAt, new Date(at.sortKey)), gt(documents.fingerprint, at.id)),
      );
      if (after) conds.push(after);
    }
    const rows = await db
      .select({
        row: documents,
        highlightCount: sql<number>`(SELECT count(*)::int FROM highlights h
          WHERE h.user_id = ${OUTER_USER} AND h.fingerprint = ${OUTER_FP}
            AND h.deleted_at IS NULL)`,
      })
      .from(documents)
      .where(and(...conds))
      .orderBy(desc(documents.clientModifiedAt), asc(documents.fingerprint))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1)?.row;
    return c.json({
      items: page.map((r) => documentView(r.row, Number(r.highlightCount))),
      nextCursor:
        rows.length > q.limit && last
          ? encodeCursor(last.clientModifiedAt.getTime(), last.fingerprint)
          : null,
    });
  });

  app.get('/v1/documents/:fp', auth, async (c) => {
    const uid = prelude(c);
    const fp = fpParam(c.req.param('fp'));
    const found = await db.transaction(
      async (tx) => {
        const [doc] = await tx
          .select()
          .from(documents)
          .where(
            and(
              eq(documents.userId, uid),
              eq(documents.fingerprint, fp),
              isNull(documents.deletedAt),
            ),
          );
        if (!doc) return undefined;
        const hs = await tx
          .select()
          .from(highlights)
          .where(
            and(
              eq(highlights.userId, uid),
              eq(highlights.fingerprint, fp),
              isNull(highlights.deletedAt),
            ),
          )
          .orderBy(asc(highlights.page), asc(highlights.startOffset), asc(highlights.id))
          .limit(200);
        return { doc, hs };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    if (!found) throw new ApiException('NOT_FOUND', 'Not found');
    const hl: HighlightView[] = found.hs.map((h) => ({ ...highlightData(h), id: h.id }));
    return c.json({ document: documentView(found.doc, hl.length), highlights: hl });
  });

  app.delete('/v1/documents/:fp', auth, async (c) => {
    const uid = prelude(c);
    const fp = fpParam(c.req.param('fp'));
    const nowMs = rt.now();
    let objectKey: string | null = null;
    const deleted = await db.transaction(async (tx) => {
      const current = await lockUserForSeq(tx, uid);
      if (current === null) throw new ApiException('UNAUTHENTICATED', 'Account no longer exists');
      const seq = createResettableSeq(current);
      const ctx = {
        tx,
        userId: uid,
        seq,
        nowMs,
        warn: (msg: string) => logger.warn({ route: 'documents/delete' }, msg),
      };
      const row = await getDocument(ctx, fp);
      if (!row || row.deletedAt) return false;
      objectKey = row.objectKey;
      await writeDocumentTombstone(
        ctx,
        fp,
        Math.max(nowMs, row.clientModifiedAt.getTime() + 1),
        row,
      );
      await commitSeq(tx, uid, seq);
      return true;
    });
    if (!deleted) throw new ApiException('NOT_FOUND', 'Not found');
    // §6.4: the file's deletion is already queued in the transaction; try it inline now.
    if (objectKey !== null) await deleteQueuedKeys(db, storage, logger, [objectKey]);
    return c.body(null, 204);
  });

  return app;
}

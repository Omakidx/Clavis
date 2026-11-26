// GET /v1/sync/pull core (docs/clavis-sync-design.md §4.6).
// All reads run in ONE repeatable-read snapshot: pushes commit under the user lock in seq order, so a snapshot that
// contains seq N contains every lower seq of that user, and the four per-table reads cannot straddle a commit.
import { and, asc, eq, gt } from 'drizzle-orm';
import type { PullResponse, ServerChange } from '../../../shared/api-contract';
import type { Database } from '../db/client';
import { documents, highlights, savedWords, users, wordChatMessages } from '../db/schema';
import { ApiException } from '../http/errors';
import { chatChange, documentChange, highlightChange, wordChange } from './records';

export async function pullChanges(
  db: Database,
  userId: string,
  cursor: bigint,
  limit: number,
): Promise<PullResponse> {
  return db.transaction(
    async (tx) => {
      const [user] = await tx
        .select({ floor: users.tombstoneFloorSeq })
        .from(users)
        .where(eq(users.id, userId));
      if (!user) throw new ApiException('UNAUTHENTICATED', 'Account no longer exists');
      if (cursor > 0n && cursor < user.floor) {
        throw new ApiException('CURSOR_EXPIRED', 'Cursor is older than retained history');
      }
      const take = limit + 1;
      // Sequential: one pg client must not run concurrent queries.
      const w = await tx
        .select()
        .from(savedWords)
        .where(and(eq(savedWords.userId, userId), gt(savedWords.seq, cursor)))
        .orderBy(asc(savedWords.seq))
        .limit(take);
      const c = await tx
        .select()
        .from(wordChatMessages)
        .where(and(eq(wordChatMessages.userId, userId), gt(wordChatMessages.seq, cursor)))
        .orderBy(asc(wordChatMessages.seq))
        .limit(take);
      const d = await tx
        .select()
        .from(documents)
        .where(and(eq(documents.userId, userId), gt(documents.seq, cursor)))
        .orderBy(asc(documents.seq))
        .limit(take);
      const h = await tx
        .select()
        .from(highlights)
        .where(and(eq(highlights.userId, userId), gt(highlights.seq, cursor)))
        .orderBy(asc(highlights.seq))
        .limit(take);
      const merged: { seq: bigint; change: ServerChange }[] = [
        ...w.map((r) => ({ seq: r.seq, change: wordChange(r) })),
        ...c.map((r) => ({ seq: r.seq, change: chatChange(r) })),
        ...d.map((r) => ({ seq: r.seq, change: documentChange(r) })),
        ...h.map((r) => ({ seq: r.seq, change: highlightChange(r) })),
      ].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
      const page = merged.slice(0, limit);
      return {
        changes: page.map((m) => m.change),
        nextCursor: (page.at(-1)?.seq ?? cursor).toString(),
        hasMore: merged.length > limit,
      };
    },
    { isolationLevel: 'repeatable read', accessMode: 'read only' },
  );
}

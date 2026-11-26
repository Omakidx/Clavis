// Saved-word REST (docs/clavis-sync-design.md §5.4): list, detail, delete. `B|C`; every query is scoped to the
// authenticated user, so another user's key is a plain 404.
import { and, asc, desc, eq, gt, ilike, isNull, lt, or, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import {
  Hex64,
  WordsQuery,
  type ChatView,
  type WordSummary,
  type WordView,
} from '../../../shared/api-contract';
import { requireBearerOrCookie } from '../auth/middleware';
import type { AuthRuntime } from '../auth/runtime';
import type { Database } from '../db/client';
import { commitSeq, lockUserForSeq } from '../db/queries';
import { savedWords, wordChatMessages } from '../db/schema';
import { ApiException, parseOrThrow } from '../http/errors';
import { decodeCursor, encodeCursor } from '../http/pagination';
import { enforce, perMinute } from '../http/rate-limit';
import type { AppEnv } from '../http/types';
import { createResettableSeq, getWord, writeWordTombstone } from '../sync/apply';
import { wordData, wordSource } from '../sync/records';

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => `\\${m}`);

export function wordRoutes(rt: AuthRuntime, db: Database): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const auth = requireBearerOrCookie(rt);
  const prelude = (c: { get(k: 'auth'): { userId: string } | undefined }): string => {
    const a = c.get('auth');
    if (!a) throw new ApiException('UNAUTHENTICATED', 'Sign in required');
    enforce(rt.limiter, `user:words:${a.userId}`, perMinute(120));
    return a.userId;
  };
  const keyParam = (raw: string | undefined): string => {
    const k = Hex64.safeParse(raw);
    if (!k.success) throw new ApiException('NOT_FOUND', 'Not found');
    return k.data;
  };

  app.get('/v1/words', auth, async (c) => {
    const uid = prelude(c);
    const q = parseOrThrow(WordsQuery, c.req.query());
    const conds = [eq(savedWords.userId, uid), isNull(savedWords.deletedAt)];
    const needle = q.q?.trim();
    if (needle) {
      const pat = `%${escapeLike(needle)}%`;
      const match = or(
        ilike(savedWords.text, pat),
        sql`${savedWords.meaning}->>'title' ILIKE ${pat}`,
        sql`${savedWords.meaning}->>'summary' ILIKE ${pat}`,
      );
      if (match) conds.push(match);
    }
    if (q.cursor) {
      const at = decodeCursor(q.cursor);
      const after = or(
        lt(savedWords.createdAt, new Date(at.sortKey)),
        and(eq(savedWords.createdAt, new Date(at.sortKey)), gt(savedWords.wordKey, at.id)),
      );
      if (after) conds.push(after);
    }
    const rows = await db
      .select({
        row: savedWords,
        messageCount: sql<number>`(SELECT count(*)::int FROM word_chat_messages m
          WHERE m.user_id = ${savedWords.userId} AND m.word_key = ${savedWords.wordKey})`,
      })
      .from(savedWords)
      .where(and(...conds))
      .orderBy(desc(savedWords.createdAt), asc(savedWords.wordKey))
      .limit(q.limit + 1);
    const page = rows.slice(0, q.limit);
    const last = page.at(-1)?.row;
    const items: WordSummary[] = page.map(({ row, messageCount }) => ({
      key: row.wordKey,
      text: row.text,
      title: (row.meaning as { title?: string }).title ?? '',
      summary: (row.meaning as { summary?: string }).summary ?? '',
      source: wordSource(row),
      createdAt: row.createdAt.getTime(),
      messageCount: Number(messageCount),
    }));
    return c.json({
      items,
      nextCursor:
        rows.length > q.limit && last ? encodeCursor(last.createdAt.getTime(), last.wordKey) : null,
    });
  });

  app.get('/v1/words/:key', auth, async (c) => {
    const uid = prelude(c);
    const key = keyParam(c.req.param('key'));
    const found = await db.transaction(
      async (tx) => {
        const [word] = await tx
          .select()
          .from(savedWords)
          .where(
            and(
              eq(savedWords.userId, uid),
              eq(savedWords.wordKey, key),
              isNull(savedWords.deletedAt),
            ),
          );
        if (!word) return undefined;
        const msgs = await tx
          .select()
          .from(wordChatMessages)
          .where(and(eq(wordChatMessages.userId, uid), eq(wordChatMessages.wordKey, key)))
          .orderBy(asc(wordChatMessages.createdAt), asc(wordChatMessages.id))
          .limit(200);
        return { word, msgs };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
    if (!found) throw new ApiException('NOT_FOUND', 'Not found');
    const word: WordView = {
      ...wordData(found.word),
      key,
      clientModifiedAt: found.word.clientModifiedAt.getTime(),
    };
    const messages: ChatView[] = found.msgs.map((m) => ({
      id: m.id,
      role: m.role as ChatView['role'],
      content: m.content,
      model: m.model,
      createdAt: m.createdAt.getTime(),
    }));
    return c.json({ word, messages });
  });

  app.delete('/v1/words/:key', auth, async (c) => {
    const uid = prelude(c);
    const key = keyParam(c.req.param('key'));
    const nowMs = rt.now();
    const deleted = await db.transaction(async (tx) => {
      const current = await lockUserForSeq(tx, uid);
      if (current === null) throw new ApiException('UNAUTHENTICATED', 'Account no longer exists');
      const seq = createResettableSeq(current);
      const ctx = { tx, userId: uid, seq, nowMs };
      const row = await getWord(ctx, key);
      if (!row || row.deletedAt) return false;
      // An explicit user delete always wins over what is stored, so it is newer than the stored record.
      await writeWordTombstone(ctx, key, Math.max(nowMs, row.clientModifiedAt.getTime() + 1), true);
      await commitSeq(tx, uid, seq);
      return true;
    });
    if (!deleted) throw new ApiException('NOT_FOUND', 'Not found');
    return c.body(null, 204);
  });

  return app;
}

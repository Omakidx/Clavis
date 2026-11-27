import { and, eq, gt, isNull, sql } from 'drizzle-orm';
import type { Database } from '../db/client';
import { refreshTokens, savedWords, documents, users, webSessions } from '../db/schema';
import { randomToken, sha256 } from './crypto';
import {
  REFRESH_ABSOLUTE_MS,
  REFRESH_SLIDING_MS,
  REUSE_GRACE_MS,
  hashRefreshToken,
  newRefreshToken,
} from './tokens';
import type { GoogleIdentity } from './google';

export type UserRow = typeof users.$inferSelect;

type FamilyExec = Pick<Database, 'execute'>;

/**
 * Serialise every operation on one refresh-token family (rotate, reuse-revoke, logout) with a transaction-level
 * advisory lock. Row locks alone are not enough: a revoke UPDATE cannot see a successor row that an in-flight
 * rotation inserts, which would leave an unrevoked row in a revoked family.
 */
export async function lockFamily(exec: FamilyExec, familyId: string): Promise<void> {
  await exec.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'clavis:rtfam:' + familyId}))`);
}

export const WEB_IDLE_MS = 7 * 24 * 3600 * 1000;
export const WEB_ABSOLUTE_MS = 30 * 24 * 3600 * 1000;
/** `last_seen_at` is only rewritten when older than this, to avoid a write per request. */
const LAST_SEEN_GRANULARITY_MS = 60_000;

export interface IssuedRefresh {
  token: string;
  expiresAt: Date;
  familyId: string;
}

export type RotateResult =
  | { kind: 'ok'; user: UserRow; refresh: IssuedRefresh }
  | { kind: 'invalid' }
  | { kind: 'expired' }
  | { kind: 'revoked'; familyId: string }
  | { kind: 'reuse_race'; familyId: string }
  /** Theft signal: the family was revoked in this call. */
  | { kind: 'reuse_revoked'; familyId: string };

export interface WebSessionView {
  id: string;
  user: UserRow;
  csrfToken: string;
  authenticatedAt: Date;
}

/** Postgres persistence for users, refresh-token families and web sessions. Every clock value is passed in. */
export class AuthStore {
  constructor(private readonly db: Database) {}

  async upsertGoogleUser(identity: GoogleIdentity, now: Date): Promise<UserRow> {
    const [row] = await this.db
      .insert(users)
      .values({
        googleSub: identity.sub,
        email: identity.email.slice(0, 320),
        displayName: identity.displayName,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: users.googleSub,
        set: {
          email: identity.email.slice(0, 320),
          displayName: identity.displayName,
          updatedAt: now,
        },
      })
      .returning();
    if (!row) throw new Error('user upsert returned no row');
    return row;
  }

  async getUser(id: string): Promise<UserRow | undefined> {
    const [row] = await this.db.select().from(users).where(eq(users.id, id));
    return row;
  }

  async userExists(id: string): Promise<boolean> {
    const [row] = await this.db.select({ id: users.id }).from(users).where(eq(users.id, id));
    return row !== undefined;
  }

  /** Every refresh-token family of a user (for cache eviction before the account is deleted). */
  async familyIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(eq(refreshTokens.userId, userId));
    return rows.map((r) => r.familyId);
  }

  /** Start a new refresh-token family (180 d absolute, 30 d sliding). */
  async createFamily(userId: string, now: Date): Promise<IssuedRefresh> {
    const familyId = crypto.randomUUID();
    const familyExpiresAt = new Date(now.getTime() + REFRESH_ABSOLUTE_MS);
    return this.insertToken(this.db, userId, familyId, now, familyExpiresAt);
  }

  private async insertToken(
    exec: Pick<Database, 'insert'>,
    userId: string,
    familyId: string,
    now: Date,
    familyExpiresAt: Date,
  ): Promise<IssuedRefresh> {
    const token = newRefreshToken();
    const expiresAt = new Date(
      Math.min(now.getTime() + REFRESH_SLIDING_MS, familyExpiresAt.getTime()),
    );
    await exec.insert(refreshTokens).values({
      userId,
      familyId,
      tokenHash: hashRefreshToken(token),
      createdAt: now,
      expiresAt,
      familyExpiresAt,
    });
    return { token, expiresAt, familyId };
  }

  /**
   * Rotate a refresh token (design §2.3). The presented row is locked FOR UPDATE, so concurrent presentations
   * of one token serialise: the first rotates, the second sees `used_at` and gets `reuse_race`.
   */
  async rotateRefresh(presented: string, now: Date): Promise<RotateResult> {
    const hash = hashRefreshToken(presented);
    return this.db.transaction(async (tx) => {
      const [probe] = await tx
        .select({ familyId: refreshTokens.familyId })
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hash));
      if (!probe) return { kind: 'invalid' } as const;
      await lockFamily(tx, probe.familyId);
      // Re-read under the family lock: the row may have been rotated or revoked while we waited.
      const [row] = await tx
        .select()
        .from(refreshTokens)
        .where(eq(refreshTokens.tokenHash, hash))
        .for('update');
      if (!row) return { kind: 'invalid' } as const;

      const [revoked] = await tx
        .select({ id: refreshTokens.id })
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.familyId, row.familyId),
            sql`${refreshTokens.revokedAt} IS NOT NULL`,
          ),
        )
        .limit(1);
      if (revoked) return { kind: 'revoked', familyId: row.familyId } as const;

      if (row.usedAt) {
        if (now.getTime() - row.usedAt.getTime() > REUSE_GRACE_MS) {
          await tx
            .update(refreshTokens)
            .set({ revokedAt: now, revokedReason: 'reuse' })
            .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
          return { kind: 'reuse_revoked', familyId: row.familyId } as const;
        }
        return { kind: 'reuse_race', familyId: row.familyId } as const;
      }

      if (row.expiresAt <= now || row.familyExpiresAt <= now) return { kind: 'expired' } as const;

      const [user] = await tx.select().from(users).where(eq(users.id, row.userId));
      if (!user) return { kind: 'invalid' } as const;

      await tx.update(refreshTokens).set({ usedAt: now }).where(eq(refreshTokens.id, row.id));
      const refresh = await this.insertToken(
        tx,
        row.userId,
        row.familyId,
        now,
        row.familyExpiresAt,
      );
      return { kind: 'ok', user, refresh } as const;
    });
  }

  /** Family id of a presented token (any state), for per-family rate limiting. */
  async findFamily(presented: string): Promise<string | undefined> {
    const [row] = await this.db
      .select({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(presented)));
    return row?.familyId;
  }

  /** Revoke the family that `presented` belongs to. Returns its id, or undefined for an unknown token. */
  async revokeFamilyByToken(presented: string, now: Date): Promise<string | undefined> {
    const [row] = await this.db
      .select({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashRefreshToken(presented)));
    if (!row) return undefined;
    await this.db.transaction(async (tx) => {
      await lockFamily(tx, row.familyId);
      await tx
        .update(refreshTokens)
        .set({ revokedAt: now, revokedReason: 'logout' })
        .where(and(eq(refreshTokens.familyId, row.familyId), isNull(refreshTokens.revokedAt)));
    });
    return row.familyId;
  }

  /** Revoke every family and web session of a user. Returns the affected family ids (for cache eviction). */
  async revokeAllForUser(userId: string, now: Date): Promise<string[]> {
    return this.db.transaction(async (tx) => {
      // Lock every family of the user in a fixed order (by lock key) so two logout-alls cannot deadlock, then
      // revoke in a fresh statement: it sees any successor a concurrent rotation committed while we waited.
      const keys = await tx.execute<{ k: number }>(
        sql`SELECT DISTINCT hashtext('clavis:rtfam:' || family_id::text) AS k
            FROM refresh_tokens WHERE user_id = ${userId} ORDER BY k`,
      );
      for (const { k } of keys.rows) await tx.execute(sql`SELECT pg_advisory_xact_lock(${k})`);
      const rows = await tx
        .update(refreshTokens)
        .set({ revokedAt: now, revokedReason: 'logout_all' })
        .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)))
        .returning({ familyId: refreshTokens.familyId });
      await tx
        .update(webSessions)
        .set({ revokedAt: now })
        .where(and(eq(webSessions.userId, userId), isNull(webSessions.revokedAt)));
      return [...new Set(rows.map((r) => r.familyId))];
    });
  }

  /** A family is active when it has rows and none is revoked (a deleted account has no rows). */
  async isFamilyActive(familyId: string): Promise<boolean> {
    const [r] = await this.db
      .select({
        n: sql<number>`count(*)::int`,
        revoked: sql<number>`count(${refreshTokens.revokedAt})::int`,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.familyId, familyId));
    return !!r && r.n > 0 && r.revoked === 0;
  }

  async createWebSession(
    userId: string,
    now: Date,
    /** Only a forced Google login (`?reauth=1`, bound to auth_time) passes a Date; ordinary logins store epoch 0. */
    authenticatedAt: Date = new Date(0),
  ): Promise<{ token: string; csrfToken: string; maxAgeS: number }> {
    const token = randomToken(32);
    const csrfToken = randomToken(32);
    await this.db.insert(webSessions).values({
      userId,
      sessionHash: sha256(token),
      csrfToken,
      createdAt: now,
      lastSeenAt: now,
      authenticatedAt,
      expiresAt: new Date(now.getTime() + WEB_ABSOLUTE_MS),
    });
    return { token, csrfToken, maxAgeS: WEB_ABSOLUTE_MS / 1000 };
  }

  /** Resolve a session cookie value: not revoked, within 30 d absolute and 7 d idle. Slides `last_seen_at`. */
  async getWebSession(token: string, now: Date): Promise<WebSessionView | undefined> {
    const [row] = await this.db
      .select({ s: webSessions, u: users })
      .from(webSessions)
      .innerJoin(users, eq(users.id, webSessions.userId))
      .where(
        and(
          eq(webSessions.sessionHash, sha256(token)),
          isNull(webSessions.revokedAt),
          gt(webSessions.expiresAt, now),
        ),
      );
    if (!row) return undefined;
    if (now.getTime() - row.s.lastSeenAt.getTime() > WEB_IDLE_MS) return undefined;
    if (now.getTime() - row.s.lastSeenAt.getTime() > LAST_SEEN_GRANULARITY_MS) {
      await this.db
        .update(webSessions)
        .set({ lastSeenAt: now })
        .where(eq(webSessions.id, row.s.id));
    }
    return {
      id: row.s.id,
      user: row.u,
      csrfToken: row.s.csrfToken,
      authenticatedAt: row.s.authenticatedAt,
    };
  }

  async revokeWebSessionByToken(token: string, now: Date): Promise<void> {
    await this.db
      .update(webSessions)
      .set({ revokedAt: now })
      .where(and(eq(webSessions.sessionHash, sha256(token)), isNull(webSessions.revokedAt)));
  }

  /** Live (non-tombstoned) counts for GET /v1/account. */
  async usageCounts(userId: string): Promise<{ words: number; documents: number }> {
    const [w] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(savedWords)
      .where(and(eq(savedWords.userId, userId), isNull(savedWords.deletedAt)));
    const [d] = await this.db
      .select({ n: sql<number>`count(*)::int` })
      .from(documents)
      .where(and(eq(documents.userId, userId), isNull(documents.deletedAt)));
    return { words: w?.n ?? 0, documents: d?.n ?? 0 };
  }
}

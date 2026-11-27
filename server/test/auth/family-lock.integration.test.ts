import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockFamily } from '../../src/auth/store';
import { hashRefreshToken, newRefreshToken } from '../../src/auth/tokens';
import { purgeRefreshTokens } from '../../src/db/queries';
import { refreshTokens } from '../../src/db/schema';
import { adminUrl, createTestDb, type TestDb } from '../db/helpers';
import { EXT_ORIGIN, bearer, createHarness, extSignIn, postJson, type Harness } from './harness';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!adminUrl)('refresh-token family serialisation (M1)', () => {
  let tdb: TestDb;
  let n = 0;
  const who = () => ({ sub: `fl-${++n}-${Math.random()}`, email: `fl${n}@example.test` });
  const mk = () => createHarness({ db: tdb.handle });
  const q = (sqlText: string, params: unknown[] = []) => tdb.handle.pool.query(sqlText, params);
  const refresh = (h: Harness, t: string): Promise<Response> =>
    postJson(h, '/v1/auth/extension/refresh', { refreshToken: t }, { origin: EXT_ORIGIN });

  beforeAll(async () => {
    tdb = await createTestDb(15);
  });
  afterAll(async () => {
    await tdb.drop();
  });

  /** Hold the family lock like an in-flight rotation, insert a successor, and release on demand. */
  async function startRotation(familyId: string, userId: string) {
    const successor = newRefreshToken();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockedP = new Promise<void>((r) => (locked = r));
    const tx = tdb.handle.db.transaction(async (t) => {
      await lockFamily(t, familyId);
      await t.insert(refreshTokens).values({
        userId,
        familyId,
        tokenHash: hashRefreshToken(successor),
        expiresAt: new Date(Date.now() + 86_400_000),
        familyExpiresAt: new Date(Date.now() + 86_400_000 * 100),
      });
      locked();
      await gate;
    });
    await lockedP;
    return { successor, release, done: tx };
  }

  const unrevoked = async (fam: string) =>
    (
      await q(
        'SELECT count(*)::int AS n FROM refresh_tokens WHERE family_id=$1 AND revoked_at IS NULL',
        [fam],
      )
    ).rows[0].n as number;

  async function ageRevocations(days: number) {
    await q(
      `UPDATE refresh_tokens SET revoked_at = revoked_at - make_interval(days => $1) WHERE revoked_at IS NOT NULL`,
      [days],
    );
  }

  it('logout during an in-flight rotation waits for it, then revokes the successor too; the purge 8 days later leaves nothing usable', async () => {
    const h = await mk();
    const p = await extSignIn(h, who());
    const fam = (await q('SELECT family_id FROM refresh_tokens WHERE user_id=$1', [p.user.id]))
      .rows[0].family_id as string;
    const rot = await startRotation(fam, p.user.id);

    let logoutDone = false;
    const logout = postJson(h, '/v1/auth/extension/logout', { refreshToken: p.refreshToken }).then(
      (r) => {
        logoutDone = true;
        return r;
      },
    );
    await sleep(200);
    expect(logoutDone, 'logout must wait for the family lock').toBe(false);

    rot.release();
    await rot.done;
    expect((await logout).status).toBe(204);
    expect(await unrevoked(fam), 'the successor committed mid-revoke must be revoked as well').toBe(
      0,
    );

    await ageRevocations(8);
    await purgeRefreshTokens(tdb.handle.db);
    expect(
      (await q('SELECT count(*)::int AS n FROM refresh_tokens WHERE family_id=$1', [fam])).rows[0]
        .n,
    ).toBe(0);
    const res = await refresh(h, rot.successor);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).not.toBe('TOKEN_REUSED');
  });

  it('logout-all during an in-flight rotation revokes the successor as well', async () => {
    const h = await mk();
    const p = await extSignIn(h, who());
    const fam = (await q('SELECT family_id FROM refresh_tokens WHERE user_id=$1', [p.user.id]))
      .rows[0].family_id as string;
    const rot = await startRotation(fam, p.user.id);
    let done = false;
    const all = Promise.resolve(
      h.app.request('/v1/account/logout-all', { method: 'POST', headers: bearer(p) }),
    ).then((r) => ((done = true), r));
    await sleep(200);
    expect(done).toBe(false);
    rot.release();
    await rot.done;
    expect((await all).status).toBe(204);
    expect(await unrevoked(fam)).toBe(0);
    await ageRevocations(8);
    await purgeRefreshTokens(tdb.handle.db);
    expect((await refresh(h, rot.successor)).status).toBe(401);
  });

  it('reuse-detection revoke waits for an in-flight rotation of the same family', async () => {
    const h = await mk();
    const p1 = await extSignIn(h, who());
    const p2 = (await (await refresh(h, p1.refreshToken)).json()) as { refreshToken: string };
    const fam = (
      await q('SELECT family_id FROM refresh_tokens WHERE user_id=$1 LIMIT 1', [p1.user.id])
    ).rows[0].family_id as string;
    const rot = await startRotation(fam, p1.user.id);
    h.clock.advance(61_000);
    let done = false;
    const stolen = refresh(h, p1.refreshToken).then((r) => ((done = true), r));
    await sleep(200);
    expect(done).toBe(false);
    rot.release();
    await rot.done;
    expect(((await (await stolen).json()) as { error: { code: string } }).error.code).toBe(
      'SESSION_REVOKED',
    );
    expect(await unrevoked(fam)).toBe(0);
    expect(p2.refreshToken).toBeTruthy();
  });

  it('under concurrent rotate/logout a family is never left half-revoked', async () => {
    const h = await mk();
    for (let i = 0; i < 15; i++) {
      const p = await extSignIn(h, who(), i + 1);
      h.clock.advance(7000);
      await Promise.all([
        refresh(h, p.refreshToken),
        postJson(h, '/v1/auth/extension/logout', { refreshToken: p.refreshToken }),
      ]);
      const r = await q(
        `SELECT count(*) FILTER (WHERE revoked_at IS NULL)::int AS live, count(revoked_at)::int AS dead
         FROM refresh_tokens WHERE user_id=$1`,
        [p.user.id],
      );
      const { live, dead } = r.rows[0] as { live: number; dead: number };
      expect(live === 0 || dead === 0, `iteration ${i}: live=${live} dead=${dead}`).toBe(true);
      expect(dead > 0 || live > 0).toBe(true);
    }
  });

  describe('purgeRefreshTokens deletes whole families only', () => {
    it('removes a dead family entirely, even if one row looks live; keeps live families', async () => {
      const h = await mk();
      const dead = await extSignIn(h, who(), 1);
      const live = await extSignIn(h, who(), 2);
      h.clock.advance(7000);
      await refresh(h, dead.refreshToken); // family now has 2 rows
      const fam = (
        await q('SELECT family_id FROM refresh_tokens WHERE user_id=$1 LIMIT 1', [dead.user.id])
      ).rows[0].family_id as string;
      // Legacy half-revoked shape: only the first row revoked (what the old race produced).
      await q(
        `UPDATE refresh_tokens SET revoked_at = now() - interval '8 days', revoked_reason='logout'
               WHERE id = (SELECT id FROM refresh_tokens WHERE family_id=$1 ORDER BY created_at LIMIT 1)`,
        [fam],
      );
      await purgeRefreshTokens(tdb.handle.db);
      expect(
        (await q('SELECT count(*)::int AS n FROM refresh_tokens WHERE family_id=$1', [fam])).rows[0]
          .n,
      ).toBe(0);
      expect(
        (await q('SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id=$1', [live.user.id]))
          .rows[0].n,
      ).toBe(1);
    });

    it('keeps a family whose revocation is recent, and purges one that expired long ago', async () => {
      const h = await mk();
      const recent = await extSignIn(h, who(), 1);
      const old = await extSignIn(h, who(), 2);
      await postJson(h, '/v1/auth/extension/logout', { refreshToken: recent.refreshToken });
      await q(`UPDATE refresh_tokens SET expires_at = now() - interval '8 days' WHERE user_id=$1`, [
        old.user.id,
      ]);
      await purgeRefreshTokens(tdb.handle.db);
      expect(
        (
          await q('SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id=$1', [
            recent.user.id,
          ])
        ).rows[0].n,
      ).toBe(1);
      expect(
        (await q('SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id=$1', [old.user.id]))
          .rows[0].n,
      ).toBe(0);
      expect(
        await tdb.handle.db
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.userId, old.user.id)),
      ).toHaveLength(0);
    });
  });
});
